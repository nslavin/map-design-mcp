/**
 * gl-map-renderer.ts
 *
 * Renders a Mapbox GL JS map in a headless Chrome browser (Cloudflare Browser Rendering)
 * and returns a PNG screenshot as base64. Enables full WebGL fidelity:
 *   - mapbox/standard style (3D buildings, landmark icons, lightPreset)
 *   - Standard config via map.setConfigProperty()
 *   - Pitch, bearing, all camera controls
 *
 * The Static Images API path remains for classic styles (fast, ~500ms).
 */

// @ts-ignore — @cloudflare/puppeteer types are loose; the import works at runtime
import puppeteer from "@cloudflare/puppeteer";

/** Single source of truth for the GL JS version used in CDN tags and pattern docs. */
export const GL_JS_VERSION = "3.12.0";

export interface MapRenderParams {
  center: [number, number];
  zoom: number;
  bearing: number;
  pitch: number;
  width: number;
  height: number;
  /** Full Mapbox style string, e.g. "mapbox/standard" or "username/styleId" */
  style: string;
  /** Key-value pairs applied via map.setConfigProperty('basemap', k, v) after load */
  standardConfig: Record<string, unknown>;
  /** Public (pk.*) Mapbox access token — safe to embed in client-side HTML */
  publicToken: string;
  /** When true, render at 2× device pixel ratio (retina). Default false. */
  retina?: boolean;
}

// ── Style validation ──────────────────────────────────────────────────────────

/**
 * Valid Mapbox style references:
 *   • "owner/styleId"                          (e.g. "mapbox/standard")
 *   • "mapbox://styles/owner/styleId"          (full URI form)
 *
 * Owner and style ID segments may contain word chars, hyphens, and dots.
 * Enforced here to prevent </script> injection into the server-rendered HTML page.
 */
export const STYLE_RE = /^(mapbox:\/\/styles\/)?[\w][\w.-]*\/[\w][\w.-]*$/;

// ── HTML page builder ─────────────────────────────────────────────────────────

export function buildMapHtml(p: MapRenderParams): string {
  // Validate style reference to prevent script injection via </script> in the
  // embedded <script> block (JSON.stringify does not escape < or /).
  if (!STYLE_RE.test(p.style)) {
    throw new Error(
      `Invalid style "${p.style}". Use "owner/styleId" or "mapbox://styles/owner/styleId".`
    );
  }

  // Validate numeric camera params — non-numbers or non-finite values (NaN, Infinity)
  // would inject raw text into the HTML page or break GL JS initialization.
  const nums = [p.center[0], p.center[1], p.zoom, p.bearing, p.pitch, p.width, p.height];
  if (nums.some((n) => typeof n !== "number" || !isFinite(n))) {
    throw new Error("Map render params (center, zoom, bearing, pitch, width, height) must be finite numbers.");
  }

  // Serialize the Standard config so we can apply it after map.load()
  const configJson = JSON.stringify(p.standardConfig);

  // Determine style URL — Mapbox styles use mapbox://styles/{owner}/{id}
  const styleUrl = p.style.startsWith("mapbox://")
    ? p.style
    : `mapbox://styles/${p.style}`;

  // Puppeteer waitForFunction timeout is 15s; in-page fallback fires at 16s so
  // a slow-style timeout surfaces as a Puppeteer error rather than a silent
  // half-loaded screenshot.
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { overflow: hidden; background: #f0ebe3; }
  #map { width: ${p.width}px; height: ${p.height}px; }
</style>
<link rel="stylesheet" href="https://api.mapbox.com/mapbox-gl-js/v${GL_JS_VERSION}/mapbox-gl.css">
<script src="https://api.mapbox.com/mapbox-gl-js/v${GL_JS_VERSION}/mapbox-gl.js"></script>
</head>
<body>
<div id="map"></div>
<script>
(function () {
  mapboxgl.accessToken = ${JSON.stringify(p.publicToken)};

  var map = new mapboxgl.Map({
    container: 'map',
    style: ${JSON.stringify(styleUrl)},
    center: [${p.center[0]}, ${p.center[1]}],
    zoom: ${p.zoom},
    bearing: ${p.bearing},
    pitch: ${p.pitch},
    interactive: false,
    preserveDrawingBuffer: true,
    fadeDuration: 0,
    optimizeForTerrain: false,
  });

  // Apply Standard style config properties after load
  map.on('load', function () {
    var cfg = ${configJson};
    Object.keys(cfg).forEach(function (k) {
      try { map.setConfigProperty('basemap', k, cfg[k]); } catch (e) {}
    });
  });

  // Signal readiness after tiles finish rendering.
  // Wait for idle + all tiles loaded to avoid screenshotting a half-loaded map.
  map.on('idle', function () {
    if (map.areTilesLoaded()) {
      window.__mapReady = true;
    } else {
      // Tiles still arriving — wait for the next idle cycle
      map.once('idle', function () { window.__mapReady = true; });
    }
  });

  // Hard fallback: 16s (must exceed Puppeteer's 15s waitForFunction timeout so
  // a genuine tile-fetch timeout surfaces as an error rather than a blank shot).
  setTimeout(function () { window.__mapReady = true; }, 16000);
})();
</script>
</body>
</html>`;
}

// ── Screenshot via Cloudflare Browser Rendering ───────────────────────────────

export async function screenshotMap(
  params: MapRenderParams,
  browser: Fetcher,
): Promise<{ data: string; mimeType: string }> {
  const html = buildMapHtml(params);
  const dpr = params.retina ? 2 : 1;

  const b = await puppeteer.launch(browser);
  try {
    const page = await b.newPage();
    await page.setViewport({
      width: params.width,
      height: params.height,
      deviceScaleFactor: dpr,
    });

    // Set the HTML directly — faster than navigating to a URL, avoids same-origin issues
    await page.setContent(html, { waitUntil: "domcontentloaded" });

    // Wait for the map idle event (up to 15s — tile fetching + GL rendering takes ~3-8s)
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore — window exists in the browser context evaluated by Puppeteer
    await page.waitForFunction(() => window.__mapReady === true, { timeout: 15000 });

    // Small extra delay to let the final frame composite
    await new Promise((r) => setTimeout(r, 500));

    const buf = await page.screenshot({ type: "png", fullPage: false });

    // Base64 encode in chunks to avoid call-stack overflow on large images
    const bytes = new Uint8Array(buf as unknown as ArrayBuffer);
    let binary = "";
    const chunk = 8192;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return { data: btoa(binary), mimeType: "image/png" };
  } finally {
    await b.close();
  }
}
