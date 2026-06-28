/**
 * Web Mercator projection — lng/lat → pixel coordinates relative to a static map image.
 *
 * Used by the `static_overlay` tool (Figma Design mode) so geographic features
 * (pins, routes, isochrones) can be placed at their real positions on top of a
 * static map image. Matches Mapbox GL / Static Images API (512px tile size).
 *
 * Pure math — no network. pitch is intentionally unsupported (always top-down);
 * a tilted perspective would require the full GL projection matrix.
 */

/** Camera describing the static map image the pixels are relative to. */
export interface Viewport {
  /** [lng, lat] of the map center. */
  center: [number, number];
  zoom: number;
  /** Logical (non-retina) image width in CSS pixels. */
  width: number;
  /** Logical (non-retina) image height in CSS pixels. */
  height: number;
  /** Map rotation in degrees, clockwise (default 0 = north-up). */
  bearing: number;
}

export interface PixelPoint {
  /** Pixel offset from the left edge of the image. */
  x: number;
  /** Pixel offset from the top edge of the image. */
  y: number;
  /** True when the point falls within [0,width] × [0,height]. */
  in_view: boolean;
}

const TILE_SIZE = 512;
const MAX_LAT = 85.051129; // Web Mercator latitude clamp

/** Project a lng/lat to a world-pixel coordinate at the given zoom. */
function lngLatToWorld(lng: number, lat: number, zoom: number): { wx: number; wy: number } {
  const worldSize = TILE_SIZE * Math.pow(2, zoom);
  const clampedLat = Math.max(Math.min(lat, MAX_LAT), -MAX_LAT);
  const phi = (clampedLat * Math.PI) / 180;
  const mx = (lng + 180) / 360;
  const my = (1 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / Math.PI) / 2;
  return { wx: mx * worldSize, wy: my * worldSize };
}

/** Project a single lng/lat to an {x,y} pixel relative to the image's top-left. */
export function project(lng: number, lat: number, vp: Viewport): PixelPoint {
  const { wx, wy } = lngLatToWorld(lng, lat, vp.zoom);
  const c = lngLatToWorld(vp.center[0], vp.center[1], vp.zoom);

  let dx = wx - c.wx;
  let dy = wy - c.wy;

  if (vp.bearing) {
    // Map bearing rotates the map clockwise; rotate the delta by -bearing
    // so screen coordinates stay axis-aligned with the image.
    const theta = (-vp.bearing * Math.PI) / 180;
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    const rx = dx * cos - dy * sin;
    const ry = dx * sin + dy * cos;
    dx = rx;
    dy = ry;
  }

  const x = vp.width / 2 + dx;
  const y = vp.height / 2 + dy;
  const in_view = x >= 0 && x <= vp.width && y >= 0 && y <= vp.height;
  return { x, y, in_view };
}

/** Project an array of [lng, lat] coordinates (a LineString or polygon ring). */
export function projectCoords(coords: [number, number][], vp: Viewport): PixelPoint[] {
  return coords.map(([lng, lat]) => project(lng, lat, vp));
}
