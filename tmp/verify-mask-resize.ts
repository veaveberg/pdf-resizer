import { readFile, writeFile } from 'node:fs/promises';
import { PDFDocument, PDFName } from 'pdf-lib';
import { rebasePageSoftMasks } from '../src/pdfSoftMaskTransform.ts';
const original = await readFile('/Users/sasha/Downloads/Telegram/1442-1442а-442_А1_260331.pdf');
for (const [name, sx, sy, offset, embed, fix] of [
  ['baseline', .707, .707, 0, false, false],
  ['fixed', .707, .707, 0, false, true],
  ['embedded', .5, .4, 20, true, true],
  ['embedded-baseline', .5, .4, 20, true, false],
] satisfies [string, number, number, number, boolean, boolean][]) {
 const source=await PDFDocument.load(original),out=await PDFDocument.create();
 const [p]=await out.copyPages(source,[0]);const {width,height}=p.getSize();
 if(fix) rebasePageSoftMasks(p,sx,sy);
 if(embed){const e=await out.embedPage(p);await out.flush();out.context.lookup(e.ref).dict.set(PDFName.of('Group'),p.node.get(PDFName.of('Group')));out.addPage([width*sx+offset*2,height*sy+offset*2]).drawPage(e,{x:offset,y:offset,xScale:sx,yScale:sy});}
 else {out.addPage(p);p.scaleContent(sx,sy);p.translateContent(offset,offset);p.setSize(width*sx+offset*2,height*sy+offset*2);}
 await writeFile(`tmp/pdfs/quartz-preview/verify-${name}.pdf`,await out.save());
}
