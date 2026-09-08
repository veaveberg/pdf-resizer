import {
  degrees,
  drawImage,
  PDFDocument,
} from 'pdf-lib';

type WritablePdfDocument = Awaited<ReturnType<typeof PDFDocument.create>>;
type WritablePdfPage = ReturnType<WritablePdfDocument['addPage']>;

export interface CmykRasterImage {
  width: number;
  height: number;
  bytes: Uint8Array;
}

export interface PdfImageDestination {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function rgbaToDeviceCmyk(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
): CmykRasterImage {
  const pixelCount = width * height;
  if (rgba.length !== pixelCount * 4) {
    throw new Error('RGBA pixel data does not match its dimensions.');
  }

  const cmyk = new Uint8Array(pixelCount * 4);
  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    const sourceOffset = pixel * 4;
    const r = rgba[sourceOffset];
    const g = rgba[sourceOffset + 1];
    const b = rgba[sourceOffset + 2];
    const alpha = rgba[sourceOffset + 3] / 255;

    // The padding canvas is opaque today. Compositing here keeps this helper
    // correct if a future renderer supplies transparent edge pixels.
    const opaqueR = Math.round(r * alpha + 255 * (1 - alpha));
    const opaqueG = Math.round(g * alpha + 255 * (1 - alpha));
    const opaqueB = Math.round(b * alpha + 255 * (1 - alpha));
    const black = 255 - Math.max(opaqueR, opaqueG, opaqueB);
    const destinationOffset = pixel * 4;

    if (black === 255) {
      cmyk[destinationOffset + 3] = 255;
      continue;
    }

    const range = 255 - black;
    cmyk[destinationOffset] = Math.round((255 - opaqueR - black) * 255 / range);
    cmyk[destinationOffset + 1] = Math.round((255 - opaqueG - black) * 255 / range);
    cmyk[destinationOffset + 2] = Math.round((255 - opaqueB - black) * 255 / range);
    cmyk[destinationOffset + 3] = black;
  }

  return { width, height, bytes: cmyk };
}

export function drawDeviceCmykImage(
  pdf: WritablePdfDocument,
  page: WritablePdfPage,
  image: CmykRasterImage,
  destination: PdfImageDestination,
): void {
  const imageStream = pdf.context.flateStream(image.bytes, {
    Type: 'XObject',
    Subtype: 'Image',
    Width: image.width,
    Height: image.height,
    BitsPerComponent: 8,
    ColorSpace: 'DeviceCMYK',
    Decode: [0, 1, 0, 1, 0, 1, 0, 1],
  });
  const imageReference = pdf.context.register(imageStream);
  const imageName = page.node.newXObject('CmykPadding', imageReference);

  page.pushOperators(...drawImage(imageName, {
    ...destination,
    rotate: degrees(0),
    xSkew: degrees(0),
    ySkew: degrees(0),
  }));
}
