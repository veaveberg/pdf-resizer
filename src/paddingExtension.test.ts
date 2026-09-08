import assert from 'node:assert/strict';
import test from 'node:test';
import {
  edgeExtensionOperations,
  mapContent,
  paddingStripRegions,
  type Rect,
} from './paddingExtension.ts';

test('fill maps the visible centered crop to the padding boundary', () => {
  const source: Rect = { x: 10, y: 20, width: 200, height: 100 };
  const destination: Rect = { x: 12, y: 12, width: 100, height: 100 };
  const mapped = mapContent(source, destination, 'fill');

  assert.deepEqual(mapped.drawRect, { x: -38, y: 12, width: 200, height: 100 });
  assert.deepEqual(mapped.visibleSourceRect, { x: 60, y: 20, width: 100, height: 100 });
});

test('scale keeps the full source edge available for extension', () => {
  const source: Rect = { x: 0, y: 0, width: 200, height: 100 };
  const destination: Rect = { x: 10, y: 10, width: 100, height: 100 };
  const mapped = mapContent(source, destination, 'scale');

  assert.deepEqual(mapped.drawRect, { x: 10, y: 35, width: 100, height: 50 });
  assert.deepEqual(mapped.visibleSourceRect, source);
});

test('edge extension covers all four padding bands and corners', () => {
  const operations = edgeExtensionOperations(
    { x: 5, y: 6, width: 80, height: 60 },
    { x: 10, y: 20, width: 100, height: 80 },
    120,
    130,
  );

  assert.equal(operations.length, 8);
  const coveredArea = operations.reduce(
    (sum, operation) => sum + operation.destination.width * operation.destination.height,
    0,
  );
  assert.equal(coveredArea, 120 * 130 - 100 * 80);
});

test('padding strips cover the padding once without a full-page overlay', () => {
  const strips = paddingStripRegions(
    { x: 10, y: 20, width: 100, height: 80 },
    120,
    130,
  );

  assert.deepEqual(strips.map(strip => strip.kind), ['top', 'bottom', 'left', 'right']);
  const stripArea = strips.reduce(
    (sum, strip) => sum + strip.source.width * strip.source.height,
    0,
  );
  assert.equal(stripArea, 120 * 130 - 100 * 80);
  assert.ok(strips.every(strip => (
    strip.source.width < 120 || strip.source.height < 130
  )));
});
