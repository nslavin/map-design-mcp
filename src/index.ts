/**
 * Map Design MCP Gateway — Cloudflare Worker
 *
 * Aggregator endpoint for MCP clients (Claude Code, Cursor, etc.). Serves native design tools,
 * proxies Mapbox MCP + DevKit MCP, and provides Mapbox Styles/Tokens API tools.
 *
 * MCP endpoint: https://map-design-mcp.workers.dev/mcp
 * Auth: MCP OAuth 2.0 — browser opens consent page, user pastes sk.* token,
 *   session UUID is issued and stored in KV (30-day TTL).
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import {
  handleDesignAudit,
  handleGetDesignGuidance,
  handlePaletteSuggest,
  handleSegmentPreset,
  handleWcagValidate,
} from "./tools";
import { SEGMENT_GUIDANCE, SEGMENT_KEYS, TOPIC_GUIDANCE, TOPIC_KEYS } from "./design-guidance";
import { DEV_PATTERNS, EXAMPLE_URLS, RELATED_PATTERNS, SEGMENT_NOTES } from "./dev-patterns";

// ── Tool routing ────────────────────────────────────────────────────────────

const MAPBOX_MCP_URL = "https://mcp.mapbox.com/mcp";
const DEVKIT_MCP_URL = "https://mcp-devkit.mapbox.com/mcp";

const MAPBOX_MCP_TOOLS = new Set([
  "geocode",
  "isochrone",
  "matrix",
  "static_map",
  "category_search",
]);

const DEVKIT_MCP_TOOLS = new Set([
  "check_color_contrast",
  "validate_expression",
  "preview_style",
  "get_reference",
]);

// ── Proxy helper ────────────────────────────────────────────────────────────

async function proxyMcp(
  upstream: string,
  toolName: string,
  input: Record<string, unknown>,
  token: string
): Promise<unknown> {
  const res = await fetch(upstream, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: toolName, arguments: input },
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`Upstream ${upstream} returned ${res.status}: ${text}`);
  }

  const contentType = res.headers.get("content-type") ?? "";
  let json: { result?: unknown; error?: { message?: string } };

  if (contentType.includes("text/event-stream")) {
    // Streamable HTTP transport: scan SSE lines for a data: payload
    const text = await res.text();
    const dataLine = text.split("\n").find((l) => l.startsWith("data:"));
    if (!dataLine) throw new Error("No data line in SSE response from upstream MCP");
    json = JSON.parse(dataLine.slice(5).trim()) as typeof json;
  } else {
    json = (await res.json()) as typeof json;
  }

  if (json.error) throw new Error(json.error.message ?? "Upstream MCP error");
  return json.result;
}

// ── Auth helpers ─────────────────────────────────────────────────────────────

function getUserNameFromToken(token: string): string {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Invalid JWT format");
  // Restore base64 padding before decoding (Mapbox tokens omit trailing =)
  const b64 = parts[1].padEnd(parts[1].length + (4 - (parts[1].length % 4)) % 4, "=");
  const payload = JSON.parse(atob(b64)) as Record<string, unknown>;
  if (typeof payload.u !== "string") throw new Error("No username in token payload");
  return payload.u;
}

async function getMapboxToken(authHeader: string | undefined, env: Env): Promise<string | null> {
  const bearer = authHeader?.replace(/^Bearer\s+/i, "").trim();
  // Dev fallback: when KV not configured, accept env token for local wrangler dev
  if (!bearer || bearer === "public") {
    return env.SESSIONS ? null : (env.MAPBOX_TOKEN ?? null);
  }
  return env.SESSIONS.get(`session:${bearer}`);
}

// ── Consent page HTML ─────────────────────────────────────────────────────────

function consentPageHtml(nonce: string, error?: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect Map Design MCP</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0a0a0a;color:#e8e8e8;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
  .card{background:#1a1a1a;border:1px solid #2a2a2a;border-radius:12px;padding:32px;max-width:480px;width:100%}
  h1{font-size:18px;font-weight:600;margin-bottom:8px}
  .sub{color:#888;font-size:13px;margin-bottom:24px;line-height:1.5}
  .sub a{color:#4d9fff;text-decoration:none}
  label{display:block;font-size:12px;font-weight:500;color:#aaa;margin-bottom:6px;letter-spacing:.04em;text-transform:uppercase}
  input{width:100%;background:#111;border:1px solid #333;border-radius:6px;padding:10px 12px;color:#e8e8e8;font-size:14px;font-family:monospace;outline:none}
  input:focus{border-color:#4d9fff}
  .scopes{background:#111;border:1px solid #2a2a2a;border-radius:6px;padding:10px 12px;font-size:12px;color:#888;font-family:monospace;margin:12px 0 20px;line-height:1.8}
  button{width:100%;background:#4d9fff;color:#fff;border:none;border-radius:6px;padding:11px;font-size:14px;font-weight:600;cursor:pointer;margin-top:4px}
  button:hover{background:#3d8fee}
  .error{background:#2a1010;border:1px solid #5a2020;border-radius:6px;padding:10px 12px;font-size:13px;color:#ff7070;margin-bottom:16px}
</style>
</head>
<body>
<div class="card">
  <h1>Connect Map Design MCP</h1>
  <p class="sub">Paste a Mapbox <strong>secret key</strong> (<code>sk.*</code>) to authorise this server.<br>
  <a href="https://account.mapbox.com/access-tokens" target="_blank" rel="noopener">Create a token →</a></p>
  ${error ? `<div class="error">${error}</div>` : ""}
  <form method="POST" action="/authorize/submit?nonce=${nonce}">
    <label>Required scopes</label>
    <div class="scopes">styles:read &nbsp; styles:list &nbsp; styles:write<br>styles:delete &nbsp; tokens:read &nbsp; tokens:write</div>
    <label for="token">Mapbox secret key</label>
    <input id="token" name="token" type="password" placeholder="sk.eyJ1…" autocomplete="off" required>
    <button type="submit">Authorise</button>
  </form>
</div>
</body>
</html>`;
}

// ── App ─────────────────────────────────────────────────────────────────────

type Env = { SESSIONS: KVNamespace; MAPBOX_TOKEN?: string };

const app = new Hono<{ Bindings: Env }>();
app.use("/*", cors({ origin: "*" }));

// ── OAuth 2.0 discovery (MCP 2025-03-26 spec) ──────────────────────────────

const OAUTH_SCOPES = ["styles:tiles", "styles:read", "styles:list", "styles:write", "styles:delete", "tokens:read", "tokens:write"];

app.get("/.well-known/oauth-protected-resource", (c) => {
  const base = `https://${c.req.header("host")}`;
  return c.json({ resource: base, authorization_servers: [base], bearer_methods_supported: ["header"], scopes_supported: OAUTH_SCOPES });
});
app.get("/.well-known/oauth-protected-resource/mcp", (c) => {
  const base = `https://${c.req.header("host")}`;
  return c.json({ resource: base, authorization_servers: [base], bearer_methods_supported: ["header"], scopes_supported: OAUTH_SCOPES });
});

app.get("/.well-known/oauth-authorization-server", (c) => {
  const base = `https://${c.req.header("host")}`;
  return c.json({
    issuer: base,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/oauth/token`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: OAUTH_SCOPES,
  });
});

// Keep openid-configuration for clients that check it
app.get("/.well-known/openid-configuration", (c) => {
  const base = `https://${c.req.header("host")}`;
  return c.json({
    issuer: base,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/oauth/token`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
  });
});

// Dynamic client registration — accept any client (public clients only, no secret)
app.post("/register", async (c) => {
  const body = await c.req.json<{ redirect_uris?: string[] }>().catch(() => ({ redirect_uris: [] as string[] }));
  return c.json({
    client_id: "map-studio-public",
    client_secret_expires_at: 0,
    redirect_uris: body.redirect_uris ?? [],
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code"],
    response_types: ["code"],
  }, 201);
});

// ── Authorization: serve consent form ──────────────────────────────────────

app.get("/authorize", async (c) => {
  const { redirect_uri, state, code_challenge, code_challenge_method } = c.req.query();
  if (!redirect_uri)
    return c.json({ error: "invalid_request", error_description: "missing redirect_uri" }, 400);
  try {
    const scheme = new URL(redirect_uri).protocol;
    if (!["https:", "http:", "claude:", "vscode:"].includes(scheme))
      return c.json({ error: "invalid_request", error_description: "invalid redirect_uri scheme" }, 400);
  } catch {
    return c.json({ error: "invalid_request", error_description: "invalid redirect_uri" }, 400);
  }
  if (code_challenge_method && code_challenge_method !== "S256")
    return c.json({ error: "invalid_request", error_description: "only S256 code_challenge_method is supported" }, 400);

  const nonce = crypto.randomUUID();
  await c.env.SESSIONS.put(
    `nonce:${nonce}`,
    JSON.stringify({ redirect_uri, state, code_challenge }),
    { expirationTtl: 600 },
  );
  return c.html(consentPageHtml(nonce));
});

app.post("/authorize/submit", async (c) => {
  const { nonce } = c.req.query();
  const body = await c.req.parseBody();
  const token = (body.token as string | undefined)?.trim() ?? "";

  const pending = await c.env.SESSIONS.get(`nonce:${nonce}`);
  if (!pending) return c.text("Session expired. Please go back and try again.", 400);
  const { redirect_uri, state: originalState, code_challenge } = JSON.parse(pending) as {
    redirect_uri: string; state?: string; code_challenge?: string;
  };

  // Basic JWT format check
  if (token.split(".").length !== 3)
    return c.html(consentPageHtml(nonce, "Invalid token format — Mapbox tokens have three dot-separated parts."));

  // Reject public tokens — this server requires a secret token
  if (token.startsWith("pk."))
    return c.html(consentPageHtml(nonce, "Public tokens (pk.*) cannot be used here. This server requires a secret token (sk.*) with the scopes listed above. Create one at account.mapbox.com/access-tokens."));

  // Validate the token decodes a username and check required scopes
  try {
    getUserNameFromToken(token);
    const parts = token.split(".");
    const b64 = parts[1].padEnd(parts[1].length + (4 - (parts[1].length % 4)) % 4, "=");
    const payload = JSON.parse(atob(b64)) as Record<string, unknown>;
    if (Array.isArray(payload.scopes)) {
      const tokenScopes = payload.scopes as string[];
      const required = ["styles:read", "styles:list", "styles:write", "tokens:read", "tokens:write"];
      const missing = required.filter(s => !tokenScopes.includes(s));
      if (missing.length > 0)
        return c.html(consentPageHtml(nonce, `Token is missing required scopes: ${missing.join(", ")}. Add them at account.mapbox.com/access-tokens.`));
    }
  } catch {
    return c.html(consentPageHtml(nonce, "Could not read username from token. Make sure it is a valid Mapbox token."));
  }

  const sessionCode = crypto.randomUUID();
  await c.env.SESSIONS.put(
    `code:${sessionCode}`,
    JSON.stringify({ mapboxToken: token, codeChallenge: code_challenge }),
    { expirationTtl: 300 },
  );
  await c.env.SESSIONS.delete(`nonce:${nonce}`);

  const redirectUrl = new URL(redirect_uri);
  redirectUrl.searchParams.set("code", sessionCode);
  if (originalState) redirectUrl.searchParams.set("state", originalState);
  return c.redirect(redirectUrl.toString());
});

// ── Token endpoint ──────────────────────────────────────────────────────────

app.post("/oauth/token", async (c) => {
  const body = await c.req.parseBody();
  const code = (body.code as string | undefined)?.trim();
  const codeVerifier = body.code_verifier as string | undefined;
  if (!code)
    return c.json({ error: "invalid_request", error_description: "missing code" }, 400);

  const raw = await c.env.SESSIONS.get(`code:${code}`);
  if (!raw || raw === "used")
    return c.json({ error: "invalid_grant", error_description: "invalid or expired code" }, 400);
  const { mapboxToken, codeChallenge } = JSON.parse(raw) as { mapboxToken: string; codeChallenge?: string };

  // PKCE validation (S256)
  if (codeChallenge) {
    if (!codeVerifier)
      return c.json({ error: "invalid_request", error_description: "code_verifier required" }, 400);
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier));
    const b64 = btoa(String.fromCharCode(...new Uint8Array(hash)))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    if (b64 !== codeChallenge)
      return c.json({ error: "invalid_grant", error_description: "code_verifier mismatch" }, 400);
  }

  // Sentinel prevents double-use (KV is not atomic)
  await c.env.SESSIONS.put(`code:${code}`, "used", { expirationTtl: 60 });
  const sessionId = crypto.randomUUID();
  await c.env.SESSIONS.put(`session:${sessionId}`, mapboxToken, { expirationTtl: 2592000 });

  return c.json({ access_token: sessionId, token_type: "bearer", expires_in: 2592000 });
});

// Legacy /token alias for older MCP clients
app.post("/token", (c) => c.redirect("/oauth/token", 307));

// ── MCP tool discovery ──────────────────────────────────────────────────────

const MCP_SERVER_INFO = { name: "map-design-mcp", version: "2.0.0" };

const MCP_TOOLS = [
      // ── Pattern library (no token required) ───────────────────────────
      {
        name: "get_dev_patterns",
          description:
            "Get Mapbox GL JS implementation patterns. " +
            "CALL ORDER: always call get_dev_patterns(pattern='scaffolding') FIRST on any new map — " +
            "it contains the mandatory token setup (list_tokens_tool → create_token_tool) and the " +
            "top-5 root causes of invisible maps. Only then call additional patterns as needed. " +
            "Covers: markers, popups, routing, search, interactions, clustering, animation, 3D, " +
            "data layers, React integration, expressions, and performance. " +
            "Returns copy-pasteable code verified against official Mapbox examples (v3.21.0).",
          inputSchema: {
            type: "object",
            properties: {
              pattern: {
                type: "string",
                enum: [
                  "scaffolding", "pins_and_markers", "popups",
                  "routing_and_directions", "search_and_geocoding",
                  "map_interaction", "layer_control", "clustering",
                  "animation", "threed", "data_layers",
                  "react_integration", "performance", "token_security", "expressions",
                ],
                description:
                  "Start with 'scaffolding' on every new app — it includes token setup and common failure modes. " +
                  "Then call the pattern that matches what you're building.",
              },
              context: {
                type: "string",
                description: "Optional use case, e.g. 'delivery driver app' or 'real estate listings'.",
              },
            },
            required: ["pattern"],
          },
      },
      // ── Native design tools (no token required) ────────────────────────
      {
        name: "get_design_guidance",
        description:
          "ALWAYS call this before making any map design decisions. Returns cartographic principles, " +
          "color hierarchy rules, segment-specific design patterns, and do/don't lists. " +
          "Use segment= for use-case rules (logistics_driver, real_estate, automotive…), " +
          "topic= for specific design questions (color, hierarchy, dark_mode…). " +
          "Call get_dev_patterns for code patterns, call this for design rationale.",
        inputSchema: {
          type: "object",
          properties: {
            segment: {
              type: "string",
              enum: SEGMENT_KEYS,
              description: "Use-case segment for segment-specific design rules",
            },
            topic: {
              type: "string",
              enum: TOPIC_KEYS,
              description: "Design topic for focused rules (color, typography, performance, etc.)",
            },
          },
        },
      },
      {
        name: "design_audit",
        description:
          "Audit a Mapbox style for cartographic violations. ALWAYS call after generating or modifying any style. " +
          "Checks: visual hierarchy (route must be above POI), WCAG contrast on text layers, brand color scatter " +
          "(brand color should appear on ≤2 layers), dark-theme road colors, GeoJSON performance (>500 features → tileset), " +
          "custom layer count (>15 → GPU pressure). Returns ranked violations (error/warn/info) with concrete fix suggestions and a 0–100 score.",
        inputSchema: {
          type: "object",
          properties: {
            style_json: { type: "object" },
            standard_config: { type: "object" },
            segment: { type: "string" },
            brand_color_hint: { type: "string" },
          },
        },
      },
      {
        name: "palette_suggest",
        description:
          "Generate a WCAG-compliant Mapbox color palette from a brand color. " +
          "Returns: palette (hex values), standard_config_patch (apply with setConfigProperty), wcag_report (contrast ratios), warnings. " +
          "COLOR RULES APPLIED: land lightness ≥90% (light) / ≤15% (dark); water saturation ≥70%; " +
          "brand color on route line and primary marker ONLY — never on basemap roads, land, or water. " +
          "After applying, call design_audit() to catch any remaining violations.",
        inputSchema: {
          type: "object",
          properties: {
            brand_color: { type: "string" },
            segment: { type: "string" },
            background: { type: "string", enum: ["light", "dark"] },
            n_accent_colors: { type: "number" },
          },
          required: ["brand_color", "segment", "background"],
        },
      },
      {
        name: "segment_preset",
        description:
          "Get a ready-to-apply Standard config preset for a specific use case. " +
          "Returns: config (apply directly with setConfigProperty), instructions[] (implementation steps), rationale (why these settings). " +
          "KEY DEFAULTS: automotive → slot:'top' route line + explicit night config required. " +
          "data_viz → monochrome base, all POI noise off, data must be the only thing that pops. " +
          "real_estate → faded base, POIs off, 3D off — listings must win visual hierarchy. " +
          "logistics_driver → buildings on for last-50-feet delivery cues. " +
          "After applying, call design_audit(segment=) to validate the result.",
        inputSchema: {
          type: "object",
          properties: {
            segment: { type: "string" },
            time_of_day: { type: "string" },
            brand_color: { type: "string" },
            mapbox_token: {
              type: "string",
              description: "pk.* token for generating a Static Images API preview_url. Call create_token_tool first.",
            },
          },
          required: ["segment"],
        },
      },
      {
        name: "wcag_validate",
        description: "Validate text/background color pairs in a Mapbox style against WCAG 2.1 AA.",
        inputSchema: {
          type: "object",
          properties: {
            style_json: { type: "object" },
            standard_config: { type: "object" },
            level: { type: "string", enum: ["AA", "AAA"] },
            only_failures: {
              type: "boolean",
              description: "Return only failing pairs (default true). Set false to include passing pairs.",
            },
          },
        },
      },
      // ── Mapbox MCP proxy ───────────────────────────────────────────────
      {
        name: "geocode",
        description:
          "Forward geocode an address or place name to coordinates, or reverse geocode coordinates to a place name.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Address, place name, or 'lng,lat' for reverse geocode" },
          },
          required: ["query"],
        },
      },
      {
        name: "directions",
        description: "Get turn-by-turn directions between two or more waypoints.",
        inputSchema: {
          type: "object",
          properties: {
            waypoints: {
              type: "array",
              items: { type: "string", description: "Address or 'lng,lat'" },
            },
            profile: { type: "string", enum: ["driving", "walking", "cycling"], default: "driving" },
          },
          required: ["waypoints"],
        },
      },
      {
        name: "isochrone",
        description: "Generate travel-time or distance contours (isochrones) around a location.",
        inputSchema: {
          type: "object",
          properties: {
            location: { type: "string", description: "Address or 'lng,lat'" },
            contours_minutes: { type: "array", items: { type: "number" } },
            profile: { type: "string", enum: ["driving", "walking", "cycling"], default: "driving" },
          },
          required: ["location", "contours_minutes"],
        },
      },
      {
        name: "matrix",
        description: "Compute a travel-time or distance matrix between origins and destinations.",
        inputSchema: {
          type: "object",
          properties: {
            origins: { type: "array", items: { type: "string" } },
            destinations: { type: "array", items: { type: "string" } },
            profile: { type: "string", enum: ["driving", "walking", "cycling"], default: "driving" },
          },
          required: ["origins", "destinations"],
        },
      },
      {
        name: "static_map",
        description: "Generate a static map image URL for a given location, style, and viewport.",
        inputSchema: {
          type: "object",
          properties: {
            center: { type: "array", items: { type: "number" }, description: "[lng, lat]" },
            zoom: { type: "number" },
            width: { type: "number" },
            height: { type: "number" },
            style: { type: "string" },
          },
          required: ["center", "zoom"],
        },
      },
      {
        name: "category_search",
        description: "Search for POIs or places by category near a location.",
        inputSchema: {
          type: "object",
          properties: {
            category: { type: "string" },
            proximity: { type: "string", description: "Address or 'lng,lat'" },
            limit: { type: "number" },
          },
          required: ["category"],
        },
      },
      // ── Mapbox Styles API (session auth required) ──────────────────────
      {
        name: "list_styles_tool",
        description: "List all Mapbox styles for the authenticated account.",
        inputSchema: {
          type: "object",
          properties: {
            limit: { type: "number", description: "Max styles to return (recommend 5–10)" },
            start: { type: "string", description: "Pagination start token from previous response" },
          },
        },
      },
      {
        name: "retrieve_style_tool",
        description: "Retrieve a specific Mapbox style by ID.",
        inputSchema: {
          type: "object",
          properties: { styleId: { type: "string", description: "Style ID" } },
          required: ["styleId"],
        },
      },
      {
        name: "create_style_tool",
        description: "Create a new Mapbox style. Provide a name and a complete Mapbox Style Specification object.",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", description: "Human-readable style name" },
            style: { type: "object", description: "Mapbox Style Spec object (version, sources, layers, …)" },
          },
          required: ["name", "style"],
        },
      },
      {
        name: "update_style_tool",
        description: "Update an existing Mapbox style. PATCH — only provided fields are changed.",
        inputSchema: {
          type: "object",
          properties: {
            styleId: { type: "string" },
            name: { type: "string", description: "New name (optional)" },
            style: { type: "object", description: "Partial or full style spec to merge in (optional)" },
          },
          required: ["styleId"],
        },
      },
      {
        name: "delete_style_tool",
        description: "Permanently delete a Mapbox style by ID.",
        inputSchema: {
          type: "object",
          properties: { styleId: { type: "string" } },
          required: ["styleId"],
        },
      },
      {
        name: "list_tokens_tool",
        description: "List existing Mapbox public access tokens for the authenticated account. Use this BEFORE create_token_tool to check if a suitable token already exists — avoids token proliferation.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "create_token_tool",
        description: "Create a new Mapbox public access token with specified scopes and optional URL/time restrictions.",
        inputSchema: {
          type: "object",
          properties: {
            note: { type: "string", description: "Description of the token" },
            scopes: {
              type: "array",
              items: { type: "string", enum: ["styles:tiles", "styles:read", "fonts:read", "datasets:read", "vision:read"] },
              description: "Token scopes",
            },
            allowedUrls: { type: "array", items: { type: "string" }, description: "URLs where token is valid (max 100)" },
            expires: { type: "string", description: "ISO 8601 expiry (max 1h in the future)" },
          },
          required: ["note", "scopes"],
        },
      },
      // ── DevKit MCP proxy ───────────────────────────────────────────────
      {
        name: "check_color_contrast",
        description: "Check WCAG contrast ratio between two colors and report AA/AAA pass/fail.",
        inputSchema: {
          type: "object",
          properties: {
            foreground: { type: "string" },
            background: { type: "string" },
          },
          required: ["foreground", "background"],
        },
      },
      {
        name: "validate_expression",
        description: "Validate a Mapbox GL filter or paint expression. Returns valid/invalid and error details.",
        inputSchema: {
          type: "object",
          properties: {
            expression: {},
          },
          required: ["expression"],
        },
      },
      {
        name: "preview_style",
        description: "Generate a preview image URL for a Mapbox style.",
        inputSchema: {
          type: "object",
          properties: {
            style: { type: "string", description: "Style URL (mapbox://styles/...)" },
          },
          required: ["style"],
        },
      },
      {
        name: "get_reference",
        description:
          "Look up Mapbox Style Spec documentation for a property, layer type, or expression operator.",
        inputSchema: {
          type: "object",
          properties: {
            topic: { type: "string" },
          },
          required: ["topic"],
        },
      },
];

// ── MCP Prompts ─────────────────────────────────────────────────────────────

const MCP_PROMPTS = [
  {
    name: "cartography_primer",
    description:
      "Core cartographic rules: figure-ground, visual hierarchy, zoom strategy, color theory, thematic map types. " +
      "Inject before any map design task to ground the AI in Mapbox cartography best practices.",
    arguments: [],
  },
  {
    name: "segment_guide",
    description:
      "Use-case-specific design rules for a named segment (logistics_driver, real_estate, automotive, etc.). " +
      "Inject when the map has a known use case.",
    arguments: [
      {
        name: "segment",
        description: `One of: ${SEGMENT_KEYS.join(", ")}`,
        required: true,
      },
    ],
  },
  {
    name: "topic_guide",
    description:
      "Focused rules for a specific design topic. " +
      "Inject for targeted guidance on color, hierarchy, typography, performance, dark_mode, data_viz, zoom_strategy, or standard_config.",
    arguments: [
      {
        name: "topic",
        description: `One of: ${TOPIC_KEYS.join(", ")}`,
        required: true,
      },
    ],
  },
];

const CARTOGRAPHY_PRIMER = `CARTOGRAPHY RULES — apply to every map style decision:

DECIDE WHAT KIND OF MAP FIRST:
  User needs to FIND a location / navigate     → Reference/navigation map
  User needs to UNDERSTAND a pattern in data   → Thematic map
  User needs to LOCATE branded points          → Business locator (brand markers foreground, basemap recedes)
  User needs to TELL a data story              → Journalistic/expressive map (flat over 3D)

THEMATIC MAP TYPES — pick the right one:
  Values per area, rate or ratio (%, index)    → CHOROPLETH — sequential or diverging ColorBrewer ramp
  Raw counts per area                          → NEVER choropleth — normalize to rate, or use proportional symbols
  Points < ~500, exact locations matter        → Proportional/categorical symbol
  Points > ~500, density pattern matters       → Heatmap
  Movement origin→destination                 → Flow map (≤20 flows draw all; >20 filter top N)

VISUAL HIERARCHY — layer order (top = most important):
  1. User content: routes, active selections
  2. POI symbols and labels
  3. Road labels, place names
  4. Major → minor roads
  5. Buildings, administrative boundaries
  6. Land use, water, terrain (background only)

FIGURE-GROUND — the most foundational principle:
  Map subject must visually SEPARATE from context.
  Desaturated, light land = background. Saturated, darker data = foreground.
  If custom data isn't popping: lighten/desaturate the basemap, not the data.
  On dark themes: data layers need MORE saturation.

COLOR:
  Land lightness ≥ 90% (light) / ≤ 15% (dark). Never match land to data.
  Water saturation ≥ 70% — water must read as water at a glance.
  Route/line: high chroma, ≥ 4.5:1 contrast on basemap (WCAG AA).
  Always check_color_contrast before applying any text color pair.

ZOOM STRATEGY:
  z0–4: capitals, ocean labels only
  z5–8: major cities, highways, large water
  z9–11: all highways, neighborhoods, parks
  z12–15: all streets, POIs (start at z12 not z14), buildings
  z16+: house numbers, parking, fine amenities
  Fade features over 1–2 zoom levels — never abrupt cutoffs:
    opacity: ['interpolate',['linear'],['zoom'], 11, 0, 12, 1]

STANDARD MODE (preferred):
  Use setConfigProperty("basemap", key, value) — never setStyle() for Standard.
  colorLand, colorWater, colorRoad, lightPreset, showPlaceLabels, show3dBuildings.
  For brand overlays: add GeoJSON custom layers on top, keep basemap neutral.`;

function buildPromptMessages(
  name: string,
  args: Record<string, string>
): Array<{ role: string; content: { type: string; text: string } }> {
  if (name === "cartography_primer") {
    return [{ role: "user", content: { type: "text", text: CARTOGRAPHY_PRIMER } }];
  }

  if (name === "segment_guide") {
    const segment = args.segment;
    const g = SEGMENT_GUIDANCE[segment];
    if (!g) throw new Error(`Unknown segment: "${segment}". Valid values: ${SEGMENT_KEYS.join(", ")}`);
    const lines = [
      `DESIGN GUIDE — ${segment.toUpperCase().replace(/_/g, " ")}`,
      "",
      "PRINCIPLES:",
      ...g.principles.map((p) => `  • ${p}`),
      "",
      "DO:",
      ...g.do_list.map((d) => `  ✓ ${d}`),
      "",
      "DON'T:",
      ...g.dont_list.map((d) => `  ✗ ${d}`),
      "",
      "CONFIG HINTS:",
      ...Object.entries(g.config_hints).map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`),
    ];
    return [{ role: "user", content: { type: "text", text: lines.join("\n") } }];
  }

  if (name === "topic_guide") {
    const topic = args.topic;
    const g = TOPIC_GUIDANCE[topic];
    if (!g) throw new Error(`Unknown topic: "${topic}". Valid values: ${TOPIC_KEYS.join(", ")}`);
    const lines = [
      `DESIGN GUIDE — ${topic.toUpperCase().replace(/_/g, " ")}`,
      "",
      "PRINCIPLES:",
      ...g.principles.map((p) => `  • ${p}`),
      "",
      "DO:",
      ...g.do_list.map((d) => `  ✓ ${d}`),
      "",
      "DON'T:",
      ...g.dont_list.map((d) => `  ✗ ${d}`),
      "",
      "CONFIG HINTS:",
      ...Object.entries(g.config_hints).map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`),
    ];
    return [{ role: "user", content: { type: "text", text: lines.join("\n") } }];
  }

  throw new Error(`Unknown prompt: "${name}". Available: ${MCP_PROMPTS.map((p) => p.name).join(", ")}`);
}

app.get("/mcp", (c) =>
  c.json({
    ...MCP_SERVER_INFO,
    description: "Map Studio MCP gateway — cartographic design tools, Mapbox geocoding/routing/isochrone, and style DevKit",
    tools: MCP_TOOLS,
  })
);

// ── Tool execution core ───────────────────────────────────────────────────────

async function executeTool(
  toolName: string,
  input: Record<string, unknown>,
  mapboxToken: string | null,
): Promise<unknown> {
  // ── No-auth tools ────────────────────────────────────────────────────────
  switch (toolName) {
    case "get_dev_patterns": {
      const { pattern, context } = input as { pattern: string; context?: string };
      const content = DEV_PATTERNS[pattern];
      if (!content) throw new Error(`Unknown pattern: ${pattern}. Available: ${Object.keys(DEV_PATTERNS).join(", ")}`);
      let segmentNote = "";
      if (context) {
        const ctx = context.toLowerCase();
        for (const [keywords, note] of SEGMENT_NOTES) {
          if (keywords.some((k) => ctx.includes(k))) { segmentNote = "\n" + note; break; }
        }
      }
      return { pattern, content: content.trim() + segmentNote, examples_reference: EXAMPLE_URLS[pattern] ?? [], related_patterns: RELATED_PATTERNS[pattern] ?? [] };
    }
    case "get_design_guidance":
      return handleGetDesignGuidance(input as { segment?: string; topic?: string });
    case "design_audit":
      return handleDesignAudit(input as Parameters<typeof handleDesignAudit>[0]);
    case "palette_suggest":
      return handlePaletteSuggest(input as unknown as Parameters<typeof handlePaletteSuggest>[0]);
    case "segment_preset":
      return handleSegmentPreset(input as unknown as Parameters<typeof handleSegmentPreset>[0]);
    case "wcag_validate":
      return handleWcagValidate(input as Parameters<typeof handleWcagValidate>[0]);
  }

  // ── Auth-required tools ───────────────────────────────────────────────────
  if (!mapboxToken) throw new Error("Authentication required. Connect the MCP server to authorise.");

  // Mapbox Styles / Tokens API — called directly, no proxy
  switch (toolName) {
    case "list_styles_tool": {
      const u = encodeURIComponent(getUserNameFromToken(mapboxToken));
      const qs = new URLSearchParams({ access_token: mapboxToken });
      if (input.limit) qs.set("limit", String(input.limit));
      if (input.start) qs.set("start", String(input.start));
      const res = await fetch(`https://api.mapbox.com/styles/v1/${u}?${qs}`);
      if (!res.ok) throw new Error(`Mapbox Styles API error ${res.status}: ${await res.text().catch(() => res.statusText)}`);
      return res.json();
    }
    case "retrieve_style_tool": {
      const { styleId } = input as { styleId: string };
      const u = encodeURIComponent(getUserNameFromToken(mapboxToken));
      const res = await fetch(`https://api.mapbox.com/styles/v1/${u}/${encodeURIComponent(styleId)}?access_token=${mapboxToken}`);
      if (!res.ok) throw new Error(`Mapbox Styles API error ${res.status}: ${await res.text().catch(() => res.statusText)}`);
      return res.json();
    }
    case "create_style_tool": {
      const { name, style } = input as { name: string; style: object };
      const u = encodeURIComponent(getUserNameFromToken(mapboxToken));
      const res = await fetch(`https://api.mapbox.com/styles/v1/${u}?access_token=${mapboxToken}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...style, name }),
      });
      if (!res.ok) throw new Error(`Mapbox Styles API error ${res.status}: ${await res.text().catch(() => res.statusText)}`);
      return res.json();
    }
    case "update_style_tool": {
      const { styleId, name, style } = input as { styleId: string; name?: string; style?: object };
      const u = encodeURIComponent(getUserNameFromToken(mapboxToken));
      const payload: Record<string, unknown> = {};
      if (name) payload.name = name;
      if (style) Object.assign(payload, style);
      const res = await fetch(`https://api.mapbox.com/styles/v1/${u}/${encodeURIComponent(styleId)}?access_token=${mapboxToken}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`Mapbox Styles API error ${res.status}: ${await res.text().catch(() => res.statusText)}`);
      return res.json();
    }
    case "delete_style_tool": {
      const { styleId } = input as { styleId: string };
      const u = encodeURIComponent(getUserNameFromToken(mapboxToken));
      const res = await fetch(`https://api.mapbox.com/styles/v1/${u}/${encodeURIComponent(styleId)}?access_token=${mapboxToken}`, { method: "DELETE" });
      return res.status === 204 ? { deleted: true } : res.json();
    }
    case "list_tokens_tool": {
      if (mapboxToken.startsWith("pk.")) {
        return { error: "A secret token (sk.*) with tokens:read scope is required to list tokens. Public tokens (pk.*) cannot access the Tokens API. Create a secret token at account.mapbox.com and reconnect the MCP server with it." };
      }
      const u = encodeURIComponent(getUserNameFromToken(mapboxToken));
      const qs = new URLSearchParams({ access_token: mapboxToken });
      const res = await fetch(`https://api.mapbox.com/tokens/v2/${u}?${qs}`);
      if (!res.ok) throw new Error(`Mapbox Tokens API error ${res.status}: ${await res.text().catch(() => res.statusText)}`);
      return res.json();
    }
    case "create_token_tool": {
      if (mapboxToken.startsWith("pk.")) {
        return { error: "A secret token (sk.*) with tokens:write scope is required to create tokens. Public tokens (pk.*) cannot access the Tokens API. Create a secret token at account.mapbox.com and reconnect the MCP server with it." };
      }
      const { note, scopes, allowedUrls, expires } = input as { note: string; scopes: string[]; allowedUrls?: string[]; expires?: string };
      const u = encodeURIComponent(getUserNameFromToken(mapboxToken));
      const payload: Record<string, unknown> = { note, scopes };
      if (allowedUrls) payload.allowedUrls = allowedUrls;
      if (expires) payload.expires = expires;
      const res = await fetch(`https://api.mapbox.com/tokens/v2/${u}?access_token=${mapboxToken}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`Mapbox Tokens API error ${res.status}: ${await res.text().catch(() => res.statusText)}`);
      return res.json();
    }
    case "directions": {
      const { waypoints, profile = "driving" } = input as { waypoints: string[]; profile?: string };
      const coords: string[] = [];
      for (const wp of waypoints) {
        if (/^-?\d+\.?\d*,-?\d+\.?\d*$/.test(wp.trim())) {
          coords.push(wp.trim());
        } else {
          const geoRes = await fetch(
            `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(wp)}.json?access_token=${mapboxToken}&limit=1`
          );
          if (!geoRes.ok) throw new Error(`Geocoding error ${geoRes.status} for waypoint "${wp}"`);
          const geoJson = await geoRes.json() as { features?: Array<{ center: [number, number] }> };
          const feature = geoJson.features?.[0];
          if (!feature) throw new Error(`Could not geocode waypoint: "${wp}"`);
          coords.push(`${feature.center[0]},${feature.center[1]}`);
        }
      }
      const res = await fetch(
        `https://api.mapbox.com/directions/v5/mapbox/${profile}/${coords.join(";")}?access_token=${mapboxToken}&geometries=geojson&steps=true&overview=full`
      );
      if (!res.ok) throw new Error(`Mapbox Directions API error ${res.status}: ${await res.text().catch(() => res.statusText)}`);
      return res.json();
    }
  }

  // Mapbox MCP / DevKit MCP proxy
  if (MAPBOX_MCP_TOOLS.has(toolName) || DEVKIT_MCP_TOOLS.has(toolName)) {
    const upstream = MAPBOX_MCP_TOOLS.has(toolName) ? MAPBOX_MCP_URL : DEVKIT_MCP_URL;
    return proxyMcp(upstream, toolName, input, mapboxToken);
  }

  throw new Error(`Unknown tool: ${toolName}`);
}

// ── MCP tool execution ──────────────────────────────────────────────────────

app.post("/mcp", async (c) => {
  const body = await c.req.json<Record<string, unknown>>();
  const base = `https://${c.req.header("host")}`;
  const mapboxToken = await getMapboxToken(c.req.header("Authorization"), c.env);

  // ── Standard MCP JSON-RPC protocol ────────────────────────────────────────
  if (body.jsonrpc === "2.0") {
    const { id, method, params } = body as { id: unknown; method: string; params?: Record<string, unknown> };

    if (method === "initialize") {
      return c.json({
        jsonrpc: "2.0", id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {}, prompts: { listChanged: false } },
          serverInfo: { name: "map-design-mcp", version: "2.0.0" },
        },
      });
    }

    if (method === "notifications/initialized") {
      return c.json({ jsonrpc: "2.0", id, result: {} });
    }

    if (method === "tools/list") {
      return c.json({ jsonrpc: "2.0", id, result: { tools: MCP_TOOLS } });
    }

    if (method === "tools/call") {
      const toolName = (params?.name ?? "") as string;
      const input = (params?.arguments ?? {}) as Record<string, unknown>;
      try {
        const result = await executeTool(toolName, input, mapboxToken);
        const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
        return c.json({
          jsonrpc: "2.0", id,
          result: { content: [{ type: "text", text }] },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Signal re-auth if the error is an auth failure
        if (msg.includes("Authentication required")) {
          return c.json(
            { jsonrpc: "2.0", id, error: { code: -32001, message: msg } },
            401,
            { "WWW-Authenticate": `Bearer realm="${base}", resource_metadata="${base}/.well-known/oauth-protected-resource"` },
          );
        }
        return c.json({ jsonrpc: "2.0", id, error: { code: -32000, message: msg } });
      }
    }

    if (method === "prompts/list") {
      return c.json({ jsonrpc: "2.0", id, result: { prompts: MCP_PROMPTS } });
    }

    if (method === "prompts/get") {
      const name = (params?.name ?? "") as string;
      const args = (params?.arguments ?? {}) as Record<string, string>;
      try {
        const messages = buildPromptMessages(name, args);
        return c.json({ jsonrpc: "2.0", id, result: { messages } });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return c.json({ jsonrpc: "2.0", id, error: { code: -32602, message: msg } });
      }
    }

    return c.json({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
  }

  // ── Legacy custom format (Map Studio backend) ─────────────────────────────
  const { tool, input = {} } = body as { tool: string; input?: Record<string, unknown> };
  try {
    return c.json(await executeTool(tool, input, mapboxToken));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: msg }, 400);
  }
});

export default app;
