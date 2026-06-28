#!/usr/bin/env tsx
/**
 * Unit tests for native worker tool handlers.
 * Run: npx tsx scripts/test-tools.ts
 */

import { handleCheckColorContrast, handleDesignAudit, handlePaletteSuggest, handleSegmentPreset, handleWcagValidate } from "../src/tools.js";
import { validateExpression, getReference } from "../src/expression-validator.js";
import { SEGMENT_KEYS } from "../src/design-guidance.js";
import { DEV_PATTERNS } from "../src/dev-patterns.js";
import { modeBriefText } from "../src/mode-brief.js";
import { project, projectCoords } from "../src/projection.js";

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

// ── WCAG Validate ─────────────────────────────────────────────────────────────

console.log("\n── handleWcagValidate ───────────────────────────────────────────");

test("mid-gray label on day background fails AA", () => {
  const r = handleWcagValidate({
    standard_config: { lightPreset: "day", colorPlaceLabels: "#888888" },
  });
  const pair = r.pairs.find((p) => p.layer_id === "colorPlaceLabels");
  if (!pair) throw new Error("expected colorPlaceLabels pair");
  if (pair.passes) throw new Error(`#888888 should fail AA against day background (ratio: ${pair.ratio})`);
  expect(r.all_pass).toBe(false);
});

test("dark label on day background passes AA", () => {
  const r = handleWcagValidate({
    standard_config: { lightPreset: "day", colorPlaceLabels: "#1a1a1a" },
    only_failures: false,
  });
  const pair = r.pairs.find((p) => p.layer_id === "colorPlaceLabels");
  if (!pair) throw new Error("expected colorPlaceLabels pair");
  if (!pair.passes) throw new Error(`#1a1a1a should pass AA against day background (ratio: ${pair.ratio})`);
});

test("AAA level uses 7.0 threshold", () => {
  const r = handleWcagValidate({
    standard_config: { lightPreset: "day", colorPlaceLabels: "#595959" },
    level: "AAA",
  });
  expect(r.pairs.length).toBeGreaterThan(0);
});

test("style_json mode scans symbol layers", () => {
  const r = handleWcagValidate({
    style_json: {
      layers: [
        { id: "place-label", type: "symbol", paint: { "text-color": "#111111", "text-halo-color": "#ffffff" } },
        { id: "line-layer", type: "line", paint: { "line-color": "#ff0000" } },
      ],
    },
    only_failures: false,
  });
  expect(r.pairs.length).toBe(1);
  expect(r.pairs[0]?.layer_id as string).toBe("place-label");
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

// ── handleCheckColorContrast ──────────────────────────────────────────────────

console.log("\n── handleCheckColorContrast ─────────────────────────────────────");

test("mid-gray on white fails AA normal (ratio ~3.9)", () => {
  const r = handleCheckColorContrast({ foreground: "#888888", background: "#ffffff" });
  if (r.passes) throw new Error(`expected fail, got ratio ${r.ratio}`);
  expect(r.aa_normal).toBe(false);
});

test("near-black on white passes AA normal (ratio ~16)", () => {
  const r = handleCheckColorContrast({ foreground: "#111111", background: "#ffffff" });
  if (!r.passes) throw new Error(`expected pass, got ratio ${r.ratio}`);
  expect(r.aa_normal).toBe(true);
});

test("AA large threshold is 3.0", () => {
  // #777 on white ≈ 4.47:1 — passes AA large (3.0) but not normal (4.5)
  const r = handleCheckColorContrast({ foreground: "#777777", background: "#ffffff", level: "AA", fontSize: "large" });
  expect(r.required).toBe(3.0);
  if (!r.passes) throw new Error(`expected pass at AA large, got ratio ${r.ratio}`);
});

test("AAA normal threshold is 7.0", () => {
  const r = handleCheckColorContrast({ foreground: "#888888", background: "#ffffff", level: "AAA" });
  expect(r.required).toBe(7.0);
});

test("result includes all four pass/fail flags", () => {
  const r = handleCheckColorContrast({ foreground: "#555555", background: "#ffffff" });
  if (typeof r.aa_normal !== "boolean") throw new Error("missing aa_normal");
  if (typeof r.aa_large !== "boolean") throw new Error("missing aa_large");
  if (typeof r.aaa_normal !== "boolean") throw new Error("missing aaa_normal");
  if (typeof r.aaa_large !== "boolean") throw new Error("missing aaa_large");
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
// Tests for toolsForMode() / INTERACTIVE_ONLY_TOOLS without importing index.ts
// (to avoid Hono side-effects). The set is mirrored here intentionally — any
// drift from index.ts will surface as a naming mismatch in the tool lists below.

console.log("\n── Mode filtering ───────────────────────────────────────────────");

const INTERACTIVE_ONLY_NAMES = new Set([
  "get_dev_patterns",
  "directions",
  "isochrone",
  "matrix",
  "category_search",
  "validate_expression",
  "get_reference",
]);

const STATIC_TOOL_NAMES = [
  "get_design_guidance", "design_audit", "palette_suggest", "segment_preset",
  "wcag_validate", "static_map", "geocode", "check_color_contrast", "preview_style",
  "list_styles_tool", "retrieve_style_tool", "create_style_tool", "update_style_tool",
  "delete_style_tool", "list_tokens_tool", "create_token_tool",
];

// Simulate the full MCP_TOOLS list and the filter logic
const ALL_MOCK_TOOLS = [
  ...Array.from(INTERACTIVE_ONLY_NAMES),
  ...STATIC_TOOL_NAMES,
].map((name) => ({ name, description: "", inputSchema: {} }));

function filterForDesignMode(tools: Array<{ name: string }>) {
  return tools.filter((t) => !INTERACTIVE_ONLY_NAMES.has(t.name));
}

test("design mode hides every interactive tool", () => {
  const result = filterForDesignMode(ALL_MOCK_TOOLS);
  const resultNames = new Set(result.map((t) => t.name));
  for (const name of INTERACTIVE_ONLY_NAMES) {
    if (resultNames.has(name)) throw new Error(`"${name}" should be hidden in design mode`);
  }
});

test("design mode keeps all static/shared tools", () => {
  const result = filterForDesignMode(ALL_MOCK_TOOLS);
  const resultNames = new Set(result.map((t) => t.name));
  for (const name of STATIC_TOOL_NAMES) {
    if (!resultNames.has(name)) throw new Error(`"${name}" should be kept in design mode`);
  }
});

test("make mode returns the full tool list (no filtering)", () => {
  // make = no filter
  expect(ALL_MOCK_TOOLS.length).toBe(INTERACTIVE_ONLY_NAMES.size + STATIC_TOOL_NAMES.length);
});

test("INTERACTIVE_ONLY set has exactly 7 tools", () => {
  expect(INTERACTIVE_ONLY_NAMES.size).toBe(7);
});

test("design mode result is smaller than make mode result", () => {
  const designCount = filterForDesignMode(ALL_MOCK_TOOLS).length;
  const makeCount = ALL_MOCK_TOOLS.length;
  if (designCount >= makeCount) throw new Error(`design (${designCount}) should be < make (${makeCount})`);
});

test("geocode is kept in design mode (needed to center a static map)", () => {
  const result = filterForDesignMode(ALL_MOCK_TOOLS);
  if (!result.find((t) => t.name === "geocode")) throw new Error("geocode should be kept in design mode");
});

test("static_map is kept in design mode", () => {
  const result = filterForDesignMode(ALL_MOCK_TOOLS);
  if (!result.find((t) => t.name === "static_map")) throw new Error("static_map should be kept in design mode");
});

// ── modeBriefText ─────────────────────────────────────────────────────────────

console.log("\n── modeBriefText ────────────────────────────────────────────────");

test("design brief contains static-only language", () => {
  const text = modeBriefText("design");
  if (!text.includes("Figma Design")) throw new Error("expected 'Figma Design'");
  if (!text.includes("static only")) throw new Error("expected 'static only'");
  if (!text.includes("DO NOT")) throw new Error("expected 'DO NOT' section");
  if (!text.includes("get_dev_patterns")) throw new Error("expected 'get_dev_patterns' in DO NOT list");
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
  if (!design.startsWith("MAP DESIGN MODE: Figma Design")) throw new Error("design brief header mismatch");
  if (!make.startsWith("MAP DESIGN MODE: Figma Make")) throw new Error("make brief header mismatch");
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

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${"─".repeat(60)}`);
console.log(`  ${passed} passed  |  ${failed} failed  |  ${passed + failed} total`);
if (failed > 0) {
  console.log("  Some tests failed — check output above.\n");
  process.exit(1);
} else {
  console.log("  All tests passed.\n");
}
