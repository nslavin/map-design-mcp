# AGENTS.md

This file provides guidance to Codex when working in this repository.

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
| `scripts/test-tools.ts` | Unit tests for all native handlers — run with `npm test` |
| `wrangler.toml` | Cloudflare config: KV binding (`SESSIONS`), compatibility flags |

## Tool routing

- **No-auth tools**: `get_dev_patterns`, `get_design_guidance`, `design_audit`, `palette_suggest`, `segment_preset`, `wcag_validate`
- **Auth-required tools**: Styles API + Tokens API (direct), Mapbox MCP proxy, DevKit MCP proxy

## MCP protocol

The `/mcp` endpoint accepts both:
- JSON-RPC 2.0: `{ jsonrpc: "2.0", method: "tools/call", params: { name, arguments } }`
- Legacy format: `{ tool, input }`

Upstream MCP responses may be SSE (`text/event-stream`) — `proxyMcpTool()` handles both SSE and plain JSON.

## Testing

`npm test` runs unit tests directly against the handler functions — no HTTP round-trip needed. Tests live in `scripts/test-tools.ts`.

When adding a new native tool, add corresponding tests to `scripts/test-tools.ts`.

## Deployment

```bash
npm run deploy
```

Requires `wrangler login` (or `CLOUDFLARE_API_TOKEN` env var). The `SESSIONS` KV namespace must exist — its ID is in `wrangler.toml`.
