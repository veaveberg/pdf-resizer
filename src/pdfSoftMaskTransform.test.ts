import assert from 'node:assert/strict';
import test from 'node:test';
import { PDFDocument, PDFName, decodePDFRawStream } from 'pdf-lib';
import { rebasePageSoftMasks } from './pdfSoftMaskTransform.ts';

async function fixture(pattern = false) {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage();
  const form = pdf.context.flateStream('0 0 100 200 re W n /Sh1 sh', {
    Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 100, 200],
    Matrix: [2, 1, 3, 4, 5, 6],
    Group: { S: 'Transparency', CS: 'DeviceCMYK' },
    Resources: pattern ? { Pattern: {} } : { Shading: {} },
  });
  const original = pdf.context.register(form);
  const mask = pdf.context.obj({ S: 'Luminosity', G: original });
  const state = pdf.context.obj({ SMask: mask });
  page.node.Resources()?.set(PDFName.of('ExtGState'), pdf.context.obj({ GS1: state, GS2: state }));
  return { pdf, page, form, mask, original };
}

test('rebases shading mask once with inverse matrix and unchanged color resources', async () => {
  const { pdf, page, form, mask } = await fixture();
  rebasePageSoftMasks(page, .5, .25);
  const result = pdf.context.lookup(mask.get(PDFName.of('G')));
  assert.equal(result.dict.get(PDFName.of('BBox')).toString(), '[ 0 0 50 50 ]');
  assert.equal(result.dict.get(PDFName.of('Matrix')).toString(), '[ 4 2 12 16 5 6 ]');
  assert.equal(result.dict.get(PDFName.of('Resources')), form.dict.get(PDFName.of('Resources')));
  assert.equal(result.dict.get(PDFName.of('Group')), form.dict.get(PDFName.of('Group')));
  assert.equal(new TextDecoder().decode(decodePDFRawStream(result).decode()), '0.5 0 0 0.25 0 0 cm\n0 0 100 200 re W n /Sh1 sh');
});

test('does not change pattern masks or an unscaled page', async () => {
  for (const pattern of [true, false]) {
    const { page, mask, original } = await fixture(pattern);
    rebasePageSoftMasks(page, pattern ? .5 : 1, pattern ? .5 : 1);
    assert.equal(mask.get(PDFName.of('G')), original);
  }
});

test('export copy does not mutate the imported mask', async () => {
  const { pdf, mask, original } = await fixture();
  const output = await PDFDocument.create();
  const [page] = await output.copyPages(pdf, [0]);
  rebasePageSoftMasks(page, .5, .5);
  assert.equal(mask.get(PDFName.of('G')), original);
  assert.throws(() => rebasePageSoftMasks(page, 0, 1), /Invalid PDF soft-mask scale/);
});
