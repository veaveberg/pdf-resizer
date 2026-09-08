import {
  decodePDFRawStream,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRawStream,
} from 'pdf-lib';

type LoadedPdfDocument = Awaited<ReturnType<typeof PDFDocument.load>>;
type LoadedPdfPage = ReturnType<LoadedPdfDocument['getPage']>;
type PdfDictionary = InstanceType<typeof PDFDict>;
type PdfRawStream = InstanceType<typeof PDFRawStream>;

function decodedCmykProfile(stream: PdfRawStream): Uint8Array | null {
  const componentCount = stream.dict.lookupMaybe(PDFName.of('N'), PDFNumber)?.asNumber();
  if (componentCount !== 4) return null;
  return new Uint8Array(decodePDFRawStream(stream).decode());
}

function profileFromColorSpaces(resources: PdfDictionary): Uint8Array | null {
  const colorSpacesObject = resources.get(PDFName.of('ColorSpace'));
  const colorSpaces = colorSpacesObject
    ? resources.context.lookup(colorSpacesObject)
    : undefined;
  if (!(colorSpaces instanceof PDFDict)) return null;
  for (const value of colorSpaces.values()) {
    const colorSpace = resources.context.lookup(value);
    if (!(colorSpace instanceof PDFArray) || colorSpace.size() < 2) continue;
    const family = colorSpace.lookupMaybe(0, PDFName);
    if (family !== PDFName.of('ICCBased')) continue;
    const profileObject = colorSpace.get(1);
    const profile = profileObject
      ? resources.context.lookup(profileObject)
      : undefined;
    if (!(profile instanceof PDFRawStream)) continue;
    const decoded = decodedCmykProfile(profile);
    if (decoded) return decoded;
  }
  return null;
}

function profileFromResources(resources: PdfDictionary, visited: Set<PdfDictionary>): Uint8Array | null {
  if (visited.has(resources)) return null;
  visited.add(resources);

  const direct = profileFromColorSpaces(resources);
  if (direct) return direct;

  const xObjectsObject = resources.get(PDFName.of('XObject'));
  const xObjects = xObjectsObject
    ? resources.context.lookup(xObjectsObject)
    : undefined;
  if (!(xObjects instanceof PDFDict)) return null;
  for (const value of xObjects.values()) {
    const stream = resources.context.lookup(value);
    if (!(stream instanceof PDFRawStream)) continue;
    const nestedResourcesObject = stream.dict.get(PDFName.of('Resources'));
    const nestedResources = nestedResourcesObject
      ? resources.context.lookup(nestedResourcesObject)
      : undefined;
    if (!(nestedResources instanceof PDFDict)) continue;
    const nested = profileFromResources(nestedResources, visited);
    if (nested) return nested;
  }
  return null;
}

function profileFromOutputIntent(pdf: LoadedPdfDocument): Uint8Array | null {
  const intentsObject = pdf.catalog.get(PDFName.of('OutputIntents'));
  const intents = intentsObject ? pdf.context.lookup(intentsObject) : undefined;
  if (!(intents instanceof PDFArray)) return null;
  for (let index = 0; index < intents.size(); index += 1) {
    const intent = pdf.context.lookup(intents.get(index));
    if (!(intent instanceof PDFDict)) continue;
    const profileObject = intent.get(PDFName.of('DestOutputProfile'));
    const profile = profileObject ? pdf.context.lookup(profileObject) : undefined;
    if (!(profile instanceof PDFRawStream)) continue;
    const decoded = decodedCmykProfile(profile);
    if (decoded) return decoded;
  }
  return null;
}

export function extractPageCmykIccProfile(
  pdf: LoadedPdfDocument,
  page: LoadedPdfPage,
): Uint8Array | null {
  const resources = page.node.Resources();
  // A document output intent describes the intended output condition for the
  // whole page. A page resource profile may describe only one image, pattern,
  // or gradient, so it is a fallback rather than the primary output profile.
  return profileFromOutputIntent(pdf)
    ?? (resources ? profileFromResources(resources, new Set()) : null);
}
