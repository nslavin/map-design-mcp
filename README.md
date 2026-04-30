# map-design-mcp

Cloudflare Worker that serves as an MCP gateway for Mapbox map design tools. Used by the [Figma Map Studio](https://github.com/nslavin/figma-map-studio) plugin and by Figma Make / Claude Code as a single-URL MCP connector.

**Deployed at:** `https://map-design-mcp.workers.dev`

## Tools

### Native design tools (no auth required)

| Tool | Description |
|------|-------------|
| `get_design_guidance` | Cartographic guidance by segment (real_estate, logistics, automotive, …) or topic (color, hierarchy, typography, …) |
| `design_audit` | Audit a Mapbox style for visual hierarchy, WCAG contrast, and performance violations |
| `palette_suggest` | Generate a WCAG-compliant color palette from a brand color + segment |
| `segment_preset` | Ready-to-apply Standard config for 16 map use-case segments |
| `wcag_validate` | Validate text/background color pairs against WCAG AA or AAA |
| `get_dev_patterns` | Copy-pasteable Mapbox GL JS v3 implementation patterns |

### Proxied tools (require Mapbox token via OAuth)

**Mapbox APIs** (`geocode`, `directions`, `isochrone`, `matrix`, `static_map`, `category_search`) — forwarded to `mcp.mapbox.com`

**Mapbox DevKit** (`check_color_contrast`, `validate_expression`, `preview_style`, `get_reference`) — forwarded to `mcp-devkit.mapbox.com`

**Styles & Tokens API** (`list_styles`, `retrieve_style`, `create_style`, `update_style`, `delete_style`, `list_tokens`, `create_token`) — direct Mapbox API calls

## MCP connector URL

```
https://map-design-mcp.workers.dev/mcp
```

Use this URL in any MCP client. For tools that need a Mapbox token, the worker runs an OAuth 2.0 PKCE flow — paste your secret token (`sk.*`) into the consent form and the client handles auth automatically.

## Development

```bash
npm install
npm run dev        # wrangler dev (local worker on localhost:8787)
npm run deploy     # wrangler deploy to production
npm run typecheck  # tsc --noEmit
npm test           # run unit tests for native tool handlers
```

### KV namespace

Session tokens are stored in a Cloudflare KV namespace bound as `SESSIONS`. The namespace ID is in `wrangler.toml`. For local dev, `wrangler dev` creates an in-memory KV automatically.

## Architecture

```
src/
├── index.ts          — Hono router, OAuth 2.0 PKCE flow, MCP tool dispatcher
├── tools.ts          — Native tool implementations (audit, palette, preset, wcag)
├── design-guidance.ts — Cartographic knowledge base (13 segments, 8 topics)
└── dev-patterns.ts   — Mapbox GL JS v3 code patterns (16 modules)

scripts/
└── test-tools.ts     — Unit tests for native tool handlers
```

**Auth model:** OAuth issues a session UUID stored in KV (30-day TTL). The client sends `Authorization: Bearer <uuid>` — the actual Mapbox token is never exposed to the caller after the initial consent form.
