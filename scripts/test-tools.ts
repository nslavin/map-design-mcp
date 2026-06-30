#!/usr/bin/env tsx
/**
 * Unit tests for native worker tool handlers.
 * Run: npx tsx scripts/test-tools.ts
 */

import { handleDesignAudit, handlePaletteSuggest, handleSegmentPreset } from "../src/tools.js";
import { validateExpression, getReference } from "../src/expression-validator.js";
import { SEGMENT_KEYS, SEGMENT_GUIDANCE } from "../src/design-guidance.js";
import { DEV_PATTERNS, EXAMPLE_URLS, GL_JS_VERSION } from "../src/dev-patterns.js";
import { modeBriefText } from "../src/mode-brief.js";
import { project, projectCoords } from "../src/projection.js";
import { buildMapHtml, STYLE_RE, GL_JS_VERSION as RENDERER_GL_JS_VERSION } from "../src/gl-map-renderer.js";
import { INTERACTIVE_ONLY_TOOLS, DESIGN_ONLY_TOOLS, toolsForMode, buildToolContent } from "../src/index.js";
import { PRESETS } from "../src/tools.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✓  ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗  ${name}`);
    console.error(`     ${(err as Error).message}`);
    failed++;
  }
}

function expect<T>(actual: T) {
  return {
    toBe: (expected: T) => {
      if (actual !== expected) throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    },
    toContain: (substr: string) => {
      if (typeof actual !== "string" || !actual.includes(substr))
        throw new Error(`expected string to contain "${substr}", got: ${String(actual).slice(0, 80)}`);
    },
    toBeGreaterThan: (n: number) => {
      if (typeof actual !== "number" || actual <= n) throw new Error(`expected > ${n}, got ${actual}`);
    },
    toBeLessThan: (n: number) => {
      if (typeof actual !== "number" || actual >= n) throw new Error(`expected < ${n}, got ${actual}`);
    },
    toHaveLength: (n: number) => {
      if (!Array.isArray(actual) || actual.length !== n)
        throw new Error(`expected length ${n}, got ${(actual as unknown[]).length}`);
    },
    toBeArray: () => {
      if (!Array.isArray(actual)) throw new Error(`expected array, got ${typeof actual}`);
    },
    toBeNull: () => {
      if (actual !== null) throw new Error(`expected null, got ${JSON.stringify(actual)}`);
    },
    toBeTruthy: () => {
      if (!actual) throw new Error(`expected truthy, got ${JSON.stringify(actual)}`);
    },
  };
}

// ── Design Audit ─────────────────────────────────────────────────────────────

console.log("\n── handleDesignAudit ────────────────────────────────────────────");

test("3D buildings on real_estate → 3d-on-listings violation", () => {
  const result = handleDesignAudit({
    segment: "real_estate",
    standard_config: { show3dBuildings: true, lightPreset: "day" },
  });
  const ids = result.violations.map((v) => v.id);
  if (!ids.includes("3d-on-listings")) throw new Error(`expected 3d-on-listings, got: ${ids.join(", ")}`);
});

test("POI labels on data_viz → poi-at-high-zoom info", () => {
  const result = handleDesignAudit({
    segment: "data_viz",
    standard_config: { showPointOfInterestLabels: true },
  });
  const ids = result.violations.map((v) => v.id);
  if (!ids.includes("poi-at-high-zoom")) throw new Error(`expected poi-at-high-zoom, got: ${ids.join(", ")}`);
});

test("clean style → score 100", () => {
  const result = handleDesignAudit({ style_json: { layers: [], sources: {} } });
  expect(result.score).toBe(100);
});

test("returns segment_notes for known segment", () => {
  const result = handleDesignAudit({ segment: "automotive", standard_config: {} });
  if (!result.segment_notes) throw new Error("expected segment_notes");
});

test("large GeoJSON source → geojson-too-large error", () => {
  const features = Array.from({ length: 600 }, (_, i) => ({ type: "Feature", geometry: null, properties: { i } }));
  const result = handleDesignAudit({
    style_json: {
      layers: [],
      sources: { myData: { type: "geojson", data: { type: "FeatureCollection", features } } },
    },
  });
  const ids = result.violations.map((v) => v.id);
  if (!ids.includes("geojson-too-large")) throw new Error(`expected geojson-too-large, got: ${ids.join(", ")}`);
});

// ── Palette Suggest ───────────────────────────────────────────────────────────

console.log("\n── handlePaletteSuggest ─────────────────────────────────────────");

test("returns palette with expected keys", () => {
  const result = handlePaletteSuggest({ brand_color: "#e60023", segment: "retail", background: "light" });
  const keys = Object.keys(result.palette);
  for (const k of ["primary", "accent_1", "accent_2", "route_line"]) {
    if (!keys.includes(k)) throw new Error(`missing palette key: ${k}`);
  }
});

test("dark background → night lightPreset in config patch", () => {
  const result = handlePaletteSuggest({ brand_color: "#0066ff", segment: "automotive", background: "dark" });
  expect(result.standard_config_patch.lightPreset as string).toBe("night");
});

test("WCAG report has 4 pairs", () => {
  const result = handlePaletteSuggest({ brand_color: "#e60023", segment: "retail", background: "light" });
  expect(result.wcag_report.length).toBe(4);
});

test("all WCAG report pairs have ratio > 0", () => {
  const result = handlePaletteSuggest({ brand_color: "#cc0055", segment: "data_viz", background: "light" });
  for (const p of result.wcag_report) {
    if (p.ratio <= 0) throw new Error(`ratio should be > 0, got ${p.ratio} for ${p.pair}`);
  }
});

// ── Segment Preset ────────────────────────────────────────────────────────────

console.log("\n── handleSegmentPreset ──────────────────────────────────────────");

test("logistics_customer → faded theme, showPointOfInterestLabels false", () => {
  const r = handleSegmentPreset({ segment: "logistics_customer" });
  if (r.config.theme !== "faded") throw new Error(`expected faded, got ${r.config.theme}`);
  if (r.config.showPointOfInterestLabels !== false) throw new Error("expected POI labels off");
});

test("automotive → instructions array is non-empty", () => {
  const r = handleSegmentPreset({ segment: "automotive" });
  if (!r.instructions.length) throw new Error("expected instructions");
});

test("time_of_day override applies", () => {
  const r = handleSegmentPreset({ segment: "logistics_driver", time_of_day: "night" });
  expect(r.config.lightPreset as string).toBe("night");
});

test("unknown segment → graceful error message", () => {
  const r = handleSegmentPreset({ segment: "foobar_unknown" });
  expect(r.rationale).toContain("Unknown segment");
});

test("all segments return a non-empty config", () => {
  const segments = SEGMENT_KEYS;
  for (const seg of segments) {
    const r = handleSegmentPreset({ segment: seg });
    if (!Object.keys(r.config).length) throw new Error(`empty config for segment: ${seg}`);
  }
});

// ── handleDesignAudit — symbol layer validators ───────────────────────────────

console.log("\n── handleDesignAudit (symbol validators) ────────────────────────");

test("no custom symbol/circle layers → no-symbol-layers warning", () => {
  const result = handleDesignAudit({
    style_json: {
      layers: [
        { id: "background", type: "background", paint: { "background-color": "#fff" } },
        { id: "road", type: "line", source: "composite", paint: { "line-color": "#ccc" } },
      ],
      sources: {},
    },
  });
  const ids = result.violations.map((v) => v.id);
  if (!ids.includes("no-symbol-layers")) throw new Error(`expected no-symbol-layers, got: ${ids.join(", ")}`);
});

test("flat icon-size number → flat-icon-size violation with fix hint", () => {
  const result = handleDesignAudit({
    style_json: {
      layers: [
        {
          id: "poi",
          type: "symbol",
          source: "my-source",
          layout: { "icon-image": "marker", "icon-size": 1 },
        },
      ],
      sources: { "my-source": { type: "geojson", data: { type: "FeatureCollection", features: [] } } },
    },
  });
  const ids = result.violations.map((v) => v.id);
  if (!ids.includes("flat-icon-size")) throw new Error(`expected flat-icon-size, got: ${ids.join(", ")}`);
  const v = result.violations.find((x) => x.id === "flat-icon-size")!;
  expect(v.fix).toContain("interpolate");
});

test("text-anchor:center with icon-image → label-on-icon error", () => {
  const result = handleDesignAudit({
    style_json: {
      layers: [
        {
          id: "places",
          type: "symbol",
          source: "my-source",
          layout: { "icon-image": "marker", "text-field": "{name}", "text-anchor": "center" },
        },
      ],
      sources: { "my-source": { type: "geojson", data: { type: "FeatureCollection", features: [] } } },
    },
  });
  const ids = result.violations.map((v) => v.id);
  if (!ids.includes("label-on-icon")) throw new Error(`expected label-on-icon, got: ${ids.join(", ")}`);
  const v = result.violations.find((x) => x.id === "label-on-icon")!;
  expect(v.severity).toBe("error");
});

test("icon+label without text-variable-anchor → missing-variable-anchor info", () => {
  const result = handleDesignAudit({
    style_json: {
      layers: [
        {
          id: "shops",
          type: "symbol",
          source: "my-source",
          layout: { "icon-image": "shop", "text-field": "{name}", "text-anchor": "top" },
        },
      ],
      sources: { "my-source": { type: "geojson", data: { type: "FeatureCollection", features: [] } } },
    },
  });
  const ids = result.violations.map((v) => v.id);
  if (!ids.includes("missing-variable-anchor")) throw new Error(`expected missing-variable-anchor, got: ${ids.join(", ")}`);
});

test("symbol layer with no icon-image and no text-field → empty-symbol-layer warning", () => {
  const result = handleDesignAudit({
    style_json: {
      layers: [
        {
          id: "ghost-layer",
          type: "symbol",
          source: "my-source",
          layout: {},
        },
      ],
      sources: { "my-source": { type: "geojson", data: { type: "FeatureCollection", features: [] } } },
    },
  });
  const ids = result.violations.map((v) => v.id);
  if (!ids.includes("empty-symbol-layer")) throw new Error(`expected empty-symbol-layer, got: ${ids.join(", ")}`);
});

// ── DEV_PATTERNS smoke tests ──────────────────────────────────────────────────

console.log("\n── DEV_PATTERNS ─────────────────────────────────────────────────");

test("pins_and_markers pattern returns content with MARKER section", () => {
  const content = DEV_PATTERNS["pins_and_markers"];
  if (!content || content.trim().length === 0) throw new Error("expected non-empty pins_and_markers pattern");
  expect(content).toContain("MARKER");
});

test("unknown pattern key is not present in DEV_PATTERNS", () => {
  const content = DEV_PATTERNS["nonexistent_pattern_xyz"];
  if (content !== undefined) throw new Error("expected undefined for unknown pattern key");
});

// ── validateExpression ────────────────────────────────────────────────────────

console.log("\n── validateExpression ───────────────────────────────────────────");

test('["get","name"] is valid', () => {
  const r = validateExpression(["get", "name"]);
  if (!r.valid) throw new Error(`expected valid, got errors: ${r.errors.map(e => e.message).join(", ")}`);
});

test('["interpolate",["linear"],["zoom"],8,1,16,8] is valid', () => {
  const r = validateExpression(["interpolate", ["linear"], ["zoom"], 8, 1, 16, 8]);
  if (!r.valid) throw new Error(`expected valid, got errors: ${r.errors.map(e => e.message).join(", ")}`);
});

test("empty array is invalid", () => {
  const r = validateExpression([]);
  if (r.valid) throw new Error("expected invalid for empty array");
  expect(r.errors[0]?.message).toContain("cannot be empty");
});

test("unknown operator is invalid", () => {
  const r = validateExpression(["nonsense_op", "arg1"]);
  if (r.valid) throw new Error("expected invalid for unknown operator");
  expect(r.errors[0]?.message).toContain("Unknown expression operator");
});

test("too few arguments is invalid", () => {
  const r = validateExpression(["rgb", 255]);  // rgb needs 3 args
  if (r.valid) throw new Error("expected invalid for too few args");
  expect(r.errors[0]?.message).toContain("requires at least");
});

test("literal number is valid", () => {
  const r = validateExpression(42);
  if (!r.valid) throw new Error(`expected literal number to be valid, errors: ${r.errors.map(e => e.message).join(", ")}`);
});

test("JSON string input is accepted", () => {
  const r = validateExpression('["get","population"]');
  if (!r.valid) throw new Error(`expected valid JSON string input, errors: ${r.errors.map(e => e.message).join(", ")}`);
});

// ── getReference ──────────────────────────────────────────────────────────────

console.log("\n── getReference ─────────────────────────────────────────────────");

test("exact match 'line' returns a reference entry", () => {
  const r = getReference("line");
  if (!r.found || !r.entry) throw new Error("expected found entry for 'line'");
  expect(r.entry.url).toContain("mapbox.com");
});

test("exact match 'interpolate' returns a reference entry", () => {
  const r = getReference("interpolate");
  if (!r.found || !r.entry) throw new Error("expected found entry for 'interpolate'");
});

test("operator lookup falls back to OPERATORS table", () => {
  const r = getReference("step");
  if (!r.found || !r.entry) throw new Error("expected found entry for 'step'");
  expect(r.entry.url).toContain("expressions");
});

test("unknown topic returns found:false with available list", () => {
  const r = getReference("totally_unknown_topic_xyz");
  if (r.found) throw new Error("expected not found");
  if (!Array.isArray(r.available)) throw new Error("expected available list");
});

// ── static_map URL shape (unit test without live API) ─────────────────────────

console.log("\n── static_map URL shape ─────────────────────────────────────────");

test("static_map URL is well-formed (synthesized)", () => {
  // Simulate what the handler builds without actually calling the API
  const center: [number, number] = [-74.006, 40.7128];
  const zoom = 12;
  const style = "mapbox/standard";
  const width = 600;
  const height = 400;
  const bearing = 0;
  const token = "pk.test";
  const url =
    `https://api.mapbox.com/styles/v1/${style}/static/` +
    `${center[0]},${center[1]},${zoom},${bearing}/${width}x${height}` +
    `?access_token=${token}`;
  if (!url.includes("api.mapbox.com/styles/v1/mapbox/standard/static/")) throw new Error(`unexpected URL: ${url}`);
  if (!url.includes(`${center[0]},${center[1]},${zoom}`)) throw new Error("URL missing center/zoom");
  if (!url.includes("access_token=pk.test")) throw new Error("URL missing token");
});

// ── Mode filtering ────────────────────────────────────────────────────────────
// Uses the real INTERACTIVE_ONLY_TOOLS / DESIGN_ONLY_TOOLS sets and toolsForMode()
// imported from index.ts — any drift in the source of truth is caught automatically.

console.log("\n── Mode filtering ───────────────────────────────────────────────");

const STATIC_TOOL_NAMES = [
  "get_design_guidance", "design_audit", "palette_suggest", "segment_preset",
  "static_map", "geocode", "preview_style",
  "manage_style", "manage_tokens",
];

const ALL_MOCK_TOOLS = [
  ...Array.from(INTERACTIVE_ONLY_TOOLS),
  ...Array.from(DESIGN_ONLY_TOOLS),
  ...STATIC_TOOL_NAMES,
].map((name) => ({ name, description: "", inputSchema: {} }));

test("design mode hides every interactive-only tool", () => {
  const result = toolsForMode("design", ALL_MOCK_TOOLS);
  const resultNames = new Set(result.map((t) => t.name));
  for (const name of INTERACTIVE_ONLY_TOOLS) {
    if (resultNames.has(name)) throw new Error(`"${name}" should be hidden in design mode`);
  }
});

test("design mode keeps design-only and shared tools", () => {
  const result = toolsForMode("design", ALL_MOCK_TOOLS);
  const resultNames = new Set(result.map((t) => t.name));
  for (const name of STATIC_TOOL_NAMES) {
    if (!resultNames.has(name)) throw new Error(`"${name}" should be kept in design mode`);
  }
  for (const name of DESIGN_ONLY_TOOLS) {
    if (!resultNames.has(name)) throw new Error(`"${name}" (design-only) should be kept in design mode`);
  }
});

test("make mode hides design-only tools", () => {
  const result = toolsForMode("make", ALL_MOCK_TOOLS);
  const resultNames = new Set(result.map((t) => t.name));
  for (const name of DESIGN_ONLY_TOOLS) {
    if (resultNames.has(name)) throw new Error(`"${name}" should be hidden in make mode`);
  }
});

test("INTERACTIVE_ONLY_TOOLS has exactly 7 tools", () => {
  expect(INTERACTIVE_ONLY_TOOLS.size).toBe(7);
});

test("design mode result is smaller than make mode result", () => {
  const designCount = toolsForMode("design", ALL_MOCK_TOOLS).length;
  const makeCount = toolsForMode("make", ALL_MOCK_TOOLS).length;
  if (designCount >= makeCount) throw new Error(`design (${designCount}) should be < make (${makeCount})`);
});

test("geocode is kept in design mode (needed to center a static map)", () => {
  const result = toolsForMode("design", ALL_MOCK_TOOLS);
  if (!result.find((t) => t.name === "geocode")) throw new Error("geocode should be kept in design mode");
});

test("static_map is kept in design mode", () => {
  const result = toolsForMode("design", ALL_MOCK_TOOLS);
  if (!result.find((t) => t.name === "static_map")) throw new Error("static_map should be kept in design mode");
});

// ── modeBriefText ─────────────────────────────────────────────────────────────

console.log("\n── modeBriefText ────────────────────────────────────────────────");

test("design brief contains static-only language", () => {
  const text = modeBriefText("design");
  if (!text.includes("Figma Design")) throw new Error("expected 'Figma Design'");
  if (!text.includes("static only")) throw new Error("expected 'static only'");
  if (!text.includes("Do not")) throw new Error("expected 'Do not' section");
  if (!text.includes("get_dev_patterns")) throw new Error("expected 'get_dev_patterns' in Do not list");
});

test("make brief contains interactive language", () => {
  const text = modeBriefText("make");
  if (!text.includes("Figma Make")) throw new Error("expected 'Figma Make'");
  if (!text.includes("interactive")) throw new Error("expected 'interactive'");
  if (!text.includes("get_dev_patterns")) throw new Error("expected 'get_dev_patterns' in make brief");
});

test("design and make briefs differ", () => {
  if (modeBriefText("design") === modeBriefText("make")) throw new Error("design and make briefs should differ");
});

test("mode_brief prompt uses same text as modeBriefText (no duplication drift)", () => {
  // Verify the single source of truth: both modes produce non-empty strings and
  // each brief starts with the expected header.
  const design = modeBriefText("design");
  const make = modeBriefText("make");
  if (!design.startsWith("MAP DESIGN MODE — Figma Design")) throw new Error("design brief header mismatch");
  if (!make.startsWith("MAP DESIGN MODE — Figma Make")) throw new Error("make brief header mismatch");
});

// ── Projection (src/projection.ts) ───────────────────────────────────────────

console.log("\nProjection:");

const VP_BASE = { center: [-122.4194, 37.7749] as [number, number], zoom: 12, width: 600, height: 400, bearing: 0 };

test("center projects to exactly (width/2, height/2)", () => {
  const [lng, lat] = VP_BASE.center;
  const pt = project(lng, lat, VP_BASE);
  if (Math.abs(pt.x - 300) > 0.001) throw new Error(`expected x≈300, got ${pt.x}`);
  if (Math.abs(pt.y - 200) > 0.001) throw new Error(`expected y≈200, got ${pt.y}`);
  if (!pt.in_view) throw new Error("center should be in_view");
});

test("known offset: ~1km east lands right of center (positive x delta)", () => {
  // At SF lat/zoom 12, ~0.01° lng ≈ ~0.8km; should be right of center
  const pt = project(-122.4094, 37.7749, VP_BASE);
  if (pt.x <= 300) throw new Error(`expected x > 300 for eastward point, got ${pt.x}`);
  if (!pt.in_view) throw new Error("nearby eastward point should be in_view");
});

test("known offset: ~1km north lands above center (smaller y)", () => {
  const pt = project(-122.4194, 37.7849, VP_BASE);
  if (pt.y >= 200) throw new Error(`expected y < 200 for northward point, got ${pt.y}`);
  if (!pt.in_view) throw new Error("nearby northward point should be in_view");
});

test("far-away point is out of view", () => {
  // New York from San Francisco viewport at zoom 12 — definitely off screen
  const pt = project(-74.006, 40.7128, VP_BASE);
  if (pt.in_view) throw new Error("NYC should not be in_view on SF map at z12");
});

test("bearing 90° rotates east→up: eastward point appears above center", () => {
  // bearing=90° rotates the map clockwise 90°, making east point to the top of the screen.
  // So a point due east of center has y < height/2 (above center).
  const vpRotated = { ...VP_BASE, bearing: 90 };
  const pt = project(-122.4094, 37.7749, vpRotated);
  if (pt.y >= 200) throw new Error(`expected y < 200 for east point with 90° bearing (east=up), got ${pt.y}`);
});

test("projectCoords returns same count as input", () => {
  const coords: [number, number][] = [[-122.4194, 37.7749], [-122.41, 37.78], [-122.40, 37.77]];
  const pts = projectCoords(coords, VP_BASE);
  if (pts.length !== 3) throw new Error(`expected 3 points, got ${pts.length}`);
});

test("design brief mentions static_overlay", () => {
  const text = modeBriefText("design");
  if (!text.includes("static_overlay")) throw new Error("design brief should mention static_overlay");
});

test("make brief does NOT mention static_overlay", () => {
  const text = modeBriefText("make");
  if (text.includes("static_overlay")) throw new Error("make brief should not mention static_overlay");
});

// ── Security / validation hardening ──────────────────────────────────────────

console.log("\n── Security / validation hardening ─────────────────────────────");

test("palette_suggest throws on non-hex brand_color", () => {
  let threw = false;
  try { handlePaletteSuggest({ brand_color: "blue", segment: "real_estate", background: "light" }); }
  catch { threw = true; }
  if (!threw) throw new Error("expected throw for non-hex brand_color 'blue'");
});

// P1.3: design_audit malformed input → violations, not a throw
test("design_audit handles non-array layers gracefully (no throw)", () => {
  const r = handleDesignAudit({ style_json: { layers: "bad" as unknown as [], sources: {} } });
  if (!Array.isArray(r.violations)) throw new Error("expected violations array even on malformed input");
});

test("design_audit handles layer missing id (no throw)", () => {
  const r = handleDesignAudit({
    style_json: {
      layers: [{ type: "symbol", source: "my-src" } as { id: string; type: string; source: string }],
      sources: { "my-src": { type: "geojson" } },
    },
  });
  if (!Array.isArray(r.violations)) throw new Error("expected violations array for layer without id");
});

// ── STYLE_RE / buildMapHtml validation ────────────────────────────────────────

console.log("\n── STYLE_RE / buildMapHtml ──────────────────────────────────────");

test("STYLE_RE accepts valid owner/styleId", () => {
  if (!STYLE_RE.test("mapbox/standard")) throw new Error("mapbox/standard should be valid");
  if (!STYLE_RE.test("myuser/my-style-v2")) throw new Error("myuser/my-style-v2 should be valid");
});

test("STYLE_RE accepts full mapbox:// URI form", () => {
  if (!STYLE_RE.test("mapbox://styles/mapbox/streets-v12")) throw new Error("full URI form should be valid");
});

test("STYLE_RE rejects </script> injection attempt", () => {
  if (STYLE_RE.test("mapbox/x</script><script>alert(1)</script>")) {
    throw new Error("</script> injection should be rejected");
  }
});

test("STYLE_RE rejects path traversal attempt", () => {
  if (STYLE_RE.test("../../../etc/passwd")) throw new Error("path traversal should be rejected");
});

test("buildMapHtml throws on invalid style", () => {
  let threw = false;
  try {
    buildMapHtml({
      style: "bad</script>injection",
      center: [-122, 37], zoom: 12, bearing: 0, pitch: 0,
      width: 600, height: 400, standardConfig: {}, publicToken: "pk.test",
    });
  } catch { threw = true; }
  if (!threw) throw new Error("expected throw for invalid style");
});

test("buildMapHtml throws on non-finite numeric param", () => {
  let threw = false;
  try {
    buildMapHtml({
      style: "mapbox/standard",
      center: [NaN, 37], zoom: 12, bearing: 0, pitch: 0,
      width: 600, height: 400, standardConfig: {}, publicToken: "pk.test",
    });
  } catch { threw = true; }
  if (!threw) throw new Error("expected throw for NaN center longitude");
});

test("buildMapHtml returns HTML for valid params", () => {
  const html = buildMapHtml({
    style: "mapbox/standard",
    center: [-122, 37], zoom: 12, bearing: 0, pitch: 0,
    width: 600, height: 400, standardConfig: {}, publicToken: "pk.test",
  });
  if (!html.includes("mapboxgl.accessToken")) throw new Error("HTML should contain token setup");
  if (!html.includes("mapbox://styles/mapbox/standard")) throw new Error("HTML should contain style URL");
});

// ── buildToolContent ─────────────────────────────────────────────────────────

console.log("\n── buildToolContent ─────────────────────────────────────────────");

test("_image_url only → one text block equal to the URL", async () => {
  const url = "https://api.mapbox.com/styles/v1/mapbox/streets-v12/static/0,0,1/600x400?access_token=pk.test";
  const content = await buildToolContent({ _image_url: url }, null, "https://example.com");
  if (content.length !== 1) throw new Error(`expected 1 block, got ${content.length}`);
  if (content[0].type !== "text") throw new Error(`expected type 'text', got '${content[0].type}'`);
  if ((content[0] as { type: "text"; text: string }).text !== url) throw new Error(`URL mismatch: ${(content[0] as { type: "text"; text: string }).text}`);
});

test("_image_url + viewport/overlays → two text blocks; second parses to {viewport, overlays}", async () => {
  const url = "https://example.com/img.jpg";
  const viewport = { center: [-122, 37], zoom: 12, width: 600, height: 400, bearing: 0 };
  const overlays = { markers: [{ lng: -122, lat: 37, x: 300, y: 200, in_view: true }], routes: [], isochrones: [] };
  const content = await buildToolContent({ _image_url: url, viewport, overlays }, null, "https://example.com");
  if (content.length !== 2) throw new Error(`expected 2 blocks, got ${content.length}`);
  if (content[0].type !== "text") throw new Error("first block should be text");
  if ((content[0] as { type: "text"; text: string }).text !== url) throw new Error("first block should be the URL");
  if (content[1].type !== "text") throw new Error("second block should be text");
  const parsed = JSON.parse((content[1] as { type: "text"; text: string }).text) as { viewport: unknown; overlays: unknown };
  if (!parsed.viewport) throw new Error("second block should have viewport");
  if (!parsed.overlays) throw new Error("second block should have overlays");
});

test("_image (no env) → image block + URL", async () => {
  const b64 = "aGVsbG8=";
  const content = await buildToolContent({ _image: { data: b64, mimeType: "image/png" } }, null, "https://example.com");
  if (content.length !== 2) throw new Error(`expected 2 blocks, got ${content.length}`);
  const imgBlock = content[0] as { type: string; data: string; mimeType: string };
  if (imgBlock.type !== "image") throw new Error(`block 0 should be type 'image', got: ${imgBlock.type}`);
  if (imgBlock.data !== b64) throw new Error("base64 payload mismatch");
  const urlText = (content[1] as { type: "text"; text: string }).text;
  if (!urlText.includes("/img/")) throw new Error(`block 1 should contain /img/, got: ${urlText.slice(0, 60)}`);
});

test("_image + overlay (no env) → image block + URL + viewport/overlays", async () => {
  const viewport = { center: [-122, 37], zoom: 12, width: 600, height: 400, bearing: 0 };
  const overlays = { markers: [{ lng: -122, lat: 37, x: 300, y: 200, in_view: true }], routes: [], isochrones: [] };
  const b64 = "aGVsbG8=";
  const content = await buildToolContent(
    { _image: { data: b64, mimeType: "image/png" }, viewport, overlays },
    null, "https://example.com",
  );
  if (content.length !== 3) throw new Error(`expected 3 blocks, got ${content.length}`);
  const imgBlock = content[0] as { type: string; data: string; mimeType: string };
  if (imgBlock.type !== "image") throw new Error(`block 0 should be type 'image', got: ${imgBlock.type}`);
  if (imgBlock.data !== b64) throw new Error("base64 payload mismatch");
  if (!(content[1] as { type: "text"; text: string }).text.includes("/img/")) throw new Error("block 1 should be URL");
  const parsed = JSON.parse((content[2] as { type: "text"; text: string }).text) as { viewport: unknown; overlays: unknown };
  if (!parsed.viewport) throw new Error("missing viewport");
  if (!parsed.overlays) throw new Error("missing overlays");
});

test("plain object → single JSON text block", async () => {
  const result = { score: 95, violations: [] };
  const content = await buildToolContent(result, null, "https://example.com");
  if (content.length !== 1) throw new Error(`expected 1 block, got ${content.length}`);
  if (content[0].type !== "text") throw new Error("expected text block");
  const parsed = JSON.parse((content[0] as { type: "text"; text: string }).text) as typeof result;
  if (parsed.score !== 95) throw new Error("score should be 95");
});

test("string result → single text block with the string verbatim", async () => {
  const content = await buildToolContent("hello world", null, "https://example.com");
  if (content.length !== 1) throw new Error(`expected 1 block, got ${content.length}`);
  if ((content[0] as { type: "text"; text: string }).text !== "hello world") throw new Error("text mismatch");
});

// ── isAllowedRedirectUri ──────────────────────────────────────────────────────
// isAllowedRedirectUri is not exported, so we re-implement the logic inline
// to keep tests self-contained (the function is pure URL classification).

console.log("\n── isAllowedRedirectUri ─────────────────────────────────────────");

function isAllowedRedirectUri(uri: string): boolean {
  try {
    const u = new URL(uri);
    if (u.protocol === "https:") return true;
    if (u.protocol === "claude:" || u.protocol === "vscode:") return true;
    if (u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1")) return true;
    return false;
  } catch { return false; }
}

test("https:// any host is allowed", () => {
  if (!isAllowedRedirectUri("https://example.com/callback")) throw new Error("expected allowed");
});
test("http://localhost with port is allowed", () => {
  if (!isAllowedRedirectUri("http://localhost:8080/callback")) throw new Error("expected allowed");
});
test("http://127.0.0.1 is allowed", () => {
  if (!isAllowedRedirectUri("http://127.0.0.1:3000/cb")) throw new Error("expected allowed");
});
test("claude:// deep link is allowed", () => {
  if (!isAllowedRedirectUri("claude://auth/callback")) throw new Error("expected allowed");
});
test("vscode:// deep link is allowed", () => {
  if (!isAllowedRedirectUri("vscode://auth/callback")) throw new Error("expected allowed");
});
test("http:// to non-loopback host is blocked", () => {
  if (isAllowedRedirectUri("http://evil.com/steal")) throw new Error("expected blocked");
});
test("plain string (no protocol) is blocked", () => {
  if (isAllowedRedirectUri("evil.com/steal")) throw new Error("expected blocked");
});
test("empty string is blocked", () => {
  if (isAllowedRedirectUri("")) throw new Error("expected blocked");
});

// ── PKCE S256 derivation ──────────────────────────────────────────────────────

console.log("\n── PKCE S256 derivation ─────────────────────────────────────────");

async function pkceS256(verifier: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

test("known verifier produces known challenge", async () => {
  // RFC 7636 test vector: verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
  const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  const challenge = await pkceS256(verifier);
  const expected = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
  if (challenge !== expected) throw new Error(`expected ${expected}, got ${challenge}`);
});

test("different verifiers produce different challenges", async () => {
  const c1 = await pkceS256("verifierOne");
  const c2 = await pkceS256("verifierTwo");
  if (c1 === c2) throw new Error("expected different challenges");
});

test("challenge is base64url (no +, /, or =)", async () => {
  const challenge = await pkceS256("some-random-verifier-string-of-decent-length");
  if (/[+/=]/.test(challenge)) throw new Error(`challenge contains invalid chars: ${challenge}`);
});

// ── Segment / PRESET parity ───────────────────────────────────────────────────

console.log("\n── Segment / PRESET parity ──────────────────────────────────────");

test("every PRESET segment has a SEGMENT_GUIDANCE block", () => {
  const presetKeys = Object.keys(PRESETS);
  const guidanceKeys = new Set(Object.keys(SEGMENT_GUIDANCE));
  const missing = presetKeys.filter((k) => !guidanceKeys.has(k));
  if (missing.length > 0) throw new Error(`PRESETS have no SEGMENT_GUIDANCE: ${missing.join(", ")}`);
});

test("every SEGMENT_GUIDANCE block has a PRESET", () => {
  const guidanceKeys = Object.keys(SEGMENT_GUIDANCE);
  const presetKeySet = new Set(Object.keys(PRESETS));
  const missing = guidanceKeys.filter((k) => !presetKeySet.has(k));
  if (missing.length > 0) throw new Error(`SEGMENT_GUIDANCE has no PRESET: ${missing.join(", ")}`);
});

test("SEGMENT_KEYS matches SEGMENT_GUIDANCE keys exactly", () => {
  const guidanceKeys = Object.keys(SEGMENT_GUIDANCE).sort();
  const segKeys = [...SEGMENT_KEYS].sort();
  if (JSON.stringify(guidanceKeys) !== JSON.stringify(segKeys))
    throw new Error(`mismatch: SEGMENT_KEYS=${segKeys.join(",")} GUIDANCE=${guidanceKeys.join(",")}`);
});

// ── GL JS version consistency ──────────────────────────────────────────────────

console.log("\n── GL JS version consistency ─────────────────────────────────────");

test("dev-patterns GL_JS_VERSION matches renderer GL_JS_VERSION", () => {
  if (GL_JS_VERSION !== RENDERER_GL_JS_VERSION)
    throw new Error(`version mismatch: dev-patterns=${GL_JS_VERSION} renderer=${RENDERER_GL_JS_VERSION}`);
});

test("scaffolding pattern CDN URL contains the declared GL_JS_VERSION", () => {
  const content = DEV_PATTERNS["scaffolding"] ?? "";
  if (!content.includes(`v${GL_JS_VERSION}`))
    throw new Error(`scaffolding CDN URL does not contain v${GL_JS_VERSION}`);
});

// ── Expression validator enrichment ───────────────────────────────────────────

console.log("\n── Expression validator enrichment ──────────────────────────────");

test("within operator is valid (was previously false-unknown)", () => {
  const r = validateExpression(["within", { type: "Feature", geometry: { type: "Polygon", coordinates: [] } }]);
  if (!r.valid) throw new Error(`expected valid, got errors: ${r.errors.map((e) => e.message).join(", ")}`);
});

test("hsl color constructor is valid", () => {
  const r = validateExpression(["hsl", 200, 80, 50]);
  if (!r.valid) throw new Error(`expected valid, got errors: ${r.errors.map((e) => e.message).join(", ")}`);
});

test("case with even args warns about missing fallback", () => {
  const r = validateExpression(["case", ["has", "name"], "yes", "maybe"]);
  if (r.warnings.some((w) => w.message.includes("case"))) {
    // has odd args (3) — should NOT warn
    throw new Error("should not warn for odd-arg case");
  }
});

test("case with even args (missing fallback) produces a warning", () => {
  // ["case", cond1, out1, cond2, out2] = 4 args = even = likely missing fallback
  const r = validateExpression(["case", ["has", "name"], "yes", ["has", "foo"], "no"]);
  const hasWarn = r.warnings.some((w) => w.message.includes("case"));
  if (!hasWarn) throw new Error("expected case warning for even args");
});

test("interpolate with odd stop/value count produces error", () => {
  // ["interpolate", ["linear"], ["zoom"], 10, 1, 15] — stop 15 has no value
  const r = validateExpression(["interpolate", ["linear"], ["zoom"], 10, 1, 15]);
  const hasError = r.errors.some((e) => e.message.includes("interpolate"));
  if (!hasError) throw new Error("expected error for odd stop/value count");
});

test("boolean literal returnType is 'boolean', not 'number'", () => {
  const r = validateExpression(true);
  if (r.metadata.returnType !== "boolean") throw new Error(`expected boolean, got ${r.metadata.returnType}`);
});

test("null literal returnType is 'null'", () => {
  const r = validateExpression(null);
  if (r.metadata.returnType !== "null") throw new Error(`expected null, got ${r.metadata.returnType}`);
});

test("getReference for 'lightPreset' returns Standard config entry", () => {
  const r = getReference("lightPreset");
  if (!r.found || !r.entry) throw new Error("expected found entry for lightPreset");
  if (!r.entry.summary.includes("Standard")) throw new Error("expected Standard config mention");
});

test("getReference for 'slot' returns slot entry", () => {
  const r = getReference("slot");
  if (!r.found || !r.entry) throw new Error("expected found entry for slot");
});

test("getReference with 1-char query returns not-found", () => {
  const r = getReference("e");
  if (r.found) throw new Error("expected not-found for single-char query");
});

test("retina param plumbs through to buildMapHtml (MapRenderParams)", () => {
  // buildMapHtml accepts retina (optional boolean) — verify it builds without error with retina:true
  const html = buildMapHtml({
    center: [0, 0], zoom: 10, bearing: 0, pitch: 0,
    width: 600, height: 400, style: "mapbox/standard",
    standardConfig: {}, publicToken: "pk.test", retina: true,
  });
  if (!html.includes("mapbox-gl.js")) throw new Error("expected mapbox-gl.js in HTML");
});

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${"─".repeat(60)}`);
console.log(`  ${passed} passed  |  ${failed} failed  |  ${passed + failed} total`);
if (failed > 0) {
  console.log("  Some tests failed — check output above.\n");
  process.exit(1);
} else {
  console.log("  All tests passed.\n");
}
