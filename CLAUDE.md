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
npm test           # unit tests for native tool handlers (95 tests)
```

## Key files

| File | Purpose |
|------|---------|
| `src/index.ts` | Hono router — OAuth 2.0 PKCE flow, `/mcp` GET (discovery) + POST (dispatch), rate limiting, AES-GCM token encryption |
| `src/tools.ts` | Native tool implementations: `handleDesignAudit`, `handlePaletteSuggest`, `handleSegmentPreset` |
| `src/design-guidance.ts` | Cartographic knowledge base — **17** segment blocks + **10** topic blocks, `getGuidance()`. Shared constants: `MARKER_COUNT_RULE`, `NIGHT_LIGHTING_RULE`, `COLORBREWER_RULE`, `NO_HTML_MARKERS_ABOVE_100`. |
| `src/dev-patterns.ts` | 18 Mapbox GL JS code pattern modules. Re-exports `GL_JS_VERSION` from `gl-map-renderer.ts` as the single version source. |
| `src/gl-map-renderer.ts` | WebGL map screenshot via headless Chrome. Exports `GL_JS_VERSION` constant — update here to bump CDN URLs everywhere. |
| `src/projection.ts` | Web Mercator `project(lng,lat,viewport)` and `projectCoords` — lng/lat → `{x,y,in_view}` pixels. Used by `static_overlay`. |
| `src/expression-validator.ts` | GL expression validator + `getReference()`. Covers structural checks for `case`/`match`/`interpolate`/`step`, Standard-config reference entries. |
| `src/mode-brief.ts` | `modeBriefText(mode)` — system prompt for design vs make mode. |
| `scripts/test-tools.ts` | 95 unit tests — handlers, security (PKCE, redirect URI), segment parity, validator, GL version consistency. |
| `wrangler.toml` | Cloudflare config: KV (`SESSIONS`), Browser Rendering (`BROWSER`), `ENCRYPTION_KEY` secret docs. |

## Tool routing (17 tools)

- **No-auth tools**: `get_dev_patterns`, `get_design_guidance`, `design_audit`, `palette_suggest`, `segment_preset`, `category_search`
- **Auth-required tools**: `static_map`, `static_overlay`, `geocode`, `directions`, `isochrone`, `matrix`, `manage_style`, `manage_tokens`, `validate_expression`, `preview_style`, `get_reference`

## Mode gating

Tools are filtered per mode in `toolsForMode()` (`src/index.ts`):
- **Design mode** (`?mode=design`): hides `INTERACTIVE_ONLY_TOOLS` (GL JS / live map tools). Shows `static_overlay`.
- **Make mode** (default): hides `DESIGN_ONLY_TOOLS` (`static_overlay`). Shows `directions`, `isochrone`, `matrix`, etc.

Mode gating is enforced on both `tools/list` and `tools/call`, and on the legacy `{tool,input}` format.

## Image tool response contract

`static_map` and `static_overlay` always return image data in a **text block**:

- **WebGL render** (Standard style / config): bytes stored in KV under `img:<uuid>` (1-hour TTL), served at `GET /img/:key.png`. MCP response carries the URL. Figma workflow:
  ```bash
  curl "<url>" -o /tmp/map.png
  # upload_assets → POST bytes → place as image fill
  ```
- **Classic render** (non-Standard styles, `static_map` only): returns Static Images CDN URL — client fetches directly.
- **`static_overlay` only**: adds a second text block `{ viewport, overlays }` — pixel coords for placing editable vector layers.
- **Retina**: `retina:true` (default) doubles pixel dimensions on both WebGL (`deviceScaleFactor:2`) and static (`@2x`) paths.

## Security

- **PKCE**: mandatory S256 at `/oauth/token` — `code_verifier` always required.
- **`redirect_uri`** bound at code issuance and verified at token exchange.
- **`sk.*` tokens** envelope-encrypted (AES-256-GCM) in KV using the `ENCRYPTION_KEY` Worker secret. Set with `wrangler secret put ENCRYPTION_KEY`. Generate: `openssl rand -hex 32`.
- **`preview_style`** only emits `pk.*`-bearing URLs — refuses to embed secret tokens.
- **Rate limiting**: 120 tool calls/min/session on `/mcp`; 10 `/oauth/token` attempts/min/IP. KV fixed-window counters (`rl:` prefix).

## MCP protocol

- **Version**: `2025-06-18` (negotiated — echoes client-requested version when supported).
- **Server version**: `2.1.0` (aligned with `package.json`).
- JSON-RPC 2.0: `{ jsonrpc: "2.0", method: "tools/call", params: { name, arguments } }`
- Legacy: `{ tool, input }` — mode-gated, error-sanitized.

## Routes

| Route | Purpose |
|-------|---------|
| `GET /mcp` | MCP discovery (tools/list, prompts/list) |
| `POST /mcp` | MCP dispatch (tools/call, prompts/get, initialize) |
| `GET /authorize` | OAuth consent page |
| `POST /authorize/submit` | Submit token, issue auth code |
| `POST /oauth/token` | Exchange auth code for session token |
| `POST /session/revoke` | Revoke session |

## Testing

`npm test` runs 95 unit tests directly against handler functions — no HTTP round-trip. Tests cover: all native handlers, security primitives (PKCE S256 RFC 7636 vector, `isAllowedRedirectUri`), segment/PRESET parity, GL JS version consistency, expression validator structural checks, Standard-config `getReference`.

When adding a new native tool, add corresponding tests to `scripts/test-tools.ts`.

## Deployment

```bash
npm run deploy
```

Requires `wrangler login` (or `CLOUDFLARE_API_TOKEN`). The `SESSIONS` KV namespace must exist — ID in `wrangler.toml`. Set `ENCRYPTION_KEY` secret before first deploy: `wrangler secret put ENCRYPTION_KEY`.
