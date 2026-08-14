/**
 * Screen region — the union bounding box of all monitors. Every "target:
 * screen" capture and OCR path shares this; the compositor places monitors on
 * one logical plane, so the union is the visible desktop.
 */
import type { LogicalRect } from '../geometry.js';

export function unionRegion(rects: { x: number; y: number; w: number; h: number }[]): LogicalRect {
  return {
    x: Math.min(...rects.map((r) => r.x)),
    y: Math.min(...rects.map((r) => r.y)),
    w: Math.max(...rects.map((r) => r.x + r.w)) - Math.min(...rects.map((r) => r.x)),
    h: Math.max(...rects.map((r) => r.y + r.h)) - Math.min(...rects.map((r) => r.y)),
  };
}
