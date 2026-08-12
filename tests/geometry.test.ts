/**
 * GEO-01 — coordinate mapping (scenarios/coordinate-mapping.md).
 */
import { describe, it, expect } from 'vitest';
import { buildCoordMapping, assertValidRegion, monitorGeometry, grimGeometry } from '../src/geometry.js';

const MONITORS = [
  monitorGeometry({ id: 0, name: 'eDP-1', x: 0, y: 0, width: 1920, height: 1080, scale: 2.0 }),
];

describe('GEO-01 coordinate mapping', () => {
  it('maps screenshot pixels to logical coords with scale', () => {
    const mapping = buildCoordMapping({ x: 100, y: 200, w: 800, h: 600 }, MONITORS);
    const [lx, ly] = mapping.toLogical(50, 40);
    expect(lx).toBe(125); // 100 + 50/2
    expect(ly).toBe(220); // 200 + 40/2
  });

  it('reports the monitor under the region', () => {
    const mapping = buildCoordMapping({ x: 100, y: 200, w: 800, h: 600 }, MONITORS);
    expect(mapping.monitor).toMatchObject({ id: 0, name: 'eDP-1', scale: 2.0 });
  });

  it('scale 1 maps 1:1', () => {
    const m = monitorGeometry({ id: 1, name: 'other', x: 0, y: 0, width: 1920, height: 1080, scale: 1.0 });
    const mapping = buildCoordMapping({ x: 0, y: 0, w: 100, h: 100 }, [m]);
    expect(mapping.toLogical(100, 100)).toEqual([100, 100]);
  });

  it('rejects invalid regions: non-positive size', () => {
    expect(() => assertValidRegion({ x: 0, y: 0, w: 0, h: 100 }, MONITORS)).toThrow(/non-positive/);
  });

  it('rejects invalid regions: off-monitor', () => {
    expect(() => assertValidRegion({ x: 5000, y: 5000, w: 100, h: 100 }, MONITORS)).toThrow(/does not overlap/);
  });

  it('accepts a valid region', () => {
    expect(() => assertValidRegion({ x: 100, y: 100, w: 100, h: 100 }, MONITORS)).not.toThrow();
  });

  it('formats grim -g geometry', () => {
    expect(grimGeometry({ x: 100, y: 200, w: 800, h: 600 })).toBe('100,200 800x600');
  });
});
