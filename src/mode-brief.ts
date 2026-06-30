/** Client mode for mode-gating and instructions. */
export type ClientMode = "design" | "make";

export function modeBriefText(mode: ClientMode): string {
  if (mode === "design") {
    return `MAP DESIGN MODE — Figma Design (static only)

Tools to use:
  • static_map — returns TWO text blocks: (1) a PNG URL you can curl, (2) a data URI fallback.
      Preferred: curl "<url>" -o /tmp/map.png
      Fallback if curl is blocked: echo "$DATA_URI" | sed 's/data:[^;]*;base64,//' | base64 -d > /tmp/map.png
      Then: upload_assets → POST bytes → place as image fill on the target node.
  • static_overlay — same two image blocks as static_map PLUS a third text block:
        { viewport, overlays: { markers, routes, isochrones } }
      Each overlay entry has {x, y, in_view} pixel coords. Place the image fill first,
      then draw vector pins/paths at those pixel positions on top.
  • segment_preset, preview_style — style previews
  • geocode — resolve addresses to coordinates
  • get_design_guidance, design_audit, palette_suggest
  • manage_style — list/retrieve/create/update/delete Mapbox styles
  • manage_tokens — list/create Mapbox public access tokens

Do not write Mapbox GL JS code. Do not call get_dev_patterns, directions, isochrone, matrix, category_search, validate_expression, or get_reference.`;
  }

  return `MAP DESIGN MODE — Figma Make (interactive)

Start every new map with get_dev_patterns(pattern='scaffolding') — it has the token setup and common root causes of invisible maps.

Use get_design_guidance, design_audit, palette_suggest for cartographic quality.
Use static_map / segment_preset for quick image previews.`;
}
