import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import { PDFDocument } from 'pdf-lib';
type PdfPage = ReturnType<InstanceType<typeof PDFDocument>['getPage']>;
type PdfDictionary = InstanceType<typeof PDFDict>;
type PdfStream = InstanceType<typeof PDFRawStream>;

/** Rebase vector masks without changing their appearance or color spaces.
 * Quartz clips some luminosity masks after page scaling unless that scaling is
 * expressed inside the mask too. The inverse Form matrix keeps PDF semantics.
 * Call on an export-only page, once, before applying its resize transform.
 */
export function rebasePageSoftMasks(page: PdfPage, scaleX: number, scaleY: number): void {
  if (!(scaleX > 0 && scaleY > 0 && Number.isFinite(scaleX) && Number.isFinite(scaleY))) {
    throw new Error('Invalid PDF soft-mask scale.');
  }
  if (scaleX === 1 && scaleY === 1) return;
  const context = page.doc.context;
  const visited = new Set<PdfDictionary>();
  const rewritten = new Map<PdfStream, ReturnType<typeof context.register>>();
  function numbers(dict: PdfDictionary, key: string, count: number): number[] | undefined {
    const array = context.lookup(dict.get(PDFName.of(key)));
    if (!(array instanceof PDFArray) || array.size() !== count) return undefined;
    const values: number[] = [];
    for (let i = 0; i < count; i++) {
      const value = context.lookup(array.get(i));
      if (!(value instanceof PDFNumber) || !Number.isFinite(value.asNumber())) return undefined;
      values.push(value.asNumber());
    }
    return values;
  }
  function visit(resources: PdfDictionary): void {
    if (visited.has(resources)) return;
    visited.add(resources);
    const states = context.lookup(resources.get(PDFName.of('ExtGState')));
    if (states instanceof PDFDict) for (const value of states.values()) {
      const state = context.lookup(value);
      if (!(state instanceof PDFDict)) continue;
      const mask = context.lookup(state.get(PDFName.of('SMask')));
      if (!(mask instanceof PDFDict)) continue;
      const form = context.lookup(mask.get(PDFName.of('G')));
      if (!(form instanceof PDFRawStream)) continue;
      const maskResources = context.lookup(form.dict.get(PDFName.of('Resources')));
      // Pattern coordinates depend on the initial space. Do not rebase those,
      // or opaque nested artwork, as if they were direct vector shadings.
      if (!(maskResources instanceof PDFDict)
        || !maskResources.has(PDFName.of('Shading'))
        || maskResources.has(PDFName.of('Pattern'))
        || maskResources.has(PDFName.of('XObject'))) continue;
      const existing = rewritten.get(form);
      if (existing) { mask.set(PDFName.of('G'), existing); continue; }
      const bbox = numbers(form.dict, 'BBox', 4);
      const matrix = form.dict.has(PDFName.of('Matrix'))
        ? numbers(form.dict, 'Matrix', 6) : [1, 0, 0, 1, 0, 0];
      if (!bbox || !matrix) throw new Error('Invalid PDF soft-mask geometry.');
      const prefix = new TextEncoder().encode(`${scaleX} 0 0 ${scaleY} 0 0 cm\n`);
      const content = decodePDFRawStream(form).decode();
      const bytes = new Uint8Array(prefix.length + content.length);
      bytes.set(prefix); bytes.set(content, prefix.length);
      const replacement = context.flateStream(bytes);
      for (const [key, item] of form.dict.entries()) {
        if (!['/Length', '/Filter', '/DecodeParms'].includes(key.toString())) replacement.dict.set(key, item);
      }
      replacement.dict.set(PDFName.of('BBox'), context.obj(bbox.map((v, i) => v * (i % 2 === 0 ? scaleX : scaleY))));
      replacement.dict.set(PDFName.of('Matrix'), context.obj(matrix.map((v, i) => i < 2 ? v / scaleX : i < 4 ? v / scaleY : v)));
      const ref = context.register(replacement);
      rewritten.set(form, ref);
      // A shared mask dictionary may be visited via several graphics states.
      rewritten.set(replacement, ref);
      mask.set(PDFName.of('G'), ref);
    }
    const objects = context.lookup(resources.get(PDFName.of('XObject')));
    if (objects instanceof PDFDict) for (const value of objects.values()) {
      const form = context.lookup(value);
      if (!(form instanceof PDFRawStream)) continue;
      const nested = context.lookup(form.dict.get(PDFName.of('Resources')));
      if (nested instanceof PDFDict) visit(nested);
    }
  }
  const resources = page.node.Resources();
  if (resources) visit(resources);
}
