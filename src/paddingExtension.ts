export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type ContentFit = 'fill' | 'scale' | 'stretch';

export interface MappedContent {
  drawRect: Rect;
  visibleSourceRect: Rect;
}

export interface EdgeExtensionOperation {
  source: Rect;
  destination: Rect;
}

export type PaddingStripKind = 'top' | 'bottom' | 'left' | 'right';

export interface PaddingStripRegion {
  kind: PaddingStripKind;
  source: Rect;
}

const positive = (value: number) => Math.max(0, value);

export function contentFit(mode: string): ContentFit {
  if (mode === 'fill' || mode === 'scale') return mode;
  return 'stretch';
}

export function mapContent(
  sourceRect: Rect,
  destinationRect: Rect,
  fit: ContentFit,
): MappedContent {
  if (fit === 'stretch') {
    return {
      drawRect: { ...destinationRect },
      visibleSourceRect: { ...sourceRect },
    };
  }

  const scale = fit === 'fill'
    ? Math.max(destinationRect.width / sourceRect.width, destinationRect.height / sourceRect.height)
    : Math.min(destinationRect.width / sourceRect.width, destinationRect.height / sourceRect.height);
  const drawWidth = sourceRect.width * scale;
  const drawHeight = sourceRect.height * scale;
  const drawRect = {
    x: destinationRect.x + (destinationRect.width - drawWidth) / 2,
    y: destinationRect.y + (destinationRect.height - drawHeight) / 2,
    width: drawWidth,
    height: drawHeight,
  };

  if (fit === 'scale') {
    return { drawRect, visibleSourceRect: { ...sourceRect } };
  }

  const clippedLeft = Math.max(destinationRect.x - drawRect.x, 0) / scale;
  const clippedTop = Math.max(destinationRect.y - drawRect.y, 0) / scale;
  return {
    drawRect,
    visibleSourceRect: {
      x: sourceRect.x + clippedLeft,
      y: sourceRect.y + clippedTop,
      width: Math.min(destinationRect.width / scale, sourceRect.width),
      height: Math.min(destinationRect.height / scale, sourceRect.height),
    },
  };
}

export function edgeExtensionOperations(
  sourceRect: Rect,
  contentRect: Rect,
  outputWidth: number,
  outputHeight: number,
): EdgeExtensionOperation[] {
  const leftPadding = positive(contentRect.x);
  const topPadding = positive(contentRect.y);
  const rightPadding = positive(outputWidth - contentRect.x - contentRect.width);
  const bottomPadding = positive(outputHeight - contentRect.y - contentRect.height);
  const sampleWidth = Math.min(1, sourceRect.width);
  const sampleHeight = Math.min(1, sourceRect.height);
  const rightSourceX = sourceRect.x + sourceRect.width - sampleWidth;
  const bottomSourceY = sourceRect.y + sourceRect.height - sampleHeight;
  const operations: EdgeExtensionOperation[] = [];

  const add = (source: Rect, destination: Rect) => {
    if (destination.width > 0 && destination.height > 0) {
      operations.push({ source, destination });
    }
  };

  add(
    { x: sourceRect.x, y: sourceRect.y, width: sourceRect.width, height: sampleHeight },
    { x: contentRect.x, y: 0, width: contentRect.width, height: topPadding },
  );
  add(
    { x: sourceRect.x, y: bottomSourceY, width: sourceRect.width, height: sampleHeight },
    {
      x: contentRect.x,
      y: contentRect.y + contentRect.height,
      width: contentRect.width,
      height: bottomPadding,
    },
  );
  add(
    { x: sourceRect.x, y: sourceRect.y, width: sampleWidth, height: sourceRect.height },
    { x: 0, y: contentRect.y, width: leftPadding, height: contentRect.height },
  );
  add(
    { x: rightSourceX, y: sourceRect.y, width: sampleWidth, height: sourceRect.height },
    {
      x: contentRect.x + contentRect.width,
      y: contentRect.y,
      width: rightPadding,
      height: contentRect.height,
    },
  );

  const corners = [
    {
      source: { x: sourceRect.x, y: sourceRect.y, width: sampleWidth, height: sampleHeight },
      destination: { x: 0, y: 0, width: leftPadding, height: topPadding },
    },
    {
      source: { x: rightSourceX, y: sourceRect.y, width: sampleWidth, height: sampleHeight },
      destination: {
        x: contentRect.x + contentRect.width,
        y: 0,
        width: rightPadding,
        height: topPadding,
      },
    },
    {
      source: { x: sourceRect.x, y: bottomSourceY, width: sampleWidth, height: sampleHeight },
      destination: {
        x: 0,
        y: contentRect.y + contentRect.height,
        width: leftPadding,
        height: bottomPadding,
      },
    },
    {
      source: { x: rightSourceX, y: bottomSourceY, width: sampleWidth, height: sampleHeight },
      destination: {
        x: contentRect.x + contentRect.width,
        y: contentRect.y + contentRect.height,
        width: rightPadding,
        height: bottomPadding,
      },
    },
  ];
  corners.forEach(({ source, destination }) => add(source, destination));

  return operations;
}

export function paddingStripRegions(
  contentRect: Rect,
  outputWidth: number,
  outputHeight: number,
): PaddingStripRegion[] {
  const top = positive(contentRect.y);
  const bottom = positive(outputHeight - contentRect.y - contentRect.height);
  const left = positive(contentRect.x);
  const right = positive(outputWidth - contentRect.x - contentRect.width);
  const regions: PaddingStripRegion[] = [];

  if (top > 0) {
    regions.push({ kind: 'top', source: { x: 0, y: 0, width: outputWidth, height: top } });
  }
  if (bottom > 0) {
    regions.push({
      kind: 'bottom',
      source: { x: 0, y: contentRect.y + contentRect.height, width: outputWidth, height: bottom },
    });
  }
  if (left > 0 && contentRect.height > 0) {
    regions.push({
      kind: 'left',
      source: { x: 0, y: contentRect.y, width: left, height: contentRect.height },
    });
  }
  if (right > 0 && contentRect.height > 0) {
    regions.push({
      kind: 'right',
      source: {
        x: contentRect.x + contentRect.width,
        y: contentRect.y,
        width: right,
        height: contentRect.height,
      },
    });
  }

  return regions;
}

export function drawEdgeExtension(
  context: CanvasRenderingContext2D,
  source: CanvasImageSource,
  sourceRect: Rect,
  contentRect: Rect,
  outputWidth: number,
  outputHeight: number,
): void {
  for (const operation of edgeExtensionOperations(
    sourceRect,
    contentRect,
    outputWidth,
    outputHeight,
  )) {
    const src = operation.source;
    const dest = operation.destination;
    context.drawImage(
      source,
      src.x,
      src.y,
      src.width,
      src.height,
      dest.x,
      dest.y,
      dest.width,
      dest.height,
    );
  }
}
