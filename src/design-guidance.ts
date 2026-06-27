export interface GuidanceBlock {
  principles: string[];
  do_list: string[];
  dont_list: string[];
  config_hints: Record<string, unknown>;
  color_targets?: {
    land_lightness_min?: number;
    road_contrast_against_land?: number;
    text_contrast_min?: number;
  };
}

// ── Segment guidance (13 entries) ────────────────────────────────────────────

export const SEGMENT_GUIDANCE: Record<string, GuidanceBlock> = {
  logistics_customer: {
    principles: [
      "Ambient, brand-faithful map — 'almost here' comfort aesthetic",
      "Courier dot is the only element that carries brand color",
      "Basemap recedes; delivery status UI is primary",
      "Light or faded preset works best — avoids driver-UI feel",
    ],
    do_list: [
      "Use theme:'faded' or theme:'monochrome' as base",
      "Apply brand color only to the courier/delivery marker",
      "Show ETA zone or route line at low opacity (0.3–0.4) in brand color",
      "Keep showPointOfInterestLabels:false — POIs compete with the delivery marker",
      "Use lightPreset:'day' or 'dusk' for ambient warmth",
    ],
    dont_list: [
      "Don't apply brand color to roads, water, or land — it looks like a playground",
      "Don't use dark theme — it signals night-mode / driver UI, wrong register",
      "Don't show 3D buildings — too complex for 'where is my order'",
      "Don't use HTML markers above 100 concurrent couriers on ops-adjacent views",
    ],
    config_hints: {
      theme: "faded",
      showPointOfInterestLabels: false,
      show3dBuildings: false,
      show3dObjects: false,
    },
    color_targets: { land_lightness_min: 90 },
  },

  logistics_driver: {
    principles: [
      "Maximum address legibility at z16+ — building numbers must be instantly readable",
      "Building footprints prominent at high zoom — driver needs to identify the specific building",
      "Light theme, no 3D — 3D obscures building addresses from a top-down view",
      "Route line in slot:'top' so it never disappears behind buildings",
    ],
    do_list: [
      "Use lightPreset:'day' (or 'dawn' for early shifts)",
      "Enable show3dBuildings:false, showPedestrianRoads:true",
      "Route line: slot:'top', line-width ≥5px at z16, emissive-strength:1",
      "Show building footprints clearly — increase colorBuildings contrast vs land",
      "Keep showRoadLabels:true and showPlaceLabels:true for street navigation",
      "Zoom default to z17 for last-mile delivery view",
    ],
    dont_list: [
      "Don't use theme:'monochrome' — gray streets hurt address number contrast",
      "Don't show 3D landmarks or buildings — they occlude addresses",
      "Don't apply dark or night theme for daytime shifts",
      "Don't cluster markers at high zoom — driver needs individual stop markers",
    ],
    config_hints: {
      lightPreset: "day",
      show3dBuildings: false,
      show3dLandmarks: false,
      show3dObjects: false,
      showPedestrianRoads: true,
      showRoadLabels: true,
      showPlaceLabels: true,
    },
    color_targets: { land_lightness_min: 90, road_contrast_against_land: 15, text_contrast_min: 4.5 },
  },

  logistics_ops: {
    principles: [
      "Performance first — hundreds to thousands of vehicle markers",
      "Fleet dots and geofence zones are primary; basemap is backdrop",
      "Circle layers not HTML markers above 100 vehicles — DOM limit",
      "Clustering mandatory above 1,000 vehicles",
      "Geofence fills must not obscure streets — max 40% opacity",
    ],
    do_list: [
      "Use circle layers (GL-rendered) for all vehicle/courier markers",
      "Add clustering: { cluster:true, clusterMaxZoom:14, clusterRadius:50 }",
      "Geofence polygons: fill-opacity ≤0.40, emissive-strength:1, slot:'middle'",
      "Service zones: brand fill ≤15% opacity + solid brand line",
      "Restricted zones: red fill ≤20% opacity + dashed red line",
      "Use feature-state to swap icon per vehicle state (idle/active/low-battery)",
      "Use Monochrome or Faded theme — data is primary",
    ],
    dont_list: [
      "Don't use HTML markers above 100 vehicles — causes DOM freeze",
      "Don't use opaque geofence fills — they hide street context",
      "Don't show POI labels — ops view needs clean canvas",
      "Don't use 3D buildings — they compete with markers",
    ],
    config_hints: {
      theme: "monochrome",
      showPointOfInterestLabels: false,
      show3dBuildings: false,
      densityPointOfInterestLabels: 1,
    },
  },

  travel: {
    principles: [
      "Two distinct modes — discovery vs listings — choose one before designing",
      "Discovery: promote landmarks and POIs; pedestrian scale; 3D ON",
      "Listings: mute base so property/hotel pins read clearly; 3D OFF",
      "Both modes: demote highways, promote parks; design for pedestrian scale",
    ],
    do_list: [
      "Discovery mode: show3dBuildings:true, showLandmarkIcons:true, theme:'default' or 'outdoors'",
      "Listings mode: show3dBuildings:false, showLandmarkIcons:false, theme:'faded'",
      "Use lightPreset by time of day for atmosphere",
      "showPointOfInterestLabels:true in discovery; false in listings",
      "Use 'outdoors' or 'winter' theme for nature/adventure travel",
    ],
    dont_list: [
      "Don't mix discovery and listings mode styles — pick one per view",
      "Don't keep 3D landmarks ON in dense listings view — they occlude pins",
      "Don't use dark or monochrome for travel — destination context matters",
      "Don't forget: showPointOfInterestLabels is a global toggle, not zoom-based",
    ],
    config_hints: {
      showLandmarkIcons: true,
      show3dBuildings: true,
      showPointOfInterestLabels: true,
      theme: "default",
    },
  },

  real_estate: {
    principles: [
      "Pin primacy — listing markers must read instantly, everything else is context",
      "Muted basemap — desaturate everything that isn't a listing",
      "3D buildings OFF — they obscure parcels at z16+",
      "Clustering mandatory above z10 for dense markets",
    ],
    do_list: [
      "Use theme:'faded' or Light preset as base",
      "Show3dBuildings:false, show3dObjects:false",
      "For zoom-based POI toggle: separate symbol layer with minzoom:15, or setLayoutProperty in moveend",
      "Cluster listings: { cluster:true, clusterMaxZoom:14 }",
      "Multi-overlay (flood+school+commute): distinct ColorBrewer ramps per layer type",
      "Fit map to listing results on load: map.fitBounds(bbox, {padding:40})",
    ],
    dont_list: [
      "Don't use showPointOfInterestLabels as a zoom-based toggle — it's global boolean only",
      "Don't show 3D buildings or landmarks — they occlude parcels",
      "Don't use high-saturation basemap colors — listings need clear contrast",
      "Don't skip clustering — dense markets with individual markers at z10 freeze the map",
    ],
    config_hints: {
      theme: "faded",
      show3dBuildings: false,
      show3dObjects: false,
      show3dLandmarks: false,
      showPointOfInterestLabels: false,
      densityPointOfInterestLabels: 1,
    },
    color_targets: { land_lightness_min: 92 },
  },

  automotive: {
    principles: [
      "Route line must be above all POIs and buildings — always slot:'top'",
      "Night mode must be explicitly designed — never CSS invert() or algorithmic derivation",
      "Brand color on route line only — not on basemap roads or water",
      "Over-styling 3D landmarks is the #1 automotive mistake — they must never compete with route",
    ],
    do_list: [
      "Route line: slot:'top', line-occlusion-opacity for tunnel/building overlap",
      "Night: lightPreset:'night' + dark theme + explicit color overrides per layer",
      "Show lane geometry at z17+ for turn-by-turn",
      "Night route: use BRIGHTER color than day — signal needs more luminance in dark",
      "High-contrast road labels with halos passing WCAG in both day and night",
      "Build day and night palettes in tandem, not sequentially",
    ],
    dont_list: [
      "Don't use CSS invert() for night mode — it breaks route legibility",
      "Don't apply brand color to basemap roads — route line loses primacy",
      "Don't over-style 3D landmarks — Eiffel Tower as navigation anchor, not hero element",
      "Don't set lightPreset:'night' alone as the full night palette — it changes lighting, not color hierarchy",
    ],
    config_hints: {
      show3dObjects: true,
      show3dBuildings: true,
      showRoadLabels: true,
      showPlaceLabels: true,
    },
    color_targets: { text_contrast_min: 4.5 },
  },

  data_viz: {
    principles: [
      "Basemap is backdrop only — use Light or Monochrome to let data speak",
      "Data layer color: sequential or diverging ColorBrewer ramp — never rainbow/spectral",
      "Turn off all POI labels at high zoom — they compete with data",
      "Use Mapbox Boundaries for admin polygons — don't re-upload what exists",
    ],
    do_list: [
      "Use theme:'monochrome' or theme:'faded' for basemap",
      "Choropleth: sequential ramp for one-direction data (Blues, Oranges, Purples)",
      "Choropleth: diverging ramp for pos/neg data (RdBu, PuOr) — avoid red+green",
      "Normalize all values: per capita, per km², percentage — never raw counts",
      "Choropleth fill-opacity: 0.7 max — let road network show through",
      "Turn off showPointOfInterestLabels, showPlaceLabels at high zoom",
    ],
    dont_list: [
      "Don't use rainbow/spectral for ordered data — yellow reads as peak, green as 'good'",
      "Don't map raw counts to polygon color — large areas mislead (Montana vs NJ problem)",
      "Don't use a high-saturation basemap with data overlays — data disappears",
      "Don't skip colorblind simulation — deuteranopia is most common (~8% of males)",
    ],
    config_hints: {
      theme: "monochrome",
      showPointOfInterestLabels: false,
      show3dBuildings: false,
      densityPointOfInterestLabels: 1,
    },
  },

  outdoors: {
    principles: [
      "Terrain and contours dominant — use Outdoors or Winter theme",
      "Paths/cycleways get visual prominence over car roads — may require Classic mode",
      "GPS traces: line-width expression scaling with zoom, never >4px at z14",
      "Filter commercial POIs entirely — show only campsites, trailheads, water sources",
    ],
    do_list: [
      "Use theme:'outdoors' or theme:'winter' as base",
      "Show terrain relief — consider Standard outdoors or a hillshade raster layer",
      "GPS trace line: line-width: ['interpolate',['linear'],['zoom'], 10, 1, 16, 4]",
      "For trail prominence: switch to Classic to control cycleway layer order explicitly",
      "Remove or minimize commercial POI layers",
    ],
    dont_list: [
      "Don't use Standard default theme — outdoors context needs terrain emphasis",
      "Don't show commercial POIs (restaurants, shops) — they distract from trail context",
      "Don't use a GPS trace wider than 4px at z14 — dominates over terrain",
      "Don't use dark theme for outdoor activities — terrain contrast suffers",
    ],
    config_hints: {
      theme: "outdoors",
      show3dObjects: true,
      showPointOfInterestLabels: false,
    },
  },

  social: {
    principles: [
      "Personality matters — muted, playful base with strong accent on POIs",
      "Design for portrait phone framing first (9:16 aspect ratio)",
      "POI density high at z13–16, clustered at lower zooms",
      "Never leave default Mapbox blue water on a branded consumer product",
    ],
    do_list: [
      "Use theme:'faded' as base, apply brand color to markers and UI only",
      "High POI density at street level: densityPointOfInterestLabels:4–5 at z13+",
      "Override colorWater with brand-aligned color — blue is generic",
      "Cluster POIs below z12: { cluster:true, clusterMaxZoom:12 }",
      "Portrait framing: test all designs at 390×844 viewport (iPhone 15 Pro)",
    ],
    dont_list: [
      "Don't leave default blue water — it reads as generic Google Maps",
      "Don't design for landscape first — mobile social is portrait",
      "Don't use dense basemap labels at lower zooms — they compete with social content",
      "Don't apply brand color to roads or land — markers need contrast with base",
    ],
    config_hints: {
      theme: "faded",
      showPointOfInterestLabels: true,
      densityPointOfInterestLabels: 4,
      show3dBuildings: false,
    },
  },

  journalism: {
    principles: [
      "Minimal house-style basemap — Light/Faded + publication-specific typography",
      "Projection matters for global stories — web Mercator distorts area at national/global scale",
      "Flat reads faster, loads faster, misleads less — avoid 3D on data stories",
      "Mobile fallback mandatory: Static Images API for AMP/social embeds",
    ],
    do_list: [
      "Use theme:'faded' or theme:'monochrome' as base",
      "For global/national maps: map.setProjection('equalEarth') or 'albers' for US",
      "Sequential ramp for one-direction data (Blues, Oranges, Purples)",
      "Diverging ramp for political/pos-neg (RdBu, PuOr) — never red+green",
      "Normalize all values — never raw counts for choropleth",
      "Build Static Images API fallback for non-interactive embeds",
    ],
    dont_list: [
      "Don't use web Mercator for country/world-scale area comparisons",
      "Don't use rainbow/spectral for any ordered data",
      "Don't use 3D buildings or landmarks — flat is faster and clearer for journalism",
      "Don't skip the mobile fallback — AMP pages can't load MapboxGL",
    ],
    config_hints: {
      theme: "faded",
      show3dBuildings: false,
      show3dObjects: false,
      showPointOfInterestLabels: false,
    },
  },

  retail: {
    principles: [
      "Generic 'blue water beige land' is the #1 retail mistake — always brand it",
      "Brand color on markers and UI chrome only — not on basemap",
      "Use Address Autofill for checkout (Search Box API, not raw Geocoding API)",
      "Auto-zoom to results on load",
    ],
    do_list: [
      "Use theme:'faded' or theme:'monochrome' as base",
      "Apply brand color to store markers and cluster circles only",
      "Auto-fit results: map.fitBounds(turf.bbox(allStores), {padding:40})",
      "Use Static Images API for store thumbnails, email receipts, social cards",
      "Search Box API for address autocomplete (not raw /geocoding/v6/)",
    ],
    dont_list: [
      "Don't leave default blue water and beige land — it's visually indistinct",
      "Don't apply brand color to roads or water — markers lose contrast",
      "Don't use raw Geocoding API for checkout address input — too many keystrokes",
      "Don't show 3D buildings unless wayfinding is critical",
    ],
    config_hints: {
      theme: "faded",
      showPointOfInterestLabels: false,
      show3dBuildings: false,
    },
  },

  weather: {
    principles: [
      "Raster overlays are primary — animated radar, precipitation, satellite imagery",
      "Weather color ramps are conventional — NEVER custom palette for precip/temp",
      "NEVER dark basemap under weather radar — it washes out the color data",
      "Broadcast vs mobile: full animation on desktop, Static Images API for sharing",
    ],
    do_list: [
      "Use raster-particle layer (v3) for animated wind/precipitation",
      "Use raster layer for static radar tiles",
      "Temperature ramp: blue(cold) → white(neutral) → red(hot)",
      "Precipitation ramp: yellow → green → blue → purple (meteorological standard)",
      "Use light basemap (theme:'faded' or Outdoors) under radar overlay",
    ],
    dont_list: [
      "Don't use custom palette for weather data — meteorological conventions exist for safety",
      "Don't use dark basemap under weather radar — color data washes out",
      "Don't skip the Static Images API fallback for social sharing",
      "Don't use 3D buildings or landmarks — they add visual noise to weather data",
    ],
    config_hints: {
      theme: "faded",
      show3dBuildings: false,
      show3dObjects: false,
      showPointOfInterestLabels: false,
    },
  },

  public_sector: {
    principles: [
      "OPPOSITE of consumer design rules: no animated 3D, no dark themes, no decorative styling",
      "Maximum accessibility: WCAG AA throughout, large tap targets",
      "Hazard data is primary: wildfires/floods/tracks in slot:'top', high contrast",
      "Trust > aesthetics — every design decision evaluated against legibility under stress",
    ],
    do_list: [
      "Use Light or Standard faded theme — restrained colors only",
      "WCAG AA (4.5:1) minimum for all text/icon pairs",
      "Hazard layers: slot:'top', fill-emissive-strength:1, high contrast against basemap",
      "Build Static Images API fallback for spike traffic scenarios",
      "Use conventional emergency color coding: red=danger, orange=warning, yellow=watch",
      "Large tap targets: minimum 44×44px for touch interfaces",
    ],
    dont_list: [
      "Don't use dark, animated, or 3D decorative features",
      "Don't use low-contrast color choices — legibility under stress is non-negotiable",
      "Don't use experimental features — stability required for emergency response",
      "Don't skip the static fallback — systems must work under traffic spikes",
    ],
    config_hints: {
      theme: "default",
      show3dObjects: false,
      show3dBuildings: false,
      show3dLandmarks: false,
      showPointOfInterestLabels: false,
    },
    color_targets: { text_contrast_min: 4.5 },
  },
};

// ── Topic guidance (8 entries) ────────────────────────────────────────────────

export const TOPIC_GUIDANCE: Record<string, GuidanceBlock> = {
  color: {
    principles: [
      "Build palettes in OKLCH or LCh, NOT HSL — HSL treats all hues as equal in perceived lightness",
      "Day mode hierarchy (light→dark): land → buildings → greenspace → roads → water (by saturation)",
      "colorWater must distinguish by hue+saturation, not just lightness — S ≥ 70% always",
      "Brand color goes on routes, markers, pins — never on basemap roads or water",
      "Cross-preset safety: design for day; constraints (land L≥90%, water S≥70%) make all presets work",
    ],
    do_list: [
      "colorLand: L ≥ 90%, S < 25%, warm hue H 20-30° for classic; cool for maritime",
      "colorBuildings: L 83-90%, slightly warm",
      "colorRoads: L 68-75%, blue-gray family (H 215-225°, S 15-25%)",
      "colorWater: L 65-75%, S ≥ 70%, blue H 195-210°",
      "colorMotorways: 5-8% L darker than colorRoads — always maintain road hierarchy",
      "Test with deuteranopia simulator — most common colorblind variant (~8% of males)",
      "WCAG AA: 4.5:1 for normal text, 3:1 for large text and road lines",
    ],
    dont_list: [
      "Don't make land darker than roads — destroys navigation readability",
      "Don't make water the same saturation as land — S distinguishes water at night",
      "Don't set all road variants to same L value — motorways must be darker than local roads",
      "Don't use HSL for palette generation — yellow at max chroma ≈ as light as white in HSL",
      "Don't use red+green as sole distinction — colorblind failure",
    ],
    config_hints: {
      colorLand: "hsl(28, 15%, 95%)",
      colorBuildings: "hsl(35, 18%, 87%)",
      colorRoads: "hsl(218, 18%, 72%)",
      colorWater: "hsl(202, 75%, 70%)",
    },
    color_targets: {
      land_lightness_min: 90,
      road_contrast_against_land: 15,
      text_contrast_min: 4.5,
    },
  },

  hierarchy: {
    principles: [
      "6-level visual hierarchy: user content → POI/labels → road labels → roads → buildings → land",
      "Figure-ground: subject must visually SEPARATE from context — desaturate base, keep data vivid",
      "Route covering a POI icon is correct. A POI obscuring a route is wrong.",
      "colorBuildings must be lighter than colorRoads in day mode — structures float above roads",
    ],
    do_list: [
      "Custom data layers: slot:'top' for routes/markers, slot:'middle' for fills, slot:'bottom' for rasters",
      "Add fill-emissive-strength:1 or line-emissive-strength:1 to all non-3D custom layers",
      "Route line: line-occlusion-opacity to handle 3D building overlap",
      "When data isn't popping: lighten/desaturate the basemap, not the data",
      "Use theme:'faded' or theme:'monochrome' for data-overlay maps",
    ],
    dont_list: [
      "Don't skip emissive-strength on custom layers — they become nearly invisible at dusk/night",
      "Don't use 3D buildings when they compete with primary data markers",
      "Don't set slot:'bottom' for routes — they'll appear under basemap features",
      "Don't add fill-extrusion-emissive-strength — 3D buildings need lighting for form",
    ],
    config_hints: {
      "slot_top": "routes, markers, active selections",
      "slot_middle": "choropleth fills, geofences, polygon overlays",
      "slot_bottom": "raster imagery, terrain",
      "emissive_rule": "all non-3D custom layers need emissive-strength:1",
    },
  },

  typography: {
    principles: [
      "Weight rule (Yandex 2025): medium/bold weight + subtle thin halo = clean signal. Thin font + bright outline = noise trap.",
      "Single family, 2 weights max (regular + medium/bold); geometric sans for navigation",
      "Italic reserved for water body labels (Imhof 1962 cartographic convention)",
      "Road labels: ALL CAPS (creates a visually separate layer from place names)",
    ],
    do_list: [
      "Navigation: car maneuver numeral ≥32pt, next street name ≥20pt",
      "Mobile nav: maneuver numeral ≥24pt, next street name ≥16pt",
      "When unsure: go heavier on weight, lighter on halo",
      "Label placement: upper-right first, upper-left second (Imhof rules)",
      "Water labels: italic, blue-tinted, follow the body's major axis",
    ],
    dont_list: [
      "Don't use thin font + aggressive bright outline — outline louder than text",
      "Don't use script, italic, or condensed for road labels or nav instructions",
      "Don't use two font families — creates visual noise on already busy maps",
      "Don't shrink labels when they conflict — drop lower-priority labels instead",
    ],
    config_hints: {
      font: "DIN Pro",
      "weight_rule": "medium/bold weight, not thin",
      "halo_rule": "subtle thin halo, never thick bright halo",
    },
  },

  performance: {
    principles: [
      "Marker count determines rendering approach — DOM (HTML) vs GL (symbol/circle) vs tileset",
      "Each layer = one GPU draw call per frame — keep custom layers ≤ 15 total",
      "GeoJSON is fine up to ~500 features or ~500KB; above that use Mapbox Tiling Service",
      "Multiple layers CAN share one source — fill + line + label on same dataset",
    ],
    do_list: [
      "< 100 markers: HTML Marker or Symbol layer — either fine",
      "100–1,000 markers: Symbol or Circle layer (GL-rendered, not DOM)",
      "1,000–10,000 markers: Clustered Symbol/Circle layer",
      "> 10,000 markers: Vector tileset — GeoJSON will freeze the map",
      "Source reuse: share one source for fill + line + label layers on same data",
      "Style order: set map style before adding sources/layers (style.load event)",
    ],
    dont_list: [
      "Don't use HTML markers above 100 concurrent markers — DOM limit",
      "Don't create a separate source for each layer if they share data",
      "Don't use setStyle() for incremental updates — it reloads the entire style",
      "Don't set visibility:none and leave layers — remove layers that are never visible",
      "Don't use GeoJSON above 500 complex polygons — always tileset for large country/watershed data",
    ],
    config_hints: {
      "max_custom_layers": 15,
      "geojson_limit": "500 features or 500KB",
      "cluster_config": "{ cluster: true, clusterMaxZoom: 14, clusterRadius: 50 }",
    },
  },

  dark_mode: {
    principles: [
      "Never derive dark palette algorithmically from day — light/dark palettes must be designed independently",
      "lightPreset:'night' changes lighting only — it does NOT build a correct night color palette",
      "Night route must be BRIGHTER than day — primary signal needs more luminance to cut through dark",
      "POI icons at night: dark glyphs inside colored circles — NOT white glyphs (prevents 'blooming')",
    ],
    do_list: [
      "Night land: very dark blue-gray (~#0e1a26) — not pure black (too harsh, no depth)",
      "Night water: slightly lighter than land (maintains distinction without high saturation at night)",
      "Night roads: use roadsBrightness:0.5 — emissive-strength partially bypasses ambient",
      "Custom layers at night: add emissive-strength:1 to all non-3D layers",
      "LUT for global mood: warm golden hour: hue=20, sat=1.2, bright=1.05, contrast=1.1",
      "Use apply_lut for atmospheric effects ('cinematic', 'cold morning', 'vintage film')",
    ],
    dont_list: [
      "Don't use CSS invert() for dark mode — it breaks route and label legibility",
      "Don't set lightPreset:'night' as the complete night solution — explicit color overrides required",
      "Don't set colorBuildings to dark day values — night expression will make them near-black",
      "Don't set colorLand/colorBuildings to explicitly dark values AND use lightPreset:'night' — dark config + dark ambient = solid black surfaces",
      "Don't use low-saturation water at night — S<70% becomes indistinguishable from dark land",
    ],
    config_hints: {
      "night_land": "#0e1a26",
      "night_water": "#1a2d3e",
      "night_roads": "#2a3f5a",
      roadsBrightness: 0.5,
      "lut_starters": {
        "warm_golden_hour": { hue: 20, saturation: 1.2, brightness: 1.05, contrast: 1.1, vibrancy: 1.3 },
        "cold_misty": { hue: -20, saturation: 0.8, brightness: 1.1, contrast: 0.9 },
        "vintage_film": { saturation: 0.65, contrast: 1.2, brightness: 0.95, vibrancy: 0.8 },
        "noir": { saturation: 0.1, contrast: 1.6, brightness: 0.85 },
        "cyberpunk": { hue: -15, saturation: 1.4, brightness: 0.9, contrast: 1.3 },
      },
    },
    color_targets: { land_lightness_min: 0 },
  },

  data_viz: {
    principles: [
      "Choose the layer type by data volume: < 100 marker; 100-1k symbol/circle; 1k-50k clustered; >50k tileset",
      "Choropleth: normalize all values (per capita, rate, %) — never raw counts to polygon color",
      "Sequential ramp for one-direction data; diverging for pos/neg; qualitative for categories",
      "Never use rainbow/spectral for ordered data — yellow reads as peak, green as 'good'",
    ],
    do_list: [
      "Choropleth fill-opacity: 0.7 max — let road network show through for context",
      "Sequential ramps: Blues, Greens, Oranges, Purples, YlOrRd, BuPu",
      "Diverging ramps: RdBu, PuOr, BrBG — never RdGn (colorblind failure)",
      "Qualitative: Set1, Set2, Paired, Dark2 (≤8 categories)",
      "Clustering: { cluster:true, clusterMaxZoom:14, clusterRadius:50 }",
      "3D extrusions: fade in with zoom — never abrupt appearance at fixed zoom",
      "Heatmap: transition to circles at z14+ for individual point identity",
    ],
    dont_list: [
      "Don't use rainbow/spectral for any ordered data",
      "Don't map raw counts to choropleth — Montana vs New Jersey problem",
      "Don't use > 8 qualitative categories without 'i want hue' max-distinctness algorithm",
      "Don't extrude 3D polygons at zoom < 13 — too much GPU overdraw",
      "Don't skip colorblind simulation — deuteranopia is most common",
    ],
    config_hints: {
      "choropleth_opacity": 0.7,
      "cluster_config": "{ cluster: true, clusterMaxZoom: 14, clusterRadius: 50 }",
      "heatmap_opacity_expr": "['interpolate',['linear'],['zoom'], 7, 1, 9, 0]",
    },
  },

  zoom_strategy: {
    principles: [
      "z0–4: capitals, ocean labels only; z5–8: major cities, highways; z9–11: all highways, parks",
      "z12–15: all streets, building footprints, POIs (start POIs at z12 not z14)",
      "z16+: house numbers, parking lots, fine-grained amenities",
      "Default to z12 for custom styles — neighborhood scale, manageable density",
      "Zoom continuity: never abrupt minzoom cutoffs — fade features in/out over 1–2 zoom levels",
    ],
    do_list: [
      "Fade layers in: opacity: ['interpolate',['linear'],['zoom'], 11, 0, 12, 1]",
      "Fade layers out: opacity: ['interpolate',['linear'],['zoom'], 15, 1, 16, 0]",
      "Scale line-width with zoom: ['interpolate',['linear'],['zoom'], 10, 1, 16, 4]",
      "POIs: start at z12 minimum — z14 is too late for neighborhood-scale maps",
      "3D buildings: fade in starting at z13, never below",
    ],
    dont_list: [
      "Don't use hard minzoom/maxzoom cutoffs without opacity transitions — jarring appearance",
      "Don't start POIs at z14 for neighborhood maps — they appear too late",
      "Don't extrude 3D features below z13 — GPU overdraw at city scale",
      "Don't use fixed pixel sizes without zoom interpolation — labels and lines feel broken at extremes",
    ],
    config_hints: {
      "fade_in_expr": "['interpolate',['linear'],['zoom'], 11, 0, 12, 1]",
      "fade_out_expr": "['interpolate',['linear'],['zoom'], 15, 1, 16, 0]",
      "line_scale_expr": "['interpolate',['linear'],['zoom'], 10, 1, 16, 4]",
      "default_zoom": 12,
    },
  },

  icons: {
    principles: [
      "THREE options — Marker (mapboxgl.Marker + CSS backgroundImage): small sets <50, per-element interaction, use SVG/PNG file directly; Symbol layer (icon-image): 50+ points, collision detection, clustering, feature state; Dots (circle layer + text): dense data, no icon needed",
      "All custom layers go in slot:'top' — lower slots bury markers under roads and basemap labels",
      "SVG for symbol layers must have flat fills only — gradients/filters break canvas rasterization; for Figma Make SVGs strip <defs>/<linearGradient>/<filter>/<clipPath> and replace gradient refs with flat hex",
      "icon-size must be a zoom-interpolate expression — a flat number looks wrong across zoom levels",
    ],
    do_list: [
      "Marker option: el.style.backgroundImage = 'url(/icons/pin.svg)' — SVG or PNG file, no rasterization needed",
      "Symbol layer option A (generic): icon-image:'marker' built-in, no loading needed, paint: { icon-color: '#hex' }",
      "Symbol layer option B (PNG): map.loadImage() → map.addImage() → symbol layer",
      "Symbol layer option C (SVG): svgToImageData(svgString, 48) → map.addImage('pin', img, { pixelRatio:2 }) → symbol layer",
      "Dots option: circle layer + symbol layer (text only) on same source, both slot:'top'",
      "Set text-optional:true — labels drop before icons in collision",
      "Always add a fallback to every 'match' expression — omitting it is a GL runtime error",
    ],
    dont_list: [
      "Don't use SVG gradient fills in symbol layer icons — they become muddy blobs after rasterization",
      "Don't use a flat icon-size value — use zoom-interpolate expression",
      "Don't use text-anchor:'center' when icon-image is also set — label lands on the icon",
      "Don't use sdf:true when SVG has multiple colors baked in — SDF strips fills to a single tintable channel",
      "Don't apply CSS transform (or will-change:transform) to any ancestor of the map container — it creates a stacking context that makes marker positioning relative to that element instead of the viewport, causing markers to drift on zoom and pan.",
    ],
    config_hints: {
      "figma_make_svg_pipeline": "Figma Make is an AI code generator — SVGs are AI-authored paths. For Marker: use SVG file directly as backgroundImage, zero cleanup needed. For symbol layer: strip <defs>/<linearGradient>/<filter>/<clipPath>, replace fill='url(#...)' with flat hex, remove class= and style= attributes, ensure square viewBox.",
      "see_dev_patterns": "get_dev_patterns('pins_and_markers') for complete code — Marker, symbol layer (built-in/PNG/SVG), and dots patterns",
    },
  },

  standard_config: {
    principles: [
      "Standard style is the default — always prefer Standard over Classic for new maps",
      "setConfigProperty('basemap', key, value) controls all design without touching layer JSON",
      "Design for day mode — Standard adapts colors for other light presets automatically",
      "Do NOT set lightPreset unless user explicitly asked for a specific mood",
    ],
    do_list: [
      "Use the full config surface: lightPreset, theme, font, all color properties",
      "Toggle groups: show3dBuildings, showLandmarkIcons, showPlaceLabels, showPointOfInterestLabels",
      "POI density: densityPointOfInterestLabels 1–5 (default 3)",
      "Only switch to Classic when per-layer paint expressions are needed that config can't express",
      "For theme:'custom' + LUT: understand config colors are inputs to LUT, not final rendered colors",
    ],
    dont_list: [
      "Don't use setStyle() to switch between Standard presets — use setConfigProperty()",
      "Don't parse raw Standard layer JSON for color values — use buildStyleContext() output",
      "Don't set lightPreset:'night' as the complete dark solution — add explicit layer overrides",
      "Don't switch to Classic just to change themed colors — Standard config handles that",
    ],
    config_hints: {
      "basemap_keys": {
        lightPreset: "dawn|day|dusk|night",
        theme: "default|faded|monochrome|cool|warm|outdoors|winter|custom",
        font: "DIN Pro (default)",
        showPlaceLabels: true,
        showPointOfInterestLabels: true,
        show3dBuildings: true,
        show3dObjects: true,
        densityPointOfInterestLabels: "1-5 (default 3)",
      },
    },
  },
};

// ── Lookup helpers ────────────────────────────────────────────────────────────

export const SEGMENT_KEYS = Object.keys(SEGMENT_GUIDANCE);
export const TOPIC_KEYS = Object.keys(TOPIC_GUIDANCE);

export function getGuidance(segment?: string, topic?: string): {
  guidance: GuidanceBlock;
  source: "segment" | "topic" | "combined" | "overview";
  also_call: string[];
} {
  const hasSegment = segment && SEGMENT_GUIDANCE[segment];
  const hasTopic = topic && TOPIC_GUIDANCE[topic];

  if (hasSegment && hasTopic) {
    const seg = SEGMENT_GUIDANCE[segment!]!;
    const top = TOPIC_GUIDANCE[topic!]!;
    const merged: GuidanceBlock = {
      principles: [...seg.principles, ...top.principles],
      do_list: [...seg.do_list, ...top.do_list],
      dont_list: [...seg.dont_list, ...top.dont_list],
      config_hints: { ...seg.config_hints, ...top.config_hints },
      color_targets: seg.color_targets ?? top.color_targets,
    };
    return {
      guidance: merged,
      source: "combined",
      also_call: ["segment_preset", "design_audit"],
    };
  }

  if (hasSegment) {
    return {
      guidance: SEGMENT_GUIDANCE[segment!]!,
      source: "segment",
      also_call: ["segment_preset", "get_dev_patterns"],
    };
  }

  if (hasTopic) {
    const hints: string[] = [];
    if (topic === "color") hints.push("palette_suggest", "wcag_validate");
    else if (topic === "dark_mode") hints.push("wcag_validate");
    else if (topic === "data_viz" || topic === "performance") hints.push("get_dev_patterns");
    hints.push("design_audit");
    return {
      guidance: TOPIC_GUIDANCE[topic!]!,
      source: "topic",
      also_call: hints,
    };
  }

  // Overview: merge top principles from all topic blocks
  const overview: GuidanceBlock = {
    principles: [
      "Build palettes in OKLCH/LCh — not HSL. colorWater S≥70% always for night-safety.",
      "Visual hierarchy (top→bottom): user content → POI/labels → roads → buildings → land.",
      "Marker count drives rendering: <100 HTML/Symbol, 100-1k GL circle, 1k-10k clustered, >10k tileset.",
      "Route line: always slot:'top', emissive-strength:1 on all non-3D custom layers.",
      "Zoom continuity: fade layers in/out over 1–2 zoom levels — no hard cutoffs.",
      "Standard config covers 95% of design needs — only switch to Classic for per-layer paint expressions.",
      "Night mode: design explicitly — lightPreset:'night' only changes lighting, not color hierarchy.",
    ],
    do_list: [
      "Call get_design_guidance(segment=) for use-case rules before choosing colors or config",
      "Call segment_preset(segment=) for a ready-to-apply Standard config patch",
      "Call design_audit() after generating a style to catch violations",
      "Use theme:'faded' or 'monochrome' for data-overlay maps",
      "Always normalize choropleth values — never raw counts to polygon color",
      "WCAG AA (4.5:1) for all text; 3:1 for large text and road lines",
    ],
    dont_list: [
      "Don't make land darker than roads",
      "Don't leave default blue water on branded consumer products",
      "Don't use HTML markers above 100 concurrent markers",
      "Don't use rainbow/spectral for ordered data",
      "Don't set lightPreset:'night' as the complete dark solution",
    ],
    config_hints: {
      "use_segment_for": "logistics, travel, real_estate, automotive, data_viz, outdoors, social, journalism, retail, weather, public_sector",
      "use_topic_for": "color, hierarchy, typography, performance, dark_mode, data_viz, zoom_strategy, standard_config",
    },
  };

  return { guidance: overview, source: "overview", also_call: ["segment_preset", "design_audit"] };
}
