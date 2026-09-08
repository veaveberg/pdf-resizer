export type PdfPageOrder =
  | { readonly kind: 'source' }
  | { readonly kind: 'selection'; readonly sourcePageIndexes: readonly number[] };

export function uniquePageIndexes(pageIndexes: readonly number[]): number[] {
  return [...new Set(pageIndexes)].sort((left, right) => left - right);
}

export function ghostscriptPageNumbers(sourcePageIndexes: readonly number[]): number[] {
  return sourcePageIndexes.map(pageIndex => pageIndex + 1);
}

export function outputPageIndex(order: PdfPageOrder, sourcePageIndex: number): number {
  if (order.kind === 'source') return sourcePageIndex;
  const selectedIndex = order.sourcePageIndexes.indexOf(sourcePageIndex);
  if (selectedIndex < 0) {
    throw new Error(`Source page ${sourcePageIndex + 1} was not included in PDF preprocessing.`);
  }
  return selectedIndex;
}
