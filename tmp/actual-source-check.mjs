import {readFile,writeFile} from 'node:fs/promises';
import {PDFDocument,PDFName,decodePDFRawStream} from 'pdf-lib';
const source=await PDFDocument.load(await readFile('/Users/sasha/Downloads/Telegram/1442-1442а-442_А1_260331.pdf'));
const masks=source.getPage(0).node.Resources().lookup(PDFName.of('ExtGState'));
for(const value of masks.values()){const d=source.context.lookup(value);const m=source.context.lookup(d.get(PDFName.of('SMask')));if(!m?.get)continue;const g=source.context.lookup(m.get(PDFName.of('G')));if(g?.dict)source.context.lookup(g.dict.get(PDFName.of('Group'))).set(PDFName.of('I'),source.context.obj(true));}
for(const value of masks.values()) {const d=source.context.lookup(value); const m=source.context.lookup(d.get(PDFName.of('SMask'))); if(!m?.get)continue;const g=source.context.lookup(m.get(PDFName.of('G')));if(!g?.dict)continue;const data=Buffer.from(decodePDFRawStream(g).decode()).toString('latin1').replace(/[-\d.]+\s+[-\d.]+\s+[-\d.]+\s+[-\d.]+\s+re\s+W\s+n/g,'');const replacement=source.context.flateStream(Buffer.from(data,'latin1'));for(const [k,v] of g.dict.entries())if(!['/Length','/Filter','/DecodeParms'].includes(k.toString()))replacement.dict.set(k,v);m.set(PDFName.of('G'),source.context.register(replacement));}
for(const mode of ['copy']) {
 const out=await PDFDocument.create();
 if(mode==='copy') {const [p]=await out.copyPages(source,[0]);out.addPage(p);p.scaleContent(0.707,0.707);p.setSize(1190.55,1685.62);}
 else {const [p]=await out.copyPages(source,[0]);const e=await out.embedPage(p);await out.flush();if(mode==='group'){out.context.lookup(e.ref).dict.set(PDFName.of('Group'),p.node.get(PDFName.of('Group')));}out.addPage([1190.55,1685.62]).drawPage(e,{xScale:0.707,yScale:0.707});}
 await writeFile(`tmp/pdfs/quartz-preview/actual-${mode}.pdf`,await out.save());
}
