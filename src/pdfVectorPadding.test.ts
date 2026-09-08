import assert from 'node:assert/strict';
import test from 'node:test';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import {
  cmykColorRuns,
  cmykEdgeSampleRequest,
  drawCmykVectorPadding,
  edgeSampleAllocation,
  parseCmykEdgeSamples,
} from './pdfVectorPadding.ts';

test('combines only consecutive samples with exactly equal CMYK fills', () => {
  const runs = cmykColorRuns(
    new Uint8Array([
      0, 255, 255, 0,
      0, 255, 255, 0,
      255, 0, 0, 0,
      255, 0, 0, 0,
      0, 255, 255, 0,
    ]),
    5,
  );

  assert.deepEqual(runs.map(run => ({ start: run.start, length: run.length })), [
    { start: 0, length: 2 },
    { start: 2, length: 2 },
    { start: 4, length: 1 },
  ]);
});

test('allows up to the requested number of edge samples before combining fills', () => {
  const sampleCount = 4000;
  const bytes = new Uint8Array(sampleCount * 4);
  const runs = cmykColorRuns(bytes, sampleCount, 3000);
  assert.equal(runs.reduce((sum, run) => sum + run.length, 0), 3000);
});

test('allocates the 10000-colour ceiling across all edges by length', () => {
  const allocation = edgeSampleAllocation(4000, 1000);
  assert.deepEqual(allocation, { horizontalCount: 4000, verticalCount: 1000 });
  assert.equal(2 * (allocation.horizontalCount + allocation.verticalCount), 10000);

  const wideAllocation = edgeSampleAllocation(9000, 1000);
  assert.deepEqual(wideAllocation, { horizontalCount: 4500, verticalCount: 500 });
  assert.equal(2 * (wideAllocation.horizontalCount + wideAllocation.verticalCount), 10000);
});

test('maps a visible PDF rectangle into top-down render coordinates', () => {
  const request = cmykEdgeSampleRequest(200, 100, { x: 50, y: 25, width: 100, height: 50 });
  assert.ok(request.rasterWidth * request.rasterHeight <= 1_000_000);
  assert.ok(request.rasterWidth >= 1);
  assert.ok(request.rasterHeight >= 1);
  assert.equal(request.left, Math.round(50 * (request.rasterWidth - 1) / 200));
  assert.equal(request.right, Math.round(150 * (request.rasterWidth - 1) / 200));
  assert.equal(request.top, Math.round(25 * (request.rasterHeight - 1) / 100));
  assert.equal(request.bottom, Math.round(75 * (request.rasterHeight - 1) / 100));
});

test('rejects malformed CMYK edge renderer data', () => {
  assert.throws(() => parseCmykEdgeSamples({ horizontalCount: 1, verticalCount: 1 }));
});

test('draws bounded vector rectangles without image objects', async () => {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([120, 120]);
  const samples = parseCmykEdgeSamples({
    horizontalCount: 2,
    verticalCount: 2,
    top: [0, 255, 255, 0, 255, 0, 0, 0],
    bottom: [0, 255, 255, 0, 255, 0, 0, 0],
    left: [0, 255, 255, 0, 255, 0, 0, 0],
    right: [0, 255, 255, 0, 255, 0, 0, 0],
  });
  drawCmykVectorPadding(pdf, page, samples, { x: 10, y: 10, width: 100, height: 100 }, 120, 120);

  const bytes = await pdf.save({ useObjectStreams: false });
  const reopened = await PDFDocument.load(bytes);
  const reopenedPage = reopened.getPage(0);
  const xObjects = reopenedPage.node.Resources()?.lookupMaybe(PDFName.of('XObject'), PDFDict);
  assert.equal(xObjects?.keys().length ?? 0, 0);
  const contents = reopenedPage.node.Contents();
  const streams = contents instanceof PDFRawStream
    ? [contents]
    : contents instanceof PDFArray
      ? Array.from({ length: contents.size() }, (_, index) => contents.lookup(index, PDFRawStream))
      : [];
  assert.ok(streams.length > 0);
  const decoded = streams
    .map(stream => new TextDecoder('latin1').decode(decodePDFRawStream(stream).decode()))
    .join('\n');
  assert.match(decoded, /\bk\b/);
  assert.doesNotMatch(decoded, /\bDo\b/);
});

test('draws padding in an embedded CMYK ICC color space', async () => {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([120, 120]);
  const samples = parseCmykEdgeSamples({
    horizontalCount: 1,
    verticalCount: 1,
    top: [255, 128, 0, 0],
    bottom: [255, 128, 0, 0],
    left: [255, 128, 0, 0],
    right: [255, 128, 0, 0],
  });
  const profile = new Uint8Array([1, 2, 3, 4]);
  drawCmykVectorPadding(
    pdf,
    page,
    samples,
    { x: 10, y: 10, width: 100, height: 100 },
    120,
    120,
    profile,
  );

  const bytes = await pdf.save({ useObjectStreams: false });
  const reopened = await PDFDocument.load(bytes);
  const reopenedPage = reopened.getPage(0);
  const colorSpaces = reopenedPage.node.Resources()?.lookupMaybe(PDFName.of('ColorSpace'), PDFDict);
  assert.equal(colorSpaces?.keys().length, 1);
  const colorSpace = colorSpaces?.values()[0];
  assert.ok(colorSpace instanceof PDFArray);
  assert.equal(colorSpace.lookup(0, PDFName), PDFName.of('ICCBased'));

  const contents = reopenedPage.node.Contents();
  const streams = contents instanceof PDFRawStream
    ? [contents]
    : contents instanceof PDFArray
      ? Array.from({ length: contents.size() }, (_, index) => contents.lookup(index, PDFRawStream))
      : [];
  const decoded = streams
    .map(stream => new TextDecoder('latin1').decode(decodePDFRawStream(stream).decode()))
    .join('\n');
  assert.match(decoded, /\bcs\b/);
  assert.match(decoded, /\bscn\b/);
  assert.doesNotMatch(decoded, /\bk\b/);
});
