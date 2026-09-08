import assert from 'node:assert/strict';
import test from 'node:test';
import { PDFDocument, PDFName } from 'pdf-lib';
import { extractPageCmykIccProfile } from './pdfCmykProfile.ts';

test('finds a four-channel ICC profile in page resources', async () => {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage();
  const expected = new Uint8Array([1, 2, 3, 4]);
  const profile = pdf.context.flateStream(expected, { N: 4 });
  const profileReference = pdf.context.register(profile);
  const colorSpace = pdf.context.obj([PDFName.of('ICCBased'), profileReference]);
  const resources = page.node.Resources();
  assert.ok(resources);
  resources.set(PDFName.of('ColorSpace'), pdf.context.obj({
    NamedAlternate: pdf.context.obj([PDFName.of('Pattern'), PDFName.of('DeviceCMYK')]),
    R6: colorSpace,
  }));

  assert.deepEqual(extractPageCmykIccProfile(pdf, page), expected);
});

test('ignores non-CMYK ICC profiles', async () => {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage();
  const profile = pdf.context.flateStream(new Uint8Array([1, 2, 3]), { N: 3 });
  const profileReference = pdf.context.register(profile);
  const resources = page.node.Resources();
  assert.ok(resources);
  resources.set(PDFName.of('ColorSpace'), pdf.context.obj({
    Rgb: pdf.context.obj([PDFName.of('ICCBased'), profileReference]),
  }));

  assert.equal(extractPageCmykIccProfile(pdf, page), null);
});
