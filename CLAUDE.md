# CLAUDE.md

This file provides guidance to Claude Code when working in this repository.

## What this is

A standalone Cloudflare Worker (Hono framework) that serves as an MCP gateway for Mapbox map design tools.

## Build & Run

```bash
npm install
npm run dev        # local worker on localhost:8787
npm run deploy     # deploy to Cloudflare (requires wrangler login)
npm run typecheck  # TypeScript check only
npm test           # unit tests for native tool handlers
```

## Key files

| File | Purpose |
|------|---------|
| `src/index.ts` | Hono router — OAuth 2.0 PKCE flow, `/mcp` GET (discovery) + POST (dispatch) |
| `src/tools.ts` | Native tool implementations: `handleDesignAudit`, `handlePaletteSuggest`, `handleSegmentPreset`, `handleWcagValidate` |
| `src/design-guidance.ts` | Cartographic knowledge base — 13 segment blocks + 8 topic blocks, `getGuidance()` |
| `src/dev-patterns.ts` | 16 Mapbox GL JS v3 code pattern modules, `handleGetDevPatterns()` |
| `src/projection.ts` | Web Mercator `project(lng,lat,viewport)` and `projectCoords` — lng/lat → `{x,y,in_view}` pixel coords relative to a static map image. Used by `static_overlay`. |
| `src/mode-brief.ts` | `modeBriefText(mode)` — system prompt for design vs make mode (single source of truth for both `initialize.instructions` and the `mode_brief` prompt). |
| `src/maki-icons.ts` | 19 Maki icons as inline SVGs (CC0) — used in `svgToImageData` demo code |
| `scripts/test-tools.ts` | Unit tests for all native handlers — run with `npm test` |
| `wrangler.toml` | Cloudflare config: KV binding (`SESSIONS`), compatibility flags |

## Tool routing

- **No-auth tools**: `get_dev_patterns`, `get_design_guidance`, `design_audit`, `palette_suggest`, `segment_preset`, `wcag_validate`, `category_search`
- **Auth-required tools**: `static_map`, `static_overlay`, `geocode`, `directions`, `isochrone`, `matrix`, Styles API, Tokens API, `check_color_contrast`, `validate_expression`, `preview_style`, `get_reference`

## Mode gating

Tools are filtered per mode in `toolsForMode()` (`src/index.ts`):
- **Design mode** (`?mode=design`): hides `INTERACTIVE_ONLY_TOOLS` (GL JS / live map tools). Shows `static_overlay`.
- **Make mode** (default): hides `DESIGN_ONLY_TOOLS` (`static_overlay` — Make builds live maps). Shows `directions`, `isochrone`, `matrix`, etc.

`DESIGN_ONLY_TOOLS` and `INTERACTIVE_ONLY_TOOLS` are exported sets in `src/index.ts`.

## MCP protocol

The `/mcp` endpoint accepts both:
- JSON-RPC 2.0: `{ jsonrpc: "2.0", method: "tools/call", params: { name, arguments } }`
- Legacy format: `{ tool, input }`

All tool dispatches are native `fetch()` calls to Mapbox REST APIs — no proxy layer.

## Testing

`npm test` runs unit tests directly against the handler functions — no HTTP round-trip needed. Tests live in `scripts/test-tools.ts`.

When adding a new native tool, add corresponding tests to `scripts/test-tools.ts`.

## Deployment

```bash
npm run deploy
```

Requires `wrangler login` (or `CLOUDFLARE_API_TOKEN` env var). The `SESSIONS` KV namespace must exist — its ID is in `wrangler.toml`.
