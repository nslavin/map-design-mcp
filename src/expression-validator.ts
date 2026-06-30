/**
 * expression-validator.ts
 *
 * Native Mapbox GL expression validator — copied and adapted from the
 * mcp-devkit-server ValidateExpressionTool (MIT License, Mapbox, Inc.).
 * No external dependency required — all validation is rule-based.
 *
 * Also provides a curated get_reference lookup for common Style Spec topics.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ExpressionIssue {
  severity: "error" | "warning" | "info";
  message: string;
  path?: string;
  suggestion?: string;
}

export interface ValidateExpressionResult {
  valid: boolean;
  errors: ExpressionIssue[];
  warnings: ExpressionIssue[];
  info: ExpressionIssue[];
  metadata: { expressionType?: string; returnType?: string; depth: number };
}

// ── Operator table (adapted from mcp-devkit-server ValidateExpressionTool.ts) ─

const OPERATORS: Record<string, { min: number; max: number; returnType?: string }> = {
  // Decision
  case: { min: 2, max: Infinity },
  match: { min: 3, max: Infinity },
  coalesce: { min: 1, max: Infinity },
  // Lookup
  get: { min: 1, max: 2, returnType: "any" },
  has: { min: 1, max: 2, returnType: "boolean" },
  in: { min: 2, max: 2, returnType: "boolean" },
  "index-of": { min: 2, max: 3, returnType: "number" },
  length: { min: 1, max: 1, returnType: "number" },
  slice: { min: 2, max: 3 },
  // Math
  "+": { min: 2, max: Infinity, returnType: "number" },
  "-": { min: 2, max: 2, returnType: "number" },
  "*": { min: 2, max: Infinity, returnType: "number" },
  "/": { min: 2, max: 2, returnType: "number" },
  "%": { min: 2, max: 2, returnType: "number" },
  "^": { min: 2, max: 2, returnType: "number" },
  min: { min: 1, max: Infinity, returnType: "number" },
  max: { min: 1, max: Infinity, returnType: "number" },
  round: { min: 1, max: 1, returnType: "number" },
  floor: { min: 1, max: 1, returnType: "number" },
  ceil: { min: 1, max: 1, returnType: "number" },
  abs: { min: 1, max: 1, returnType: "number" },
  sqrt: { min: 1, max: 1, returnType: "number" },
  log10: { min: 1, max: 1, returnType: "number" },
  log2: { min: 1, max: 1, returnType: "number" },
  ln: { min: 1, max: 1, returnType: "number" },
  e: { min: 0, max: 0, returnType: "number" },
  pi: { min: 0, max: 0, returnType: "number" },
  // Comparison
  "==": { min: 2, max: 3, returnType: "boolean" },
  "!=": { min: 2, max: 3, returnType: "boolean" },
  ">": { min: 2, max: 3, returnType: "boolean" },
  "<": { min: 2, max: 3, returnType: "boolean" },
  ">=": { min: 2, max: 3, returnType: "boolean" },
  "<=": { min: 2, max: 3, returnType: "boolean" },
  // Logical
  "!": { min: 1, max: 1, returnType: "boolean" },
  all: { min: 1, max: Infinity, returnType: "boolean" },
  any: { min: 1, max: Infinity, returnType: "boolean" },
  // String
  concat: { min: 1, max: Infinity, returnType: "string" },
  downcase: { min: 1, max: 1, returnType: "string" },
  upcase: { min: 1, max: 1, returnType: "string" },
  "is-supported-script": { min: 1, max: 1, returnType: "boolean" },
  "resolved-locale": { min: 1, max: 1, returnType: "string" },
  // Color
  rgb: { min: 3, max: 3, returnType: "color" },
  rgba: { min: 4, max: 4, returnType: "color" },
  "to-rgba": { min: 1, max: 1, returnType: "array" },
  // Type conversion
  array: { min: 1, max: 3 },
  boolean: { min: 1, max: 2, returnType: "boolean" },
  collator: { min: 0, max: 1 },
  format: { min: 1, max: Infinity, returnType: "formatted" },
  image: { min: 1, max: 1, returnType: "image" },
  literal: { min: 1, max: 1 },
  number: { min: 1, max: 3, returnType: "number" },
  object: { min: 1, max: 2, returnType: "object" },
  string: { min: 1, max: 2, returnType: "string" },
  "to-boolean": { min: 1, max: 1, returnType: "boolean" },
  "to-color": { min: 1, max: 3, returnType: "color" },
  "to-number": { min: 1, max: 3, returnType: "number" },
  "to-string": { min: 1, max: 1, returnType: "string" },
  typeof: { min: 1, max: 1, returnType: "string" },
  // Interpolation
  interpolate: { min: 3, max: Infinity },
  "interpolate-hcl": { min: 3, max: Infinity },
  "interpolate-lab": { min: 3, max: Infinity },
  step: { min: 2, max: Infinity },
  // Interpolation type specifiers (sub-expressions used inside interpolate)
  linear: { min: 0, max: 0 },
  exponential: { min: 1, max: 1, returnType: "number" },
  "cubic-bezier": { min: 4, max: 4 },
  // Feature data
  "feature-state": { min: 1, max: 1 },
  "geometry-type": { min: 0, max: 0, returnType: "string" },
  id: { min: 0, max: 0 },
  properties: { min: 0, max: 0, returnType: "object" },
  // Camera
  zoom: { min: 0, max: 0, returnType: "number" },
  pitch: { min: 0, max: 0, returnType: "number" },
  "distance-from-center": { min: 0, max: 0, returnType: "number" },
  // Heatmap
  "heatmap-density": { min: 0, max: 0, returnType: "number" },
  // Variable binding
  let: { min: 2, max: Infinity },
  var: { min: 1, max: 1 },
  // Array/object
  at: { min: 2, max: 2 },
  // Geo / distance operators (v3+)
  within: { min: 1, max: 1, returnType: "boolean" },
  distance: { min: 1, max: 1, returnType: "number" },
  // Raster / particle
  "raster-value": { min: 0, max: 0, returnType: "number" },
  "line-progress": { min: 0, max: 0, returnType: "number" },
  // Formatting
  "number-format": { min: 2, max: 2, returnType: "string" },
  // Color constructors
  hsl: { min: 3, max: 3, returnType: "color" },
  hsla: { min: 4, max: 4, returnType: "color" },
  // Standard style / config
  config: { min: 1, max: 1 },
  "global-state": { min: 1, max: 1 },
  // Accumulated (cluster properties)
  accumulated: { min: 0, max: 0 },
};

// ── Recursive validator ───────────────────────────────────────────────────────

function validateExpressionInner(
  expression: unknown,
  errors: ExpressionIssue[],
  warnings: ExpressionIssue[],
  path: string,
  depth: number,
): { expressionType?: string; returnType?: string; depth: number } {
  const maxDepth = depth;

  // Literals are valid
  if (
    typeof expression === "string" ||
    typeof expression === "number" ||
    typeof expression === "boolean" ||
    expression === null
  ) {
    const litType = expression === null ? "null" : typeof expression === "boolean" ? "boolean" : typeof expression === "string" ? "string" : "number";
    return { expressionType: "literal", returnType: litType, depth: maxDepth };
  }

  // Objects are valid as literal objects
  if (!Array.isArray(expression)) {
    if (typeof expression === "object") {
      return { expressionType: "literal-object", returnType: "object", depth: maxDepth };
    }
    errors.push({ severity: "error", message: "Expression must be an array or literal value", path: path || "root" });
    return { depth: maxDepth };
  }

  if (expression.length === 0) {
    errors.push({ severity: "error", message: "Expression array cannot be empty", path: path || "root" });
    return { depth: maxDepth };
  }

  const operator = expression[0];
  if (typeof operator !== "string") {
    errors.push({
      severity: "error",
      message: "Expression operator must be a string",
      path: path ? `${path}[0]` : "[0]",
      suggestion: "Use a valid Mapbox expression operator",
    });
    return { depth: maxDepth };
  }

  const spec = OPERATORS[operator];
  if (!spec) {
    errors.push({
      severity: "error",
      message: `Unknown expression operator: "${operator}"`,
      path: path ? `${path}[0]` : "[0]",
      suggestion: 'Use a valid Mapbox expression operator (e.g., "get", "case", "match")',
    });
    return { expressionType: operator, depth: maxDepth };
  }

  const args = expression.slice(1);
  if (args.length < spec.min) {
    errors.push({
      severity: "error",
      message: `Operator "${operator}" requires at least ${spec.min} argument(s), got ${args.length}`,
      path: path || "root",
      suggestion: `Add ${spec.min - args.length} more argument(s)`,
    });
  }
  if (spec.max !== Infinity && args.length > spec.max) {
    errors.push({
      severity: "error",
      message: `Operator "${operator}" accepts at most ${spec.max} argument(s), got ${args.length}`,
      path: path || "root",
      suggestion: `Remove ${args.length - spec.max} argument(s)`,
    });
  }

  // ── Structural checks ──────────────────────────────────────────────────────

  // case: must have odd number of args — alternating condition/output pairs + one fallback
  if (operator === "case" && args.length >= 2 && args.length % 2 === 0) {
    warnings.push({
      severity: "warning",
      message: `"case" expression has ${args.length} args (even) — expected odd: condition/output pairs + fallback`,
      path: path || "root",
      suggestion: 'Add a fallback value as the last argument: ["case", cond1, out1, fallback]',
    });
  }

  // match: input + at least one label/output pair + fallback = min 4, and must be even after removing input
  if (operator === "match" && args.length >= 3) {
    // args = [input, label1, output1, ..., fallback] → after input: pairs + fallback → even count
    const afterInput = args.length - 1; // label/output pairs + fallback
    if (afterInput % 2 === 0) {
      warnings.push({
        severity: "warning",
        message: `"match" expression may be missing a fallback — expected an odd number of args after the input`,
        path: path || "root",
        suggestion: 'Last arg must be the fallback value: ["match", input, label, output, fallback]',
      });
    }
  }

  // interpolate/step: stop/value pairs must be even after the type/input args
  if ((operator === "interpolate" || operator === "interpolate-hcl" || operator === "interpolate-lab") && args.length >= 3) {
    // args = [interpolation-type, input, stop1, value1, ...] — after first 2: must be even
    const stopPairs = args.length - 2;
    if (stopPairs % 2 !== 0) {
      errors.push({
        severity: "error",
        message: `"${operator}" has an odd number of stop/value args (${stopPairs}) — stops and values must come in pairs`,
        path: path || "root",
        suggestion: "Each stop must have a corresponding output value: [stop1, val1, stop2, val2, ...]",
      });
    }
  }
  if (operator === "step" && args.length >= 2) {
    // args = [input, default, stop1, value1, ...] — after first 2: must be even
    const stopPairs = args.length - 2;
    if (stopPairs % 2 !== 0) {
      errors.push({
        severity: "error",
        message: `"step" has an odd number of stop/value args (${stopPairs}) — stops and values must come in pairs`,
        path: path || "root",
        suggestion: 'Each stop needs an output: ["step", input, default, stop1, value1, ...]',
      });
    }
  }

  // ── Recurse into sub-expressions ──────────────────────────────────────────

  let currentDepth = depth;
  for (let i = 0; i < args.length; i++) {
    if (Array.isArray(args[i])) {
      const argPath = path ? `${path}[${i + 1}]` : `[${i + 1}]`;
      const nested = validateExpressionInner(args[i], errors, warnings, argPath, depth + 1);
      currentDepth = Math.max(currentDepth, nested.depth);
    }
  }

  // Only warn once per expression tree entry point, not at every nested node
  if (depth === 0 && currentDepth > 10) {
    warnings.push({
      severity: "warning",
      message: `Expression is deeply nested (max depth: ${currentDepth})`,
      path: path || "root",
      suggestion: "Consider simplifying the expression using 'let'/'var' bindings",
    });
  }

  return { expressionType: operator, returnType: spec.returnType, depth: Math.max(currentDepth, depth) };
}

export function validateExpression(expressionInput: unknown): ValidateExpressionResult {
  let expression: unknown;
  const errors: ExpressionIssue[] = [];
  const warnings: ExpressionIssue[] = [];
  const info: ExpressionIssue[] = [];

  if (typeof expressionInput === "string") {
    try {
      expression = JSON.parse(expressionInput);
    } catch (e) {
      return {
        valid: false,
        errors: [{ severity: "error", message: `Failed to parse expression JSON: ${(e as Error).message}`, path: "root" }],
        warnings: [],
        info: [],
        metadata: { depth: 0 },
      };
    }
  } else {
    expression = expressionInput;
  }

  const metadata = validateExpressionInner(expression, errors, warnings, "", 0);
  return { valid: errors.length === 0, errors, warnings, info, metadata };
}

// ── get_reference: curated Style Spec topic lookup ────────────────────────────

interface ReferenceEntry {
  summary: string;
  url: string;
  example?: string;
}

const REFERENCE: Record<string, ReferenceEntry> = {
  // Layer types
  background: {
    summary: "Covers the canvas. Use background-color or background-pattern. Always first in layers array.",
    url: "https://docs.mapbox.com/style-spec/reference/layers/#background",
    example: '{ "type": "background", "paint": { "background-color": "#f8f4f0" } }',
  },
  fill: {
    summary: "Filled polygon layer. Key props: fill-color, fill-opacity, fill-outline-color, fill-pattern.",
    url: "https://docs.mapbox.com/style-spec/reference/layers/#fill",
    example: '{ "type": "fill", "paint": { "fill-color": "#e6c39a", "fill-opacity": 0.8 } }',
  },
  "fill-extrusion": {
    summary: "3D extruded polygon. Key props: fill-extrusion-height, fill-extrusion-base, fill-extrusion-color.",
    url: "https://docs.mapbox.com/style-spec/reference/layers/#fill-extrusion",
  },
  line: {
    summary: "Stroked lines. Key props: line-color, line-width, line-dasharray, line-cap, line-join, line-opacity.",
    url: "https://docs.mapbox.com/style-spec/reference/layers/#line",
    example: '{ "type": "line", "paint": { "line-color": "#4a90d9", "line-width": 3 } }',
  },
  symbol: {
    summary: "Icons and/or labels at points or along lines. Key props: icon-image, text-field, text-font, icon-size.",
    url: "https://docs.mapbox.com/style-spec/reference/layers/#symbol",
    example: '{ "type": "symbol", "layout": { "icon-image": "marker-15", "text-field": ["get","name"] } }',
  },
  circle: {
    summary: "Circles at point features. Key props: circle-radius, circle-color, circle-stroke-width, circle-stroke-color.",
    url: "https://docs.mapbox.com/style-spec/reference/layers/#circle",
    example: '{ "type": "circle", "paint": { "circle-radius": 6, "circle-color": "#e55e5e" } }',
  },
  heatmap: {
    summary: "Density heatmap from point data. Key props: heatmap-weight, heatmap-intensity, heatmap-color, heatmap-radius.",
    url: "https://docs.mapbox.com/style-spec/reference/layers/#heatmap",
  },
  raster: {
    summary: "Raster tile layer. Key props: raster-opacity, raster-hue-rotate, raster-brightness-min/max.",
    url: "https://docs.mapbox.com/style-spec/reference/layers/#raster",
  },
  hillshade: {
    summary: "Terrain hillshading from DEM tiles. Key props: hillshade-shadow-color, hillshade-highlight-color.",
    url: "https://docs.mapbox.com/style-spec/reference/layers/#hillshade",
  },
  sky: {
    summary: "Sky/atmosphere background layer. Key props: sky-type, sky-atmosphere-sun, sky-opacity.",
    url: "https://docs.mapbox.com/style-spec/reference/layers/#sky",
  },
  // Common layout/paint properties
  "icon-image": {
    summary: "Name of image from sprite to use as icon. Supports expressions. Required for icon rendering.",
    url: "https://docs.mapbox.com/style-spec/reference/layers/#layout-symbol-icon-image",
    example: '"icon-image": ["coalesce", ["image", ["get","icon"]], ["image","marker-15"]]',
  },
  "icon-size": {
    summary: "Scales the icon. Default 1. Use interpolate expression for zoom-based scaling, not a flat number.",
    url: "https://docs.mapbox.com/style-spec/reference/layers/#layout-symbol-icon-size",
    example: '"icon-size": ["interpolate",["linear"],["zoom"],12,0.8,16,1.4]',
  },
  "text-field": {
    summary: "Text string or formatted expression to display as label. Often [\"get\",\"name\"].",
    url: "https://docs.mapbox.com/style-spec/reference/layers/#layout-symbol-text-field",
    example: '"text-field": ["get","name"]',
  },
  "text-font": {
    summary: "Font stack array for label. Must be loaded in glyphs. Use DIN Pro / Open Sans for Mapbox Standard.",
    url: "https://docs.mapbox.com/style-spec/reference/layers/#layout-symbol-text-font",
    example: '"text-font": ["DIN Pro Medium","Arial Unicode MS Regular"]',
  },
  "text-size": {
    summary: "Font size in pixels. Use interpolate for zoom-based scaling.",
    url: "https://docs.mapbox.com/style-spec/reference/layers/#layout-symbol-text-size",
    example: '"text-size": ["interpolate",["linear"],["zoom"],12,11,16,14]',
  },
  "line-width": {
    summary: "Stroke width in pixels. Use interpolate to scale with zoom.",
    url: "https://docs.mapbox.com/style-spec/reference/layers/#paint-line-line-width",
    example: '"line-width": ["interpolate",["linear"],["zoom"],8,1,16,6]',
  },
  "circle-radius": {
    summary: "Circle radius in pixels. Use interpolate for zoom-based sizing.",
    url: "https://docs.mapbox.com/style-spec/reference/layers/#paint-circle-circle-radius",
  },
  // Expression operators (most common)
  interpolate: {
    summary: 'Produces continuous output between stops. ["interpolate",["linear"],["zoom"], stop, value, ...]. Use for smooth zoom/data-driven transitions.',
    url: "https://docs.mapbox.com/style-spec/reference/expressions/#interpolate",
    example: '["interpolate",["linear"],["zoom"],8,1,16,8]',
  },
  step: {
    summary: 'Produces discrete steps. ["step",input, default, stop1, val1, stop2, val2, ...]. Good for categories.',
    url: "https://docs.mapbox.com/style-spec/reference/expressions/#step",
    example: '["step",["zoom"],0.5, 12,1.0, 16,1.5]',
  },
  "case expression": {
    summary: 'Conditional: ["case", condition1, output1, condition2, output2, ..., fallback]. Like if/else.',
    url: "https://docs.mapbox.com/style-spec/reference/expressions/#case",
    example: '["case",["has","name_en"],["get","name_en"],["get","name"]]',
  },
  "match expression": {
    summary: 'Switch/lookup: ["match",input, val1, out1, val2, out2, ..., fallback]. Efficient for enum lookups.',
    url: "https://docs.mapbox.com/style-spec/reference/expressions/#match",
    example: '["match",["get","class"],"motorway","#e66","primary","#fbb","#ccc"]',
  },
  "get expression": {
    summary: '["get","property"] — reads a feature property. ["get","property",object] reads from an object.',
    url: "https://docs.mapbox.com/style-spec/reference/expressions/#get",
    example: '["get","population"]',
  },
  // Source types
  geojson: {
    summary: "GeoJSON source. Key props: data (URL or inline), maxzoom, tolerance. Watch: >500 features → consider vector tiles.",
    url: "https://docs.mapbox.com/style-spec/reference/sources/#geojson",
  },
  vector: {
    summary: "Vector tile source. Key props: url (mapbox:// or TileJSON), tiles[], maxzoom.",
    url: "https://docs.mapbox.com/style-spec/reference/sources/#vector",
  },
  // Filters
  filter: {
    summary: "Layer filter using legacy or expression syntax. Prefer expression syntax: [\"==\",[\"get\",\"type\"],\"cafe\"].",
    url: "https://docs.mapbox.com/style-spec/reference/layers/#filter",
    example: '["==",["get","class"],"residential"]',
  },
  // Mapbox Standard style config properties (applied via setConfigProperty('basemap', key, value))
  lightPreset: {
    summary: "Standard style lighting preset. Values: 'dawn' | 'day' | 'dusk' | 'night'. Controls ambient light, shadows, and atmosphere. Apply with map.setConfigProperty('basemap','lightPreset','day').",
    url: "https://docs.mapbox.com/mapbox-gl-js/guides/use-mapbox-standard-style/",
    example: "map.setConfigProperty('basemap', 'lightPreset', 'dusk')",
  },
  showPointOfInterestLabels: {
    summary: "Standard config: show/hide all POI labels (global boolean). false = hides all POI labels for clean data overlays. Apply with setConfigProperty('basemap','showPointOfInterestLabels', false).",
    url: "https://docs.mapbox.com/mapbox-gl-js/guides/use-mapbox-standard-style/",
    example: "map.setConfigProperty('basemap', 'showPointOfInterestLabels', false)",
  },
  show3dBuildings: {
    summary: "Standard config: show/hide 3D building extrusions. Disable for real estate (parcels), data-viz, and high-density marker maps. setConfigProperty('basemap','show3dBuildings', false).",
    url: "https://docs.mapbox.com/mapbox-gl-js/guides/use-mapbox-standard-style/",
    example: "map.setConfigProperty('basemap', 'show3dBuildings', false)",
  },
  showLandmarkIcons: {
    summary: "Standard config: show/hide landmark 3D icons (Eiffel Tower, Big Ben, etc.). Useful as navigation anchors. setConfigProperty('basemap','showLandmarkIcons', true).",
    url: "https://docs.mapbox.com/mapbox-gl-js/guides/use-mapbox-standard-style/",
  },
  colorLand: {
    summary: "Standard config: override land background color. Must be ≥90% lightness on light themes. Apply with setConfigProperty('basemap','colorLand','#f5f3ef').",
    url: "https://docs.mapbox.com/mapbox-gl-js/guides/use-mapbox-standard-style/",
    example: "map.setConfigProperty('basemap', 'colorLand', '#f0ece4')",
  },
  colorWater: {
    summary: "Standard config: override water color. Keep S≥70% for night-safety contrast. setConfigProperty('basemap','colorWater','#a8d4e6').",
    url: "https://docs.mapbox.com/mapbox-gl-js/guides/use-mapbox-standard-style/",
  },
  slot: {
    summary: "Slot property on a layer tells Mapbox Standard where to insert custom layers relative to the basemap. Values: 'bottom' (under roads), 'middle' (above roads, under labels), 'top' (above everything).",
    url: "https://docs.mapbox.com/mapbox-gl-js/example/standard-style-customize-standard-layer/",
    example: '{ "id": "my-route", "type": "line", "slot": "top", ... }',
  },
  import: {
    summary: "Style fragment import — compose multiple style fragments into one map (Standard style composition). Used to load Standard as a base and layer custom fragments on top.",
    url: "https://docs.mapbox.com/mapbox-gl-js/guides/use-mapbox-standard-style/",
  },
};

export function getReference(topic: string): { found: boolean; entry?: ReferenceEntry; available?: string[] } {
  const raw = topic.trim();
  const key = raw.toLowerCase();

  // Require at least 2 characters to avoid spurious matches
  if (key.length < 2) {
    return { found: false, available: Object.keys(REFERENCE).slice(0, 20) };
  }

  // Exact match — try original casing first (handles camelCase like "lightPreset"), then lowercase
  if (REFERENCE[raw]) return { found: true, entry: REFERENCE[raw] };
  if (REFERENCE[key]) return { found: true, entry: REFERENCE[key] };

  const keys = Object.keys(REFERENCE);

  // Ranked fuzzy (case-insensitive): 1) key starts with query  2) query starts with key
  //   3) key contains query  4) query contains key (min length to prevent noise)
  const lkeys = keys.map((k) => k.toLowerCase());
  const prefixIdx = lkeys.findIndex((k) => k.startsWith(key));
  if (prefixIdx >= 0) return { found: true, entry: REFERENCE[keys[prefixIdx]] };

  const reversePrefixIdx = lkeys.findIndex((k) => key.startsWith(k) && k.length >= 4);
  if (reversePrefixIdx >= 0) return { found: true, entry: REFERENCE[keys[reversePrefixIdx]] };

  const containsIdx = lkeys.findIndex((k) => k.includes(key));
  if (containsIdx >= 0) return { found: true, entry: REFERENCE[keys[containsIdx]] };

  const reverseContainsIdx = lkeys.findIndex((k) => key.includes(k) && k.length >= 5);
  if (reverseContainsIdx >= 0) return { found: true, entry: REFERENCE[keys[reverseContainsIdx]] };

  // Check if it's a known expression operator
  if (OPERATORS[key]) {
    const op = OPERATORS[key];
    return {
      found: true,
      entry: {
        summary: `Expression operator "${key}": takes ${op.min === op.max ? op.min : `${op.min}–${op.max === Infinity ? "∞" : op.max}`} argument(s)${op.returnType ? `, returns ${op.returnType}` : ""}.`,
        url: `https://docs.mapbox.com/style-spec/reference/expressions/#${key}`,
      },
    };
  }

  return {
    found: false,
    available: Object.keys(REFERENCE),
  };
}
