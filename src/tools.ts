import { getGuidance, GuidanceBlock, SEGMENT_KEYS, TOPIC_KEYS } from "./design-guidance";

// ── get_design_guidance ───────────────────────────────────────────────────────

function formatGuidanceBlock(
  block: GuidanceBlock,
  label: string,
  also_call: string[]
): string {
  const lines: string[] = [
    `DESIGN GUIDANCE — ${label}`,
    "",
    "PRINCIPLES:",
    ...block.principles.map((p) => `  • ${p}`),
    "",
    "DO:",
    ...block.do_list.map((d) => `  ✓ ${d}`),
    "",
    "DON'T:",
    ...block.dont_list.map((d) => `  ✗ ${d}`),
  ];
  const hints = Object.entries(block.config_hints);
  if (hints.length > 0) {
    lines.push("", "CONFIG HINTS:");
    for (const [k, v] of hints) lines.push(`  ${k}: ${JSON.stringify(v)}`);
  }
  if (also_call.length > 0) {
    lines.push("", `→ Also call: ${also_call.join(", ")}`);
  }
  return lines.join("\n");
}

export function handleGetDesignGuidance(input: { segment?: string; topic?: string }): string {
  const { segment, topic } = input;

  if (segment && !SEGMENT_KEYS.includes(segment)) {
    return `Unknown segment: "${segment}". Valid segments: ${SEGMENT_KEYS.join(", ")}`;
  }
  if (topic && !TOPIC_KEYS.includes(topic)) {
    return `Unknown topic: "${topic}". Valid topics: ${TOPIC_KEYS.join(", ")}`;
  }

  const result = getGuidance(segment, topic);
  const label = result.source === "overview"
    ? "OVERVIEW"
    : result.source === "combined"
    ? `${segment!.toUpperCase()} + ${topic!.toUpperCase()}`
    : result.source === "segment"
    ? segment!.toUpperCase().replace(/_/g, " ")
    : topic!.toUpperCase().replace(/_/g, " ");
  return formatGuidanceBlock(result.guidance, label, result.also_call);
}

// ── Color math helpers ────────────────────────────────────────────────────────

/**
 * Validate and parse a hex color string (#RGB or #RRGGBB) into [r, g, b] ∈ [0, 1].
 * Throws a descriptive error on invalid input so callers get a clear message
 * rather than a silent NaN that propagates as `passes: false` through WCAG checks.
 */
function hexToRgb(hex: string): [number, number, number] {
  if (typeof hex !== "string" || !/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(hex.trim())) {
    throw new Error(
      `Invalid hex color "${hex}" — expected #RGB or #RRGGBB (e.g. #fff or #ffffff).`
    );
  }
  let clean = hex.trim().slice(1); // drop #
  if (clean.length === 3) clean = clean[0]+clean[0]+clean[1]+clean[1]+clean[2]+clean[2]; // expand shorthand
  return [
    parseInt(clean.slice(0, 2), 16) / 255,
    parseInt(clean.slice(2, 4), 16) / 255,
    parseInt(clean.slice(4, 6), 16) / 255,
  ];
}

function hexToHsl(hex: string): { h: number; s: number; l: number } {
  const [r, g, b] = hexToRgb(hex);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l: l * 100 };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return { h: h * 360, s: s * 100, l: l * 100 };
}

function linearize(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map(linearize);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function wcagRatio(fg: string, bg: string): number {
  const l1 = relativeLuminance(fg);
  const l2 = relativeLuminance(bg);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

// ── Shared layer-analysis helpers ────────────────────────────────────────────

function extractStaticHexColors(layer: Record<string, unknown>): string[] {
  const colors: string[] = [];
  const paint = layer.paint as Record<string, unknown> | undefined;
  if (!paint) return colors;
  for (const v of Object.values(paint)) {
    if (typeof v === "string" && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v)) colors.push(v);
  }
  return colors;
}

const EFFECTIVE_BG: Record<string, string> = {
  dawn:  "#e8dfd0",
  day:   "#f5f3ef",
  dusk:  "#2a2535",
  night: "#0e1a26",
};

// ── Tool: design_audit ───────────────────────────────────────────────────────

interface AuditInput {
  style_json?: Record<string, unknown>;
  standard_config?: Record<string, unknown>;
  segment?: string;
  brand_color_hint?: string;
}

interface AuditViolation {
  id: string;
  severity: "error" | "warn" | "info";
  message: string;
  fix: string;
}

type LayerDef = {
  id: string;
  type?: string;
  source?: string;
  "source-layer"?: string;
  slot?: string;
  paint?: Record<string, unknown>;
  layout?: Record<string, unknown>;
};

function parseStyle(input: AuditInput): { layers: LayerDef[]; sources: Record<string, unknown> } {
  if (input.style_json) {
    const rawLayers = input.style_json.layers;
    // Guard: layers must be an array; each entry must be an object with a string id
    const layers = Array.isArray(rawLayers)
      ? rawLayers
          .filter((l): l is Record<string, unknown> => typeof l === "object" && l !== null)
          .map((l) => ({ id: "", ...l } as LayerDef))
      : [];
    const rawSources = input.style_json.sources;
    const sources =
      typeof rawSources === "object" && rawSources !== null && !Array.isArray(rawSources)
        ? (rawSources as Record<string, unknown>)
        : {};
    return { layers, sources };
  }
  return { layers: [], sources: {} };
}

export function handleDesignAudit(input: AuditInput): {
  violations: AuditViolation[];
  score: number;
  segment_notes?: string;
} {
  const { layers, sources } = parseStyle(input);
  const violations: AuditViolation[] = [];

  // ── Hierarchy ──────────────────────────────────────────────────────────────

  const routeIdx = layers.findIndex(
    (l) => (l.id ?? "").includes("route") || (l.type === "line" && ((l.paint?.["line-width"] as number) ?? 0) > 2)
  );
  const poiIdxLast = [...layers].reverse().findIndex((l) => l.type === "symbol");
  const poiIdx = poiIdxLast >= 0 ? layers.length - 1 - poiIdxLast : -1;
  if (routeIdx > -1 && poiIdx > routeIdx) {
    violations.push({
      id: "route-above-poi",
      severity: "error",
      message: "Route layer is below POI symbol layers in the layer stack.",
      fix: "Move route layer above POI symbol layers, or use slot:'top'",
    });
  }

  const customLayers = layers.filter(
    (l) => l.source && !String(l.source).startsWith("mapbox") && l.source !== "composite"
  );
  const unslotted = customLayers.filter((l) => !l.slot || l.slot === "bottom");
  if (unslotted.length > 0) {
    violations.push({
      id: "data-above-basemap",
      severity: "error",
      message: `Custom layers [${unslotted.map((l) => l.id || "(unnamed)").join(", ")}] lack explicit slot assignment.`,
      fix: "Add slot:'top' or slot:'middle' to custom data layers.",
    });
  }

  // ── HTML marker anti-pattern hint ──────────────────────────────────────────

  const customSymbolLayers = layers.filter(
    (l) => l.type === "symbol" && l.source && !String(l.source).startsWith("mapbox") && l.source !== "composite"
  );
  const customCircleLayers = layers.filter(
    (l) => l.type === "circle" && l.source && !String(l.source).startsWith("mapbox") && l.source !== "composite"
  );
  if (customSymbolLayers.length === 0 && customCircleLayers.length === 0 && layers.length > 0) {
    violations.push({
      id: "no-symbol-layers",
      severity: "warn",
      message: "No custom symbol or circle layers found. For large datasets (50+ points) use GL symbol layers — they provide collision detection, clustering, and feature-state. mapboxgl.Marker is valid only for small sets (<50) with per-element DOM interaction.",
      fix: "See get_dev_patterns('pins_and_markers') for the symbol layer + feature-state pattern.",
    });
  }

  // ── Symbol layer anti-patterns ─────────────────────────────────────────────

  const symbolLayers = layers.filter((l) => l.type === "symbol");

  const flatIconSize = symbolLayers.filter(
    (l) => typeof l.layout?.["icon-size"] === "number"
  );
  for (const l of flatIconSize) {
    violations.push({
      id: "flat-icon-size",
      severity: "warn",
      message: `Symbol layer '${l.id}' uses a flat icon-size value — icons will look wrong across zoom levels.`,
      fix: "Replace with a zoom-interpolate expression: ['interpolate',['linear'],['zoom'], 10, 0.6, 15, 1.2]",
    });
  }

  const centerAnchorWithIcon = symbolLayers.filter(
    (l) =>
      l.layout?.["icon-image"] &&
      l.layout?.["text-anchor"] === "center" &&
      !l.layout?.["text-variable-anchor"]
  );
  for (const l of centerAnchorWithIcon) {
    violations.push({
      id: "label-on-icon",
      severity: "error",
      message: `Symbol layer '${l.id}' uses text-anchor:'center' with icon-image — the label will overlap the icon.`,
      fix: "Use text-variable-anchor:['top','top-right','top-left','right','left'] + text-radial-offset:1.5",
    });
  }

  const missingVariableAnchor = symbolLayers.filter(
    (l) =>
      l.layout?.["icon-image"] &&
      l.layout?.["text-field"] &&
      !l.layout?.["text-variable-anchor"] &&
      l.layout?.["text-anchor"] !== "center"
  );
  for (const l of missingVariableAnchor) {
    violations.push({
      id: "missing-variable-anchor",
      severity: "info",
      message: `Symbol layer '${l.id}' has icon + label but no text-variable-anchor — labels may collide at scale.`,
      fix: "Add text-variable-anchor:['top','top-right','top-left','right','left'] and text-radial-offset:1.5",
    });
  }

  const emptySymbolLayers = symbolLayers.filter(
    (l) => !l.layout?.["icon-image"] && !l.layout?.["text-field"]
  );
  for (const l of emptySymbolLayers) {
    violations.push({
      id: "empty-symbol-layer",
      severity: "warn",
      message: `Symbol layer '${l.id}' has no icon-image and no text-field — it renders nothing.`,
      fix: "Add icon-image (load an image with map.addImage first) or text-field to display content.",
    });
  }

  // ── Color / Contrast ───────────────────────────────────────────────────────

  if (input.standard_config && !input.style_json) {
    const overrideKeys = ["colorPlaceLabels", "colorPointOfInterestLabels", "colorRoadLabels"];
    const overrides = overrideKeys.filter((k) => input.standard_config![k]);
    if (overrides.length > 0) {
      const preset = (input.standard_config.lightPreset as string) || "day";
      const bg = EFFECTIVE_BG[preset] ?? EFFECTIVE_BG.day;
      const failingOverrides = overrides
        .map((k) => ({ key: k, ratio: wcagRatio(input.standard_config![k] as string, bg) }))
        .filter((e) => e.ratio < 4.5);
      if (failingOverrides.length > 0) {
        const worstRatio = Math.min(...failingOverrides.map((e) => e.ratio));
        violations.push({
          id: "wcag-text",
          severity: worstRatio < 2.0 ? "error" : worstRatio < 3.5 ? "warn" : "info",
          message: `Custom text color overrides [${failingOverrides.map((e) => e.key).join(", ")}] may fail WCAG AA at ${preset} lightPreset.`,
          fix: "Run design_audit again after adjusting text color lightness to verify contrast.",
        });
      }
    }
  } else if (layers.length > 0) {
    const textLayers = layers.filter(
      (l) => l.type === "symbol" && (l.paint?.["text-color"] as string)
    );
    const failingLayers = textLayers
      .map((l) => {
        const tc = l.paint?.["text-color"] as string;
        if (!tc || !/^#/.test(tc)) return null;
        const hc = (l.paint?.["text-halo-color"] as string) || "#ffffff";
        return { l, ratio: wcagRatio(tc, hc) };
      })
      .filter((e): e is { l: LayerDef; ratio: number } => e !== null && e.ratio < 4.5);
    if (failingLayers.length > 0) {
      const worstRatio = Math.min(...failingLayers.map((e) => e.ratio));
      violations.push({
        id: "wcag-text",
        severity: worstRatio < 2.0 ? "error" : worstRatio < 3.5 ? "warn" : "info",
        message: `${failingLayers.length} text layer(s) have text/halo pairs that fail WCAG AA.`,
        fix: "Increase contrast between text-color and text-halo-color (target ≥4.5:1).",
      });
    }
  }

  // Brand color scattered
  let brandHue: number | null = null;
  if (input.brand_color_hint) {
    brandHue = hexToHsl(input.brand_color_hint).h;
  } else if (layers.length > 0) {
    const allColors = layers.flatMap(extractStaticHexColors);
    const nonCartographic = allColors.filter((c) => {
      const { h, s } = hexToHsl(c);
      if (s < 10) return false;
      if (h >= 180 && h <= 240) return false;
      if (h >= 90 && h <= 150) return false;
      return true;
    });
    const buckets: Record<number, number> = {};
    for (const c of nonCartographic) {
      const b = Math.round(hexToHsl(c).h / 15) * 15;
      buckets[b] = (buckets[b] ?? 0) + 1;
    }
    const top = Object.entries(buckets).sort((a, b) => b[1] - a[1])[0];
    if (top && Number(top[1]) >= 2) brandHue = Number(top[0]);
  }
  if (brandHue !== null) {
    const matching = layers.filter((l) =>
      extractStaticHexColors(l).some((c) => Math.abs(hexToHsl(c).h - brandHue!) < 15)
    );
    if (matching.length > 2) {
      violations.push({
        id: "brand-color-scattered",
        severity: "warn",
        message: `Brand color (hue ~${Math.round(brandHue)}°) appears on ${matching.length} layers: [${matching.map((l) => l.id).join(", ")}].`,
        fix: "Reserve the primary brand color for one layer only (route line or primary marker).",
      });
    }
  }

  // Dark theme roads
  const isDark =
    input.standard_config?.lightPreset === "night" ||
    input.standard_config?.lightPreset === "dusk";
  if (isDark) {
    const roadLayers = layers.filter(
      (l) => String(l["source-layer"] ?? "").includes("road") || l.id.includes("road")
    );
    const saturatedRoads = roadLayers.filter((l) => {
      const c = l.paint?.["line-color"] as string;
      return typeof c === "string" && c.startsWith("#") && hexToHsl(c).s > 10;
    });
    if (saturatedRoads.length > 0) {
      violations.push({
        id: "dark-theme-roads",
        severity: "warn",
        message: `Road layers [${saturatedRoads.map((l) => l.id).join(", ")}] use colored roads on a dark theme.`,
        fix: "Use neutral gray (#3a3a3a) for road fills on dark/night themes — colored roads compete with data layers.",
      });
    }
  }

  // ── Density ────────────────────────────────────────────────────────────────

  const denseSegments = ["real_estate", "data_viz", "automotive"];
  if (denseSegments.includes(input.segment ?? "") && input.standard_config?.showPointOfInterestLabels !== false) {
    violations.push({
      id: "poi-at-high-zoom",
      severity: "info",
      message: "POI labels are enabled for a segment that benefits from clean data display.",
      fix: "Set showPointOfInterestLabels:false — POI labels compete with data/listings at high zoom.",
    });
  }

  if (input.segment === "real_estate" && input.standard_config?.show3dBuildings === true) {
    violations.push({
      id: "3d-on-listings",
      severity: "info",
      message: "3D buildings are enabled for a real estate map.",
      fix: "Disable 3D buildings for real estate maps — extrusions obscure parcel outlines at z16+.",
    });
  }

  // ── Performance ────────────────────────────────────────────────────────────

  const largeSources = Object.entries(sources).filter(([, src]) => {
    if (typeof src !== "object" || src === null) return false;
    const s = src as Record<string, unknown>;
    if (s.type !== "geojson") return false;
    const data = s.data as Record<string, unknown> | undefined;
    return Array.isArray(data?.features) && (data!.features as unknown[]).length > 500;
  }).map(([id]) => id);
  if (largeSources.length > 0) {
    violations.push({
      id: "geojson-too-large",
      severity: "error",
      message: `GeoJSON sources [${largeSources.join(", ")}] exceed 500 features.`,
      fix: "Convert to vector tilesets via Mapbox Tiling Service.",
    });
  }

  const customCount = layers.filter(
    (l) => l.source && l.source !== "composite" && !String(l.source).includes("mapbox")
  ).length;
  if (customCount > 15) {
    violations.push({
      id: "layer-count",
      severity: "warn",
      message: `${customCount} custom layers detected — each adds a GPU draw call per frame.`,
      fix: "Aim for ≤15 custom layers. Combine sources where possible.",
    });
  }

  const unclusteredSources = Object.entries(sources).filter(([, src]) => {
    if (typeof src !== "object" || src === null) return false;
    const s = src as Record<string, unknown>;
    if (s.type !== "geojson" || s.cluster) return false;
    const data = s.data as Record<string, unknown> | undefined;
    return Array.isArray(data?.features) && (data!.features as unknown[]).length > 100;
  }).map(([id]) => id);
  if (unclusteredSources.length > 0) {
    violations.push({
      id: "no-clustering",
      severity: "warn",
      message: `Sources [${unclusteredSources.join(", ")}] have >100 point features but no clustering.`,
      fix: "Add cluster:true to the GeoJSON source definition.",
    });
  }

  // Score: 100 - (errors * 15) - (warns * 5) - (info * 2)
  const score = Math.max(
    0,
    100 -
      violations.filter((v) => v.severity === "error").length * 15 -
      violations.filter((v) => v.severity === "warn").length * 5 -
      violations.filter((v) => v.severity === "info").length * 2
  );

  const segmentNotes: Record<string, string> = {
    real_estate: "Real estate: pin primacy over everything. Faded base, POIs off, 3D off.",
    automotive: "Automotive: route line must beat landmarks. Build explicit night config — never derive from day.",
    data_viz: "Data viz: monochrome base, all POI noise off. Data must be the only thing that pops.",
    logistics: "Logistics: customer view needs ambient faded base; driver view needs building footprints at z16.",
    travel: "Travel: decide discovery vs listings mode — they have opposite 3D/POI configurations.",
    journalism: "Journalism: flat over 3D, equal-area projection for global stories, rates not counts for choropleth.",
  };

  return {
    violations,
    score,
    ...(input.segment && segmentNotes[input.segment]
      ? { segment_notes: segmentNotes[input.segment] }
      : {}),
  };
}

// ── Tool: palette_suggest ─────────────────────────────────────────────────────

interface PaletteSuggestInput {
  brand_color: string;
  segment: string;
  background: "light" | "dark";
}

function hslToHex(h: number, s: number, l: number): string {
  const sl = s / 100;
  const ll = l / 100;
  const c = (1 - Math.abs(2 * ll - 1)) * sl;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = ll - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; }
  else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; }
  else { r = c; b = x; }
  const toHex = (v: number) => Math.round((v + m) * 255).toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function adjustForContrast(color: string, bg: string, target = 4.5): string {
  const { h, s } = hexToHsl(color);
  let l = hexToHsl(color).l;
  // Try darkening first, then lightening
  for (let step = 0; step < 20; step++) {
    l = Math.max(0, l - 3);
    const candidate = hslToHex(h, s, l);
    if (wcagRatio(candidate, bg) >= target) return candidate;
  }
  l = hexToHsl(color).l;
  for (let step = 0; step < 20; step++) {
    l = Math.min(100, l + 3);
    const candidate = hslToHex(h, s, l);
    if (wcagRatio(candidate, bg) >= target) return candidate;
  }
  // No valid contrast found in 40 iterations — fall back to near-black/near-white
  const bgL = relativeLuminance(bg);
  return bgL > 0.5 ? "#1a1a1a" : "#f5f5f5";
}

export function handlePaletteSuggest(input: PaletteSuggestInput): {
  palette: Record<string, string>;
  standard_config_patch: Record<string, unknown>;
  wcag_report: Array<{ pair: string; ratio: number; passes_aa: boolean }>;
  warnings: string[];
} {
  const { h, s, l } = hexToHsl(input.brand_color);
  const isDark = input.background === "dark";

  const landColor = isDark ? "#0e1a26" : "#f5f3ef";
  const waterColor = isDark ? "#1a2d3e" : "#a8d4e6";
  const bgColor = landColor;

  const primary = adjustForContrast(input.brand_color, bgColor, 3.0);

  const accent1Raw = hslToHex((h + 180) % 360, Math.min(s, 70), isDark ? 55 : 45);
  const accent1 = adjustForContrast(accent1Raw, bgColor, 3.0);

  const accent2Raw = hslToHex((h + 30) % 360, Math.min(s * 0.8, 60), isDark ? 50 : 50);
  const accent2 = adjustForContrast(accent2Raw, bgColor, 3.0);

  const textOnLight = adjustForContrast(hslToHex(h, Math.min(s * 0.3, 20), 15), "#f5f3ef", 4.5);
  const textOnDark = adjustForContrast(hslToHex(h, Math.min(s * 0.2, 15), 90), "#0e1a26", 4.5);

  const routeLine = isDark
    ? hslToHex(h, Math.min(s, 80), Math.min(l + 20, 70))
    : primary;

  const waterOverride = h >= 170 && h <= 250 ? null : waterColor;

  const palette: Record<string, string> = {
    primary,
    accent_1: accent1,
    accent_2: accent2,
    text_on_light: textOnLight,
    text_on_dark: textOnDark,
    route_line: routeLine,
    ...(waterOverride ? { water_override: waterOverride } : {}),
    poi_emphasis: accent1,
  };

  const configPatch: Record<string, unknown> = {
    theme: isDark ? "default" : "faded",
    lightPreset: isDark ? "night" : "day",
    colorLand: landColor,
    colorWater: waterOverride ?? waterColor,
  };

  const pairBg = isDark ? "#0e1a26" : "#f5f3ef";
  const report = [
    { pair: "primary / background", ratio: wcagRatio(primary, pairBg), passes_aa: wcagRatio(primary, pairBg) >= 3.0 },
    { pair: "text_on_light / light-bg", ratio: wcagRatio(textOnLight, "#f5f3ef"), passes_aa: wcagRatio(textOnLight, "#f5f3ef") >= 4.5 },
    { pair: "text_on_dark / dark-bg", ratio: wcagRatio(textOnDark, "#0e1a26"), passes_aa: wcagRatio(textOnDark, "#0e1a26") >= 4.5 },
    { pair: "route_line / land", ratio: wcagRatio(routeLine, landColor), passes_aa: wcagRatio(routeLine, landColor) >= 3.0 },
  ].map((r) => ({ ...r, ratio: Math.round(r.ratio * 100) / 100 }));

  const warnings: string[] = [];
  if (hexToHsl(primary).s > 80) warnings.push("Brand color is highly saturated — consider reducing saturation for road fills.");
  if (Math.abs(hexToHsl(primary).h - hexToHsl(waterColor).h) < 30) warnings.push("Brand color is similar to water blue — water override applied.");

  return { palette, standard_config_patch: configPatch, wcag_report: report, warnings };
}

// ── Tool: segment_preset ──────────────────────────────────────────────────────

interface SegmentPresetInput {
  segment: string;
  time_of_day?: "dawn" | "day" | "dusk" | "night";
  brand_color?: string;
  mapbox_token?: string;
}

type StandardConfig = Record<string, unknown>;

export const PRESETS: Record<string, StandardConfig> = {
  logistics_customer: { lightPreset: "day", theme: "faded", showPointOfInterestLabels: false, showLandmarkIcons: false, show3dBuildings: false, colorWater: "#b8d4e8" },
  logistics_driver:   { lightPreset: "day", theme: "default", showPointOfInterestLabels: false, show3dBuildings: true, showLandmarkIcons: false },
  logistics_ops:      { lightPreset: "day", theme: "monochrome", showPointOfInterestLabels: false, showLandmarkIcons: false, show3dBuildings: false },
  travel:             { lightPreset: "day", theme: "default", showPointOfInterestLabels: true, showLandmarkIcons: true, show3dBuildings: true },
  travel_discovery:   { lightPreset: "day", theme: "default", showPointOfInterestLabels: true, showLandmarkIcons: true, show3dBuildings: true },
  travel_navigation:  { lightPreset: "day", theme: "default", showPointOfInterestLabels: true, showLandmarkIcons: true, show3dBuildings: false },
  real_estate:        { lightPreset: "day", theme: "faded", showPointOfInterestLabels: false, show3dBuildings: false, showPlaceLabels: true },
  automotive:         { lightPreset: "day", theme: "default", show3dBuildings: true, showLandmarkIcons: true, showPlaceLabels: true },
  data_viz:           { lightPreset: "day", theme: "monochrome", showPointOfInterestLabels: false, showLandmarkIcons: false, show3dBuildings: false },
  outdoors:           { lightPreset: "day", theme: "outdoors", showPointOfInterestLabels: false, show3dBuildings: false },
  social:             { lightPreset: "day", theme: "default", showPointOfInterestLabels: true, showLandmarkIcons: true },
  journalism:         { lightPreset: "day", theme: "faded", showPointOfInterestLabels: false, showLandmarkIcons: false, show3dBuildings: false, showRoadLabels: false },
  retail:             { lightPreset: "day", theme: "faded", showPointOfInterestLabels: false, showLandmarkIcons: false, show3dBuildings: false },
  weather:            { lightPreset: "day", theme: "default", showPointOfInterestLabels: false, showLandmarkIcons: false, show3dBuildings: false },
  telecom:            { lightPreset: "day", theme: "faded", showPointOfInterestLabels: false, showLandmarkIcons: false, show3dBuildings: false },
  mobility:           { lightPreset: "day", theme: "default", showPointOfInterestLabels: false, show3dBuildings: false },
  public_sector:      { lightPreset: "day", theme: "faded", showPointOfInterestLabels: false, showLandmarkIcons: false, show3dBuildings: false },
};

const PRESET_INSTRUCTIONS: Record<string, string[]> = {
  automotive: [
    "Set route line layer slot to 'top' so it renders above all POIs and buildings",
    "Add line-occlusion-opacity:0.5 to route line paint for 3D building tunnels",
    "Build an explicit night config with lightPreset:'night' — never derive from day algorithmically",
    "Apply brand color to route line ONLY — not basemap roads, water, or land",
    "Show lane geometry layers at minzoom:17",
  ],
  outdoors: [
    "Paths and cycleways need visual prominence over car roads — use a custom line layer on top of Standard",
    "Add a custom line layer for cycling routes: yellow highlight at z13+, car roads in grey",
    "Filter commercial POIs: show only campsites, trailheads, water sources (minzoom:12)",
    "GPS trace layer: line-width expression ['interpolate',['linear'],['zoom'],10,1,16,4]",
  ],
  journalism: [
    "Use publication house-style font family for labels if available",
    "For global/national stories: call map.setProjection('equalEarth') to avoid Mercator area distortion",
    "For US national stories: map.setProjection('albers') is more honest for area comparison",
    "Choropleth data: always normalize to rates/percentages — NEVER raw counts",
    "Use Sequential ColorBrewer ramp for one-direction data; Diverging (RdBu or PuOr) for political",
    "Build Static Images API fallback for AMP, social embed, and slow mobile connections",
  ],
  retail: [
    "Use Search Box API (@mapbox/search-js-react) for address autocomplete — not raw Geocoding API",
    "Auto-zoom to all stores on load: map.fitBounds(turf.bbox(storeCollection), {padding:40, maxZoom:15})",
    "Brand color on store markers and sidebar UI chrome ONLY — not water, roads, or land",
    "Add Static Images API thumbnails for store cards",
  ],
  weather: [
    "Use raster-particle layer type for animated precipitation/wind (GL JS v3 feature)",
    "Use raster layer for static radar tiles with timestamp in source URL",
    "Weather color ramps are conventional — Temperature: blue→white→red; Precip: yellow→green→blue→purple",
    "NEVER use a custom or brand color ramp for weather data — breaks user expectation",
    "Light basemap is REQUIRED — dark base washes out weather color data",
  ],
  telecom: [
    "Coverage gradient: brand color at strong signal, near-white at weak — not zero opacity",
    "Expression: ['interpolate',['linear'],['get','signal'],0,'#f0f0f0',100,brandColor]",
    "Use Mapbox Tiling Service for coverage polygon uploads — supports weekly update recipes",
    "Never use dark basemap — light/faded base is required for gradient legibility",
  ],
  mobility: [
    "Vehicle state icons: use feature-state to set icon-image per state (idle/active/low-battery)",
    "Service zone geofences: brand fill-color at 15% opacity + solid brand line border",
    "Restricted zone geofences: red fill at 20% opacity + dashed red line border (line-dasharray:[2,2])",
    "Above 100 vehicles: use circle layers not HTML Markers for performance",
    "Above 500 vehicles on ops dashboard: enable clustering with cluster:true on source",
  ],
  public_sector: [
    "NO animated 3D, NO dark themes, NO decorative brand styling",
    "Hazard/alert data must use slot:'top' with high-contrast fills (opacity 0.6-0.8)",
    "ALL text must pass WCAG AA (4.5:1 minimum)",
    "Build Static Images API fallback — emergency maps must survive 100x normal traffic spikes",
    "Use Standard faded theme — no experimental GL JS features in production emergency maps (Classic light-v11 only as last resort)",
  ],
};

const RATIONALE: Record<string, string> = {
  logistics_customer: "Faded theme with brand color only on courier dot — customer view needs ambient comfort, not driver utility.",
  logistics_driver:   "Default theme with buildings on — building footprints are the strongest last-50-feet delivery cue.",
  logistics_ops:      "Monochrome base with clustering mandatory — ops dashboard must handle thousands of fleet dots without mush.",
  travel:             "Default travel config — full discovery mode. Use travel_discovery or travel_navigation for more specific sub-modes.",
  travel_discovery:   "All landmarks and POIs on — discovery is the product; pedestrian density and 3D anchors are signals not noise.",
  travel_navigation:  "Landmarks on, POIs reduced — wayfinding mode needs icons as anchors but not full discovery density.",
  real_estate:        "Faded base, POIs off, 3D off — listings must be the only thing that pops. Parcels cannot be occluded.",
  automotive:         "Default theme with 3D for spatial context, but route line always beats landmarks in visual hierarchy.",
  data_viz:           "Monochrome base — data must shine, basemap must disappear. No POI noise competing with the thematic layer.",
  outdoors:           "Outdoors theme — trails, contours, and terrain are the product. Car infrastructure is background noise.",
  social:             "Default theme with full POI and landmark density — discovery and personality are the product.",
  journalism:         "Faded base with all POI/landmark noise removed — data story choropleth needs a silent, receding canvas.",
  retail:             "Faded base — brands cannot afford to look like Google Maps; brand color scoped to markers only.",
  weather:            "Default theme on light base — weather raster overlays are primary; basemap must not compete with radar color.",
  telecom:            "Faded base — coverage gradient needs a neutral canvas so brand-color signal-strength reads clearly.",
  mobility:           "Default theme with POIs off — vehicle dots and geofences are the product; street context needed but not clutter.",
  public_sector:      "Light/faded theme — trust and accessibility over aesthetics. No 3D or dark themes during emergencies.",
};

export const SEGMENT_PREVIEW_CENTERS: Record<string, { lng: number; lat: number; zoom: number }> = {
  logistics_customer:  { lng: -73.99, lat: 40.73, zoom: 13 },
  logistics_driver:    { lng: -73.99, lat: 40.73, zoom: 17 },
  logistics_ops:       { lng: -87.63, lat: 41.88, zoom: 10 },
  travel:              { lng:   2.35, lat: 48.86, zoom: 14 },
  travel_discovery:    { lng:   2.35, lat: 48.86, zoom: 14 },
  travel_navigation:   { lng:   2.35, lat: 48.86, zoom: 15 },
  real_estate:         { lng: -118.49, lat: 34.02, zoom: 14 },
  automotive:          { lng: -118.25, lat: 34.05, zoom: 12 },
  data_viz:            { lng: -87.63, lat: 41.88, zoom: 10 },
  outdoors:            { lng: -105.58, lat: 40.35, zoom: 12 },
  social:              { lng:  151.21, lat: -33.87, zoom: 14 },
  journalism:          { lng: -77.03, lat: 38.90, zoom: 10 },
  retail:              { lng: -73.99, lat: 40.75, zoom: 14 },
  weather:             { lng: -90.00, lat: 40.00, zoom:  6 },
  telecom:             { lng: -97.00, lat: 38.00, zoom:  7 },
  mobility:            { lng:   2.35, lat: 48.86, zoom: 14 },
  public_sector:       { lng: -118.25, lat: 34.05, zoom: 11 },
};

export function handleSegmentPreset(input: SegmentPresetInput): {
  config: StandardConfig;
  instructions: string[];
  rationale: string;
  preview_url?: string;
} {
  const preset = PRESETS[input.segment];
  if (!preset) {
    return {
      config: {},
      instructions: [],
      rationale: `Unknown segment: ${input.segment}. Available: ${Object.keys(PRESETS).join(", ")}`,
    };
  }

  const config = { ...preset };
  if (input.time_of_day) config.lightPreset = input.time_of_day;

  const instructions = [
    ...(PRESET_INSTRUCTIONS[input.segment] ?? []),
    "For point markers or icons: call get_dev_patterns('pins_and_markers') — choose Marker (SVG/PNG file, <50 points), symbol layer (SVG or PNG, 50+ points), or dots (circle layer, no icon).",
  ];
  const rationale = RATIONALE[input.segment] ?? "";

  const result: { config: StandardConfig; instructions: string[]; rationale: string; preview_url?: string } = {
    config,
    instructions,
    rationale,
  };

  if (input.mapbox_token) {
    const center = SEGMENT_PREVIEW_CENTERS[input.segment];
    if (center) {
      const configQuery = Object.entries(config)
        .map(([k, v]) => `config[basemap][${k}]=${encodeURIComponent(String(v))}`)
        .join("&");
      result.preview_url =
        `https://api.mapbox.com/styles/v1/mapbox/standard/static/` +
        `${center.lng},${center.lat},${center.zoom},0/600x400` +
        `?access_token=${input.mapbox_token}&${configQuery}`;
    }
  }

  return result;
}

