/// <reference lib="webworker" />

import createGhostscript from '@okathira/ghostpdl-wasm';
import ghostscriptWasmUrl from '@okathira/ghostpdl-wasm/gs.wasm?url';
import type {
  CmykEdgeSampleRequest,
  CmykEdgeSamples,
} from './pdfVectorPadding';

interface GhostscriptFileSystem {
  writeFile(path: string, data: Uint8Array): void;
  readFile(path: string): Uint8Array;
  unlink(path: string): void;
}

interface GhostscriptModule {
  readonly FS: GhostscriptFileSystem;
  callMain(args: string[]): number;
}

interface OutlineRequest {
  readonly kind: 'outline';
  readonly pdf: ArrayBuffer;
  readonly pageNumbers: readonly number[];
}

interface RasterizeRequest {
  readonly kind: 'rasterize';
  readonly pdf: ArrayBuffer;
  readonly dpi: number;
}

interface EdgeRequest {
  readonly kind: 'edges';
  readonly pdf: ArrayBuffer;
  readonly pageNumber: number;
  readonly request: CmykEdgeSampleRequest;
  readonly outputIccProfile?: ArrayBuffer;
}

type WorkerRequestPayload = OutlineRequest | RasterizeRequest | EdgeRequest;

interface WorkerRequest {
  readonly id: number;
  readonly payload: WorkerRequestPayload;
}

interface WorkerSuccess {
  readonly id: number;
  readonly ok: true;
  readonly result: ArrayBuffer | CmykEdgeSamples;
}

interface WorkerFailure {
  readonly id: number;
  readonly ok: false;
  readonly message: string;
}

type WorkerResponse = WorkerSuccess | WorkerFailure;

let jobSequence = 0;
let requestQueue: Promise<void> = Promise.resolve();

function ghostscript(): Promise<GhostscriptModule> {
  // The package's default `new URL('gs.wasm', import.meta.url)` points at Vite's
  // optimized dependency URL in development. Importing the binary explicitly
  // lets Vite emit and serve the real WebAssembly asset in every environment.
  return createGhostscript({
    locateFile: fileName => fileName === 'gs.wasm' ? ghostscriptWasmUrl : fileName,
  });
}

function safeUnlink(fs: GhostscriptFileSystem, path: string): void {
  try {
    fs.unlink(path);
  } catch {
    // The command can fail before creating its output file.
  }
}

function transferableCopy(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function read16(bytes: Uint8Array, offset: number, littleEndian: boolean): number {
  if (offset < 0 || offset + 2 > bytes.length) throw new Error('CMYK TIFF is truncated.');
  return littleEndian
    ? bytes[offset] | (bytes[offset + 1] << 8)
    : (bytes[offset] << 8) | bytes[offset + 1];
}

function read32(bytes: Uint8Array, offset: number, littleEndian: boolean): number {
  if (offset < 0 || offset + 4 > bytes.length) throw new Error('CMYK TIFF is truncated.');
  const value = littleEndian
    ? (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24))
    : ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]);
  return value >>> 0;
}

function tiffTypeSize(type: number): number {
  switch (type) {
    case 1: return 1;
    case 3: return 2;
    case 4: return 4;
    default: throw new Error(`CMYK TIFF contains unsupported field type ${type}.`);
  }
}

function readTiffValues(
  bytes: Uint8Array,
  type: number,
  count: number,
  valueOffset: number,
  littleEndian: boolean,
): number[] {
  const byteLength = tiffTypeSize(type) * count;
  const start = byteLength <= 4 ? valueOffset : read32(bytes, valueOffset, littleEndian);
  if (start + byteLength > bytes.length) throw new Error('CMYK TIFF field points outside the file.');
  return Array.from({ length: count }, (_, index) => {
    const offset = start + index * tiffTypeSize(type);
    switch (type) {
      case 1: return bytes[offset];
      case 3: return read16(bytes, offset, littleEndian);
      case 4: return read32(bytes, offset, littleEndian);
      default: throw new Error('CMYK TIFF contains an unsupported field type.');
    }
  });
}

interface TiffFields {
  readonly width: number;
  readonly height: number;
  readonly bitsPerSample: number[];
  readonly compression: number;
  readonly samplesPerPixel: number;
  readonly planarConfiguration: number;
  readonly stripOffsets: number[];
  readonly stripByteCounts: number[];
}

function parseTiffFields(bytes: Uint8Array): TiffFields {
  const byteOrder = String.fromCharCode(bytes[0] ?? 0, bytes[1] ?? 0);
  const littleEndian = byteOrder === 'II';
  if (!littleEndian && byteOrder !== 'MM') throw new Error('Ghostscript returned an invalid CMYK TIFF header.');
  if (read16(bytes, 2, littleEndian) !== 42) throw new Error('Ghostscript returned an unsupported CMYK TIFF header.');
  const directoryOffset = read32(bytes, 4, littleEndian);
  const entryCount = read16(bytes, directoryOffset, littleEndian);
  const fields = new Map<number, number[]>();
  const requiredTags = new Set([256, 257, 258, 259, 273, 277, 279, 284]);
  for (let index = 0; index < entryCount; index += 1) {
    const entryOffset = directoryOffset + 2 + index * 12;
    const tag = read16(bytes, entryOffset, littleEndian);
    if (!requiredTags.has(tag)) continue;
    const type = read16(bytes, entryOffset + 2, littleEndian);
    const count = read32(bytes, entryOffset + 4, littleEndian);
    fields.set(tag, readTiffValues(bytes, type, count, entryOffset + 8, littleEndian));
  }
  const field = (tag: number, name: string): number[] => {
    const value = fields.get(tag);
    if (!value || value.length === 0) throw new Error(`CMYK TIFF is missing ${name}.`);
    return value;
  };
  return {
    width: field(256, 'image width')[0],
    height: field(257, 'image height')[0],
    bitsPerSample: field(258, 'bits per sample'),
    compression: field(259, 'compression')[0],
    samplesPerPixel: field(277, 'samples per pixel')[0],
    planarConfiguration: field(284, 'planar configuration')[0],
    stripOffsets: field(273, 'strip offsets'),
    stripByteCounts: field(279, 'strip byte counts'),
  };
}

function parseCmykTiff(bytes: Uint8Array): { readonly width: number; readonly height: number; readonly pixels: Uint8Array } {
  const fields = parseTiffFields(bytes);
  if (fields.bitsPerSample.length !== 4 || !fields.bitsPerSample.every(value => value === 8)) {
    throw new Error('Ghostscript returned CMYK TIFF pixels with an unsupported bit depth.');
  }
  if (fields.compression !== 1 || fields.samplesPerPixel !== 4 || fields.planarConfiguration !== 1) {
    throw new Error('Ghostscript returned an unsupported CMYK TIFF layout.');
  }
  if (fields.stripOffsets.length !== fields.stripByteCounts.length) {
    throw new Error('CMYK TIFF has mismatched strip metadata.');
  }
  const expectedLength = fields.width * fields.height * 4;
  const pixels = new Uint8Array(expectedLength);
  let destinationOffset = 0;
  for (let index = 0; index < fields.stripOffsets.length; index += 1) {
    const sourceOffset = fields.stripOffsets[index];
    const byteCount = fields.stripByteCounts[index];
    if (sourceOffset + byteCount > bytes.length || destinationOffset + byteCount > pixels.length) {
      throw new Error('CMYK TIFF pixel data is invalid.');
    }
    pixels.set(bytes.subarray(sourceOffset, sourceOffset + byteCount), destinationOffset);
    destinationOffset += byteCount;
  }
  if (destinationOffset !== expectedLength) throw new Error('CMYK TIFF pixel data has an unexpected length.');
  return { width: fields.width, height: fields.height, pixels };
}

function sampleCmykEdges(
  pixels: Uint8Array,
  width: number,
  height: number,
  request: CmykEdgeSampleRequest,
): CmykEdgeSamples {
  const { left, top, right, bottom } = request;
  if (left > right || top > bottom || right >= width || bottom >= height) {
    throw new Error('CMYK edge sample coordinates are outside the rendered page.');
  }
  const pixel = (x: number, y: number): Uint8Array => {
    const offset = (y * width + x) * 4;
    return pixels.subarray(offset, offset + 4);
  };
  const horizontalCount = right - left + 1;
  const verticalCount = bottom - top + 1;
  const topSamples = new Uint8Array(horizontalCount * 4);
  const bottomSamples = new Uint8Array(horizontalCount * 4);
  const leftSamples = new Uint8Array(verticalCount * 4);
  const rightSamples = new Uint8Array(verticalCount * 4);
  for (let x = left; x <= right; x += 1) {
    const offset = (x - left) * 4;
    topSamples.set(pixel(x, top), offset);
    bottomSamples.set(pixel(x, bottom), offset);
  }
  for (let y = top; y <= bottom; y += 1) {
    const offset = (y - top) * 4;
    leftSamples.set(pixel(left, y), offset);
    rightSamples.set(pixel(right, y), offset);
  }
  return {
    horizontalCount,
    verticalCount,
    top: topSamples,
    bottom: bottomSamples,
    left: leftSamples,
    right: rightSamples,
  };
}

function outputPath(id: number, extension: string): string {
  return `/pdfresizer-${id}.${extension}`;
}

function readOutput(
  module: GhostscriptModule,
  output: string,
  operation: string,
  args: string[],
): Uint8Array {
  const exitCode = module.callMain(args);
  if (exitCode !== 0) {
    throw new Error(`Ghostscript could not ${operation} (exit code ${exitCode}).`);
  }
  try {
    return module.FS.readFile(output);
  } catch {
    throw new Error(`Ghostscript did not produce the ${operation} output.`);
  }
}

async function processRequestOnce(payload: WorkerRequestPayload): Promise<ArrayBuffer | CmykEdgeSamples> {
  const module = await ghostscript();
  jobSequence += 1;
  const input = outputPath(jobSequence, 'input.pdf');
  const output = outputPath(jobSequence, payload.kind === 'edges' ? 'tiff' : 'output.pdf');
  const outputIccProfile = payload.kind === 'edges' && payload.outputIccProfile
    ? outputPath(jobSequence, 'icc')
    : null;
  module.FS.writeFile(input, new Uint8Array(payload.pdf));
  if (outputIccProfile && payload.kind === 'edges' && payload.outputIccProfile) {
    module.FS.writeFile(outputIccProfile, new Uint8Array(payload.outputIccProfile));
  }
  try {
    switch (payload.kind) {
      case 'outline':
        if (payload.pageNumbers.length === 0 || payload.pageNumbers.some(page => !Number.isInteger(page) || page < 1)) {
          throw new Error('Outline text requires at least one valid page number.');
        }
        return transferableCopy(readOutput(module, output, 'outlined PDF', [
          '-dBATCH', '-dNOPAUSE', '-dSAFER', '-dQUIET', '-sDEVICE=pdfwrite',
          '-dNoOutputFonts', '-dCompatibilityLevel=1.7',
          '-dColorConversionStrategy=/LeaveColorUnchanged',
          '-dPreserveSeparation=true', '-dAutoRotatePages=/None',
          `-sPageList=${payload.pageNumbers.join(',')}`, `-sOutputFile=${output}`, input,
        ]));
      case 'rasterize': {
        const dpi = Math.min(1200, Math.max(72, Math.round(payload.dpi)));
        return transferableCopy(readOutput(module, output, 'rasterized PDF', [
          '-dBATCH', '-dNOPAUSE', '-dSAFER', '-dQUIET', '-sDEVICE=pdfimage32',
          `-r${dpi}`, '-dTextAlphaBits=4', '-dGraphicsAlphaBits=4', '-sCompression=Flate',
          `-sOutputFile=${output}`, input,
        ]));
      }
      case 'edges': {
        const { request } = payload;
        const colorOptions = outputIccProfile
          ? [`-sOutputICCProfile=${outputIccProfile}`]
          : ['-dUseFastColor=true'];
        const tiffBytes = readOutput(module, output, 'CMYK edge sample', [
          // tiffsep retains the source PDF's process-CMYK data and composites
          // spot colours, rather than forcing every Illustrator colour through
          // Ghostscript's default CMYK conversion.
          '-dBATCH', '-dNOPAUSE', '-dSAFER', '-dQUIET', '-sDEVICE=tiffsep',
          '-dNoSeparationFiles', ...colorOptions, '-sCompression=none',
          '-dFIXEDMEDIA', '-dPDFFitPage', '-r72',
          `-dFirstPage=${payload.pageNumber}`,
          `-dLastPage=${payload.pageNumber}`, `-g${request.rasterWidth}x${request.rasterHeight}`,
          `-sOutputFile=${output}`, input,
        ]);
        const tiff = parseCmykTiff(tiffBytes);
        return sampleCmykEdges(tiff.pixels, tiff.width, tiff.height, request);
      }
      default: {
        const exhaustive: never = payload;
        throw new Error(`Unsupported Ghostscript request: ${String(exhaustive)}.`);
      }
    }
  } finally {
    safeUnlink(module.FS, input);
    safeUnlink(module.FS, output);
    if (outputIccProfile) safeUnlink(module.FS, outputIccProfile);
  }
}

async function processRequest(payload: WorkerRequestPayload): Promise<ArrayBuffer | CmykEdgeSamples> {
  // Ghostscript's command-line entry point carries process-global state. A
  // fresh module per job prevents an outline pass from contaminating a later
  // CMYK edge pass. The browser cache still avoids another WASM download.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await processRequestOnce(payload);
    } catch (error) {
      if (attempt === 1) throw error;
    }
  }
  throw new Error('Ghostscript processing failed.');
}

function enqueueRequest(payload: WorkerRequestPayload): Promise<ArrayBuffer | CmykEdgeSamples> {
  const result = requestQueue.then(() => processRequest(payload));
  // Keep the queue alive after failures so a subsequent export can recover.
  requestQueue = result.then(() => undefined, () => undefined);
  return result;
}

globalThis.addEventListener('message', (event: MessageEvent<WorkerRequest>) => {
  const request = event.data as WorkerRequest;
  void enqueueRequest(request.payload)
    .then(result => {
      const response: WorkerSuccess = { id: request.id, ok: true, result };
      const transfer = result instanceof ArrayBuffer ? [result] : [
        result.top.buffer,
        result.bottom.buffer,
        result.left.buffer,
        result.right.buffer,
      ];
      globalThis.postMessage(response, transfer);
    })
    .catch(error => {
      const message = error instanceof Error ? error.message : 'Ghostscript processing failed.';
      const response: WorkerFailure = { id: request.id, ok: false, message };
      globalThis.postMessage(response);
    });
});
