import { PDFDict, PDFDocument, PDFName, PDFRawStream } from 'pdf-lib';

type LoadedPdfDocument = Awaited<ReturnType<typeof PDFDocument.load>>;
type LoadedPdfPage = ReturnType<LoadedPdfDocument['getPage']>;
type PdfDictionary = InstanceType<typeof PDFDict>;

function resourcesContainFonts(resources: PdfDictionary, visited: Set<PdfDictionary>): boolean {
  if (visited.has(resources)) return false;
  visited.add(resources);

  const fontsObject = resources.get(PDFName.of('Font'));
  const fonts = fontsObject ? resources.context.lookup(fontsObject) : undefined;
  if (fonts instanceof PDFDict && fonts.keys().length > 0) return true;

  const xObjectsObject = resources.get(PDFName.of('XObject'));
  const xObjects = xObjectsObject ? resources.context.lookup(xObjectsObject) : undefined;
  if (!(xObjects instanceof PDFDict)) return false;
  for (const value of xObjects.values()) {
    const stream = resources.context.lookup(value);
    if (!(stream instanceof PDFRawStream)) continue;
    const nestedResourcesObject = stream.dict.get(PDFName.of('Resources'));
    const nestedResources = nestedResourcesObject
      ? resources.context.lookup(nestedResourcesObject)
      : undefined;
    if (nestedResources instanceof PDFDict && resourcesContainFonts(nestedResources, visited)) {
      return true;
    }
  }
  return false;
}

export function pageHasFontResources(page: LoadedPdfPage): boolean {
  const resources = page.node.Resources();
  return resources ? resourcesContainFonts(resources, new Set()) : false;
}
