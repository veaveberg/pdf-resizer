import {readFile,writeFile} from 'node:fs/promises';
import {PDFDocument,PDFName,decodePDFRawStream} from 'pdf-lib';
const source=await PDFDocument.load(await readFile('/Users/sasha/Downloads/Telegram/1442-1442а-442_А1_260331.pdf'));
const masks=source.getPage(0).node.Resources().lookup(PDFName.of('ExtGState'));
for(const value of masks.values()) {
 const d=source.context.lookup(value),m=source.context.lookup(d.get(PDFName.of('SMask')));if(!m?.get)continue;
 const ref=m.get(PDFName.of('G')),g=source.context.lookup(ref);if(!g?.dict)continue;
 const s=.707;
 const wrapper=source.context.flateStream(Buffer.concat([Buffer.from(`${s} 0 0 ${s} 0 0 cm\n`),decodePDFRawStream(g).decode()]));
 for(const [k,v] of g.dict.entries())if(!['/Length','/Filter','/DecodeParms'].includes(k.toString()))wrapper.dict.set(k,v);
 wrapper.dict.set(PDFName.of('BBox'),source.context.obj(g.dict.lookup(PDFName.of('BBox')).asArray().map(v=>v.asNumber()*s)));
 wrapper.dict.set(PDFName.of('Matrix'),source.context.obj([1/s,0,0,1/s,0,0]));
 m.set(PDFName.of('G'),source.context.register(wrapper));
}
const out=await PDFDocument.create();
const [p]=await out.copyPages(source,[0]);out.addPage(p);p.scaleContent(.707,.707);p.setSize(1190.55,1685.62);
await writeFile('tmp/pdfs/quartz-preview/mask-wrapper.pdf',await out.save());
