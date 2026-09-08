import {
  cmyk,
  fill,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFOperator,
  PDFOperatorNames,
  popGraphicsState,
  pushGraphicsState,
  rectangle,
} from 'pdf-lib';
import type { Rect } from './paddingExtension';

type WritablePdfPage = ReturnType<Awaited<ReturnType<typeof PDFDocument.create>>['addPage']>;
type PdfName = ReturnType<typeof PDFName.of>;
const TOTAL_EDGE_SAMPLE_BUDGET = 10_000;
// The renderer needs only the outside rows and columns. Keeping the temporary
// page raster bounded prevents CMYK Ghostscript devices from exhausting the
// browser WebAssembly heap on large Illustrator pages.
const MAX_EDGE_RASTER_PIXELS = 1_000_000;

export interface CmykEdgeSamples {
  horizontalCount: number;
  verticalCount: number;
  top: Uint8Array;
  bottom: Uint8Array;
  left: Uint8Array;
  right: Uint8Array;
}

export interface CmykEdgeSampleRequest {
  rasterWidth: number;
  rasterHeight: number;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

type CmykColor = readonly [number, number, number, number];

export interface CmykColorRun {
  start: number;
  length: number;
  color: CmykColor;
}

export interface EdgeSampleAllocation {
  horizontalCount: number;
  verticalCount: number;
}

function byteArray(value: unknown, expectedLength: number): Uint8Array | null {
  if (!Array.isArray(value) || value.length !== expectedLength) return null;
  const bytes = new Uint8Array(expectedLength);
  for (let index = 0; index < value.length; index += 1) {
    const byte = value[index];
    if (!Number.isInteger(byte) || byte < 0 || byte > 255) return null;
    bytes[index] = byte;
  }
  return bytes;
}

export function parseCmykEdgeSamples(value: unknown): CmykEdgeSamples {
  if (!value || typeof value !== 'object') {
    throw new Error('The CMYK edge renderer returned no data.');
  }
  if (
    !('horizontalCount' in value) || !('verticalCount' in value)
    || !('top' in value) || !('bottom' in value)
    || !('left' in value) || !('right' in value)
  ) {
    throw new Error('The CMYK edge renderer returned incomplete data.');
  }
  const horizontalCount = value.horizontalCount;
  const verticalCount = value.verticalCount;
  if (
    !Number.isInteger(horizontalCount) || Number(horizontalCount) < 1
    || !Number.isInteger(verticalCount) || Number(verticalCount) < 1
  ) {
    throw new Error('The CMYK edge renderer returned invalid dimensions.');
  }
  const horizontalLength = Number(horizontalCount) * 4;
  const verticalLength = Number(verticalCount) * 4;
  const top = byteArray(value.top, horizontalLength);
  const bottom = byteArray(value.bottom, horizontalLength);
  const left = byteArray(value.left, verticalLength);
  const right = byteArray(value.right, verticalLength);
  if (!top || !bottom || !left || !right) {
    throw new Error('The CMYK edge renderer returned invalid pixel data.');
  }
  return {
    horizontalCount: Number(horizontalCount),
    verticalCount: Number(verticalCount),
    top,
    bottom,
    left,
    right,
  };
}

export function cmykEdgeSampleRequest(
  sourceWidth: number,
  sourceHeight: number,
  visibleSourceRect: Rect,
): CmykEdgeSampleRequest {
  const pairedBudget = TOTAL_EDGE_SAMPLE_BUDGET / 2;
  const sourcePerimeter = Math.max(1, sourceWidth + sourceHeight);
  const desiredWidth = Math.min(
    pairedBudget - 1,
    Math.max(1, Math.round(pairedBudget * sourceWidth / sourcePerimeter)),
  );
  const desiredHeight = pairedBudget - desiredWidth;
  const rasterScale = Math.min(1, Math.sqrt(MAX_EDGE_RASTER_PIXELS / (desiredWidth * desiredHeight)));
  const rasterWidth = Math.max(1, Math.floor(desiredWidth * rasterScale));
  const rasterHeight = Math.max(1, Math.floor(desiredHeight * rasterScale));
  const xScale = (rasterWidth - 1) / sourceWidth;
  const yScale = (rasterHeight - 1) / sourceHeight;
  const clampX = (value: number) => Math.max(0, Math.min(rasterWidth - 1, Math.round(value * xScale)));
  const clampY = (value: number) => Math.max(0, Math.min(rasterHeight - 1, Math.round(value * yScale)));

  return {
    rasterWidth,
    rasterHeight,
    left: clampX(visibleSourceRect.x),
    top: clampY(sourceHeight - visibleSourceRect.y - visibleSourceRect.height),
    right: clampX(visibleSourceRect.x + visibleSourceRect.width),
    bottom: clampY(sourceHeight - visibleSourceRect.y),
  };
}

function averageColor(bytes: Uint8Array, start: number, end: number): CmykColor {
  const totals = [0, 0, 0, 0];
  for (let index = start; index < end; index += 1) {
    const offset = index * 4;
    totals[0] += bytes[offset];
    totals[1] += bytes[offset + 1];
    totals[2] += bytes[offset + 2];
    totals[3] += bytes[offset + 3];
  }
  const count = Math.max(1, end - start);
  return [
    Math.round(totals[0] / count),
    Math.round(totals[1] / count),
    Math.round(totals[2] / count),
    Math.round(totals[3] / count),
  ];
}

function reducedColors(bytes: Uint8Array, count: number, targetCount: number): CmykColor[] {
  return Array.from({ length: targetCount }, (_, index) => {
    const start = Math.floor(index * count / targetCount);
    const end = Math.max(start + 1, Math.floor((index + 1) * count / targetCount));
    return averageColor(bytes, start, end);
  });
}

function sameColor(left: CmykColor, right: CmykColor): boolean {
  return left[0] === right[0]
    && left[1] === right[1]
    && left[2] === right[2]
    && left[3] === right[3];
}

export function cmykColorRuns(
  bytes: Uint8Array,
  count: number,
  targetCount = count,
): CmykColorRun[] {
  const colors = reducedColors(bytes, count, targetCount);
  const runs: CmykColorRun[] = [];
  for (let index = 0; index < colors.length; index += 1) {
    const color = colors[index];
    const previous = runs[runs.length - 1];
    if (previous && sameColor(previous.color, color)) {
      previous.length += 1;
    } else {
      runs.push({ start: index, length: 1, color });
    }
  }
  return runs;
}

export function edgeSampleAllocation(
  horizontalCount: number,
  verticalCount: number,
): EdgeSampleAllocation {
  const combinedCount = 2 * (horizontalCount + verticalCount);
  if (combinedCount <= TOTAL_EDGE_SAMPLE_BUDGET) {
    return { horizontalCount, verticalCount };
  }
  const pairedBudget = TOTAL_EDGE_SAMPLE_BUDGET / 2;
  const horizontalTarget = Math.max(
    1,
    Math.min(horizontalCount, Math.round(pairedBudget * horizontalCount / (horizontalCount + verticalCount))),
  );
  return {
    horizontalCount: horizontalTarget,
    verticalCount: pairedBudget - horizontalTarget,
  };
}

function pdfColor(color: CmykColor) {
  return cmyk(color[0] / 255, color[1] / 255, color[2] / 255, color[3] / 255);
}

function installIccColorSpace(
  pdf: Awaited<ReturnType<typeof PDFDocument.create>>,
  page: WritablePdfPage,
  profile: Uint8Array,
): PdfName {
  const profileStream = pdf.context.flateStream(profile, { N: 4, Alternate: 'DeviceCMYK' });
  const profileReference = pdf.context.register(profileStream);
  const resources = page.node.Resources();
  if (!resources) throw new Error('PDF page has no resource dictionary for CMYK padding.');
  let colorSpaces = resources.lookupMaybe(PDFName.of('ColorSpace'), PDFDict);
  if (!colorSpaces) {
    colorSpaces = pdf.context.obj({});
    resources.set(PDFName.of('ColorSpace'), colorSpaces);
  }
  const name = colorSpaces.uniqueKey('PaddingCMYK');
  const definition = pdf.context.obj([PDFName.of('ICCBased'), profileReference]);
  colorSpaces.set(name, definition);
  return name;
}

function drawProfiledRectangle(
  page: WritablePdfPage,
  colorSpace: PdfName,
  bounds: Rect,
  color: CmykColor,
): void {
  page.pushOperators(
    pushGraphicsState(),
    PDFOperator.of(PDFOperatorNames.NonStrokingColorspace, [colorSpace]),
    PDFOperator.of(PDFOperatorNames.NonStrokingColorN, color.map(value => PDFNumber.of(value / 255))),
    rectangle(bounds.x, bounds.y, bounds.width, bounds.height),
    fill(),
    popGraphicsState(),
  );
}

export function drawCmykVectorPadding(
  pdf: Awaited<ReturnType<typeof PDFDocument.create>>,
  page: WritablePdfPage,
  samples: CmykEdgeSamples,
  contentRect: Rect,
  pageWidth: number,
  pageHeight: number,
  iccProfile?: Uint8Array,
): void {
  const allocation = edgeSampleAllocation(samples.horizontalCount, samples.verticalCount);
  const top = cmykColorRuns(samples.top, allocation.horizontalCount);
  const bottom = cmykColorRuns(samples.bottom, allocation.horizontalCount);
  const left = cmykColorRuns(samples.left, allocation.verticalCount);
  const right = cmykColorRuns(samples.right, allocation.verticalCount);
  const horizontalSampleCount = allocation.horizontalCount;
  const verticalSampleCount = allocation.verticalCount;
  const horizontalStep = contentRect.width / horizontalSampleCount;
  const verticalStep = contentRect.height / verticalSampleCount;
  const overlap = 0.02;
  const colorSpace = iccProfile ? installIccColorSpace(pdf, page, iccProfile) : null;
  const paint = (bounds: Rect, color: CmykColor) => {
    if (colorSpace) drawProfiledRectangle(page, colorSpace, bounds, color);
    else page.drawRectangle({ ...bounds, color: pdfColor(color) });
  };

  for (const run of top) {
    const x = contentRect.x + run.start * horizontalStep;
    paint({
      x,
      y: contentRect.y + contentRect.height,
      width: run.length * horizontalStep + overlap,
      height: Math.max(0, pageHeight - contentRect.y - contentRect.height),
    }, run.color);
  }
  for (const run of bottom) {
    const x = contentRect.x + run.start * horizontalStep;
    paint({
      x,
      y: 0,
      width: run.length * horizontalStep + overlap,
      height: Math.max(0, contentRect.y),
    }, run.color);
  }
  for (const run of left) {
    const y = contentRect.y + contentRect.height - (run.start + run.length) * verticalStep;
    paint({
      x: 0,
      y,
      width: Math.max(0, contentRect.x),
      height: run.length * verticalStep + overlap,
    }, run.color);
  }
  for (const run of right) {
    const y = contentRect.y + contentRect.height - (run.start + run.length) * verticalStep;
    paint({
      x: contentRect.x + contentRect.width,
      y,
      width: Math.max(0, pageWidth - contentRect.x - contentRect.width),
      height: run.length * verticalStep + overlap,
    }, run.color);
  }

  const rightPadding = Math.max(0, pageWidth - contentRect.x - contentRect.width);
  const topPadding = Math.max(0, pageHeight - contentRect.y - contentRect.height);
  paint({ x: 0, y: contentRect.y + contentRect.height, width: contentRect.x, height: topPadding }, top[0].color);
  paint({ x: contentRect.x + contentRect.width, y: contentRect.y + contentRect.height, width: rightPadding, height: topPadding }, top[top.length - 1].color);
  paint({ x: 0, y: 0, width: contentRect.x, height: contentRect.y }, bottom[0].color);
  paint({ x: contentRect.x + contentRect.width, y: 0, width: rightPadding, height: contentRect.y }, bottom[bottom.length - 1].color);
}
