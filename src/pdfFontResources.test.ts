import assert from 'node:assert/strict';
import test from 'node:test';
import { PDFDocument, PDFName } from 'pdf-lib';
import { pageHasFontResources } from './pdfFontResources.ts';

test('reports pages without fonts as already outlined', async () => {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage();
  assert.equal(pageHasFontResources(page), false);
});

test('finds font resources nested inside a form', async () => {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage();
  const nestedResources = pdf.context.obj({
    Font: pdf.context.obj({ F1: pdf.context.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica' }) }),
  });
  const form = pdf.context.flateStream(new Uint8Array(), {
    Type: 'XObject',
    Subtype: 'Form',
    BBox: [0, 0, 10, 10],
    Resources: nestedResources,
  });
  const formReference = pdf.context.register(form);
  page.node.Resources()?.set(PDFName.of('XObject'), pdf.context.obj({ Form1: formReference }));

  assert.equal(pageHasFontResources(page), true);
});
