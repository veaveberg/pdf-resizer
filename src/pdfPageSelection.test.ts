import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ghostscriptPageNumbers,
  outputPageIndex,
  type PdfPageOrder,
  uniquePageIndexes,
} from './pdfPageSelection.ts';

test('converts selected zero-based pages to a sorted Ghostscript page list', () => {
  const sourcePageIndexes = uniquePageIndexes([6, 2, 6]);
  assert.deepEqual(sourcePageIndexes, [2, 6]);
  assert.deepEqual(ghostscriptPageNumbers(sourcePageIndexes), [3, 7]);
});

test('maps source page indexes into selected-output order', () => {
  const order: PdfPageOrder = { kind: 'selection', sourcePageIndexes: [2, 6] };
  assert.equal(outputPageIndex(order, 2), 0);
  assert.equal(outputPageIndex(order, 6), 1);
  assert.throws(() => outputPageIndex(order, 4), /was not included/);
});
