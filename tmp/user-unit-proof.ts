import { readFile, writeFile } from 'node:fs/promises';
import { PDFDocument, PDFName, PDFNumber } from 'pdf-lib';

const source = await PDFDocument.load(await readFile('/Users/sasha/Downloads/Telegram/1442-1442а-442_А1_260331.pdf'));
const output = await PDFDocument.create();
const [page] = await output.copyPages(source, [0]);
output.addPage(page);
page.node.set(PDFName.of('UserUnit'), PDFNumber.of(595 / page.getWidth()));
await writeFile('tmp/pdfs/quartz-preview/user-unit-a4.pdf', await output.save({ useObjectStreams: false }));
