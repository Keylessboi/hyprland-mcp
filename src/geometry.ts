/**
 * Geometry — logical coordinate space (deep D3, refined).
 *
 * All hyprctl at/size/cursorpos, `dispatch movecursor`, and `grim -g` speak
 * ONE space: global logical layout coordinates. The only mapping is
 * screenshot-pixel → logical (scale lookup per monitor). XWayland toplevels
 * are a separate story — routed to the same backend via uinput, never mixed
 * into native math.
 */

export interface LogicalRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface MonitorGeometry {
  id: number;
  name: string;
  x: number;
  y: number;
  w: number; // logical width
  h: number; // logical height
  scale: number;
  physicalW: number;
  physicalH: number;
}

export function monitorGeometry(mon: {
  id: number;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
}): MonitorGeometry {
  return {
    id: mon.id,
    name: mon.name,
    x: mon.x,
    y: mon.y,
    w: mon.width,
    h: mon.height,
    scale: mon.scale,
    physicalW: Math.round(mon.width * mon.scale),
    physicalH: Math.round(mon.height * mon.scale),
  };
}

/** grim -g geometry string from logical rect. */
export function grimGeometry(r: LogicalRect): string {
  return `${r.x},${r.y} ${r.w}x${r.h}`;
}

/** Validate a region before spawning grim (deep InvalidGeometryError). */
export function assertValidRegion(r: LogicalRect, monitors: MonitorGeometry[]): void {
  if (!Number.isFinite(r.x) || !Number.isFinite(r.y) || !Number.isFinite(r.w) || !Number.isFinite(r.h)) {
    throw new Error(`invalid geometry: ${JSON.stringify(r)}`);
  }
  if (r.w <= 0 || r.h <= 0) {
    throw new Error(`region has non-positive size: ${JSON.stringify(r)}`);
  }
  const onAny = monitors.some((m) => {
    const overlaps =
      r.x < m.x + m.w && r.x + r.w > m.x && r.y < m.y + m.h && r.y + r.h > m.y;
    return overlaps;
  });
  if (!onAny) {
    throw new Error(`region does not overlap any monitor: ${JSON.stringify(r)}`);
  }
}

export interface CoordMapping {
  region: LogicalRect;
  monitor: { id: number; name: string; scale: number } | null;
  /** screenshot pixel → global logical */
  toLogical: (px: number, py: number) => [number, number];
}

/**
 * Build the pixel→logical mapping for a capture. grim outputs physical pixels;
 * logical = region.origin + pixel / scale.
 */
export function buildCoordMapping(
  region: LogicalRect,
  monitors: MonitorGeometry[],
  scaleOverride?: number,
): CoordMapping {
  // find the monitor under the region's top-left for scale
  const mon = monitors.find((m) => region.x >= m.x && region.x < m.x + m.w && region.y >= m.y && region.y < m.y + m.h);
  const scale = scaleOverride ?? mon?.scale ?? 1;
  const m = mon ?? null;
  return {
    region,
    monitor: m ? { id: m.id, name: m.name, scale: m.scale } : null,
    toLogical: (px: number, py: number) => [region.x + px / scale, region.y + py / scale],
  };
}
