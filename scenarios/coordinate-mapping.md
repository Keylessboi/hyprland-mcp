# Scenario: Coordinate Mapping

**ID:** GEO-01
**Source:** Plan §3 (deep D3 refined, geometry.ts)

## Given
- A monitor at logical origin (0,0), logical 1920×1080, scale 2.0.

## When
- A region is captured at (100, 200) with size 800×600 (logical).
- A screenshot pixel (px, py) is mapped back to logical coordinates.

## Then
- `toLogical(px, py) = (region.x + px/scale, region.y + py/scale)`.
- At scale 2.0, pixel (50, 40) maps to logical (125, 220).
- An invalid region (negative size, off-monitor) fails validation.

## Notes
grim outputs physical pixels; the scale lookup is the single mapping.
