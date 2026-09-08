import assert from 'node:assert/strict';
import test from 'node:test';
import { PDFDict, PDFDocument, PDFName, PDFRawStream } from 'pdf-lib';
import { drawDeviceCmykImage, rgbaToDeviceCmyk } from './pdfCmykImage.ts';

test('converts opaque RGB pixels to process CMYK', () => {
  const image = rgbaToDeviceCmyk(
    new Uint8ClampedArray([
      255, 0, 0, 255,
      0, 0, 0, 255,
      255, 255, 255, 255,
    ]),
    3,
    1,
  );

  assert.deepEqual(Array.from(image.bytes), [
    0, 255, 255, 0,
    0, 0, 0, 255,
    0, 0, 0, 0,
  ]);
});

test('embeds padding pixels as a DeviceCMYK image object', async () => {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([100, 100]);
  drawDeviceCmykImage(
    pdf,
    page,
    rgbaToDeviceCmyk(new Uint8ClampedArray([255, 0, 0, 255]), 1, 1),
    { x: 0, y: 0, width: 10, height: 100 },
  );

  const serializedPdf = await pdf.save();
  const reopenedPdf = await PDFDocument.load(serializedPdf);
  const reopenedPage = reopenedPdf.getPage(0);
  const xObjects = reopenedPage.node.Resources()?.lookup(PDFName.of('XObject'), PDFDict);
  const imageReference = xObjects?.values()[0];
  assert.ok(imageReference);
  const image = reopenedPdf.context.lookup(imageReference, PDFRawStream);
  assert.equal(image.dict.get(PDFName.of('ColorSpace')), PDFName.of('DeviceCMYK'));
  assert.equal(image.dict.get(PDFName.of('Subtype')), PDFName.of('Image'));
});
