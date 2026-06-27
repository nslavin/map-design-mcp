#!/usr/bin/env tsx
/**
 * Unit tests for native worker tool handlers.
 * Run: npx tsx scripts/test-tools.ts
 */

import { handleDesignAudit, handlePaletteSuggest, handleSegmentPreset, handleWcagValidate } from "../src/tools.js";
import { SEGMENT_KEYS } from "../src/design-guidance.js";
import { DEV_PATTERNS } from "../src/dev-patterns.js";

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

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${"─".repeat(60)}`);
console.log(`  ${passed} passed  |  ${failed} failed  |  ${passed + failed} total`);
if (failed > 0) {
  console.log("  Some tests failed — check output above.\n");
  process.exit(1);
} else {
  console.log("  All tests passed.\n");
}
