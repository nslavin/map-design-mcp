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

import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import {
  handleDesignAudit,
  handleGetDesignGuidance,
  handlePaletteSuggest,
  handleSegmentPreset,
  PRESETS,
  SEGMENT_PREVIEW_CENTERS,
} from "./tools";
import { SEGMENT_GUIDANCE, SEGMENT_KEYS, TOPIC_GUIDANCE, TOPIC_KEYS } from "./design-guidance";
import { DEV_PATTERNS, EXAMPLE_URLS, RELATED_PATTERNS, SEGMENT_NOTES } from "./dev-patterns";
import { validateExpression, getReference } from "./expression-validator";
import { screenshotMap, STYLE_RE } from "./gl-map-renderer";
import { type ClientMode, modeBriefText } from "./mode-brief";
import { project, projectCoords, type Viewport } from "./projection";

// ── Mode classification ──────────────────────────────────────────────────────
//
// This MCP serves two Figma products with different needs:
//   • Figma Make  — interactive prototyping; full tool set.
//   • Figma Design — static design only; hide tools that produce interactive
//                    Mapbox GL JS code or drive a live interactive map.
//
// Integration:
//   • Canonical: append  ?mode=design  to the MCP URL for Figma Design.
//   • Alternative: send  X-Client-Mode: design  header (browser-safe — CORS
//     allowHeaders includes it; use the query param in MCP config UIs that
//     don't expose custom headers).
// Figma Make uses /mcp  (default — fully backward-compatible).

/** Tools that only make sense in Figma Make (interactive prototyping).
 *  Hidden from tools/list in Figma Design (static-only) mode. */
export const INTERACTIVE_ONLY_TOOLS = new Set([
  "get_dev_patterns",    // GL JS scaffolding / code patterns — requires a browser map
  "directions",          // runtime routing for live interactive maps
  "isochrone",           // travel-time contours — live map feature
  "matrix",              // travel-time matrix   — live map feature
  "category_search",     // live POI search for interactive layers
  "validate_expression", // GL JS filter/paint expression dev helper
  "get_reference",       // GL Style Spec dev docs
]);

/** Tools that only make sense in Figma Design (static + projection).
 *  Hidden from tools/list in Figma Make mode (which builds live GL JS maps). */
export const DESIGN_ONLY_TOOLS = new Set([
  "static_overlay",      // static image + geo→pixel projection for Figma editable overlays
]);

type McpTool = { name: string; description: string; inputSchema: unknown };

/** Return the tool list for the given mode. */
export function toolsForMode(mode: ClientMode, tools: McpTool[]): McpTool[] {
  if (mode === "make") return tools.filter((t) => !DESIGN_ONLY_TOOLS.has(t.name));
  return tools.filter((t) => !INTERACTIVE_ONLY_TOOLS.has(t.name));
}

/** Read the client mode from:
 *  1. ?mode=design|make  query param
 *  2. X-Client-Mode: design|make  header
 *  3. Default "make"  (backward-compatible — existing clients keep full capability)
 */
function getRequestMode(c: Context<{ Bindings: Env }>): ClientMode {
  const q = c.req.query("mode");
  if (q === "design" || q === "make") return q;
  const h = c.req.header("X-Client-Mode");
  if (h === "design" || h === "make") return h;
  return "make";
}

// ── Token encryption helpers (AES-GCM via WebCrypto) ─────────────────────────
//
// Secret Mapbox tokens (sk.*) are encrypted at rest in KV using AES-256-GCM.
// The encryption key is derived from the ENCRYPTION_KEY Worker secret (hex string).
// If ENCRYPTION_KEY is not set, tokens are stored plaintext with a console warning.
// Stored format (base64): <12-byte IV><ciphertext>

type EnvWithKey = Env & { ENCRYPTION_KEY?: string };

async function deriveKey(hexSecret: string): Promise<CryptoKey> {
  const keyBytes = new Uint8Array(hexSecret.match(/.{2}/g)!.map((h) => parseInt(h, 16)));
  return crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function encryptToken(token: string, env: EnvWithKey): Promise<string> {
  const secret = (env as unknown as Record<string, string>).ENCRYPTION_KEY;
  if (!secret) return token; // fallback: plaintext (warn at startup ideally)
  const key = await deriveKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(token),
  );
  const combined = new Uint8Array(12 + encrypted.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(encrypted), 12);
  // Mark encrypted values with prefix "enc:" so we can detect plaintext fallbacks
  return "enc:" + btoa(String.fromCharCode(...combined));
}

async function decryptToken(stored: string, env: EnvWithKey): Promise<string> {
  if (!stored.startsWith("enc:")) return stored; // plaintext fallback
  const secret = (env as unknown as Record<string, string>).ENCRYPTION_KEY;
  if (!secret) return stored.slice(4); // no key — return raw (shouldn't happen)
  const key = await deriveKey(secret);
  const combined = new Uint8Array(
    atob(stored.slice(4)).split("").map((c) => c.charCodeAt(0)),
  );
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  return new TextDecoder().decode(plain);
}

// ── Auth helpers ─────────────────────────────────────────────────────────────

/**
 * Allowlist for OAuth redirect_uri values.
 *
 * Rules (in order):
 *  1. https:// — secure transport to any host; safe against network sniffing.
 *  2. http://localhost or http://127.0.0.1 — CLI tools (e.g. Claude Code) open a
 *     local loopback server to receive the code; the port is dynamic so we allow
 *     any port but restrict to loopback hostnames only.
 *  3. claude:// and vscode:// — registered app-scheme deep links for desktop MCP clients.
 *
 * Plain http:// to any non-loopback host is blocked to prevent an attacker from
 * registering an arbitrary redirect target to intercept the authorization code
 * (and thereby steal the user's sk.* Mapbox secret token).
 */
function isAllowedRedirectUri(uri: string): boolean {
  try {
    const u = new URL(uri);
    if (u.protocol === "https:") return true;
    if (u.protocol === "claude:" || u.protocol === "vscode:") return true;
    if (u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1")) return true;
    return false;
  } catch {
    return false;
  }
}

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
  if (!bearer || bearer === "public") {
    return null; // MAPBOX_TOKEN env fallback removed — always use KV sessions
  }
  const stored = await env.SESSIONS.get(`session:${bearer}`);
  if (!stored) return null;
  return decryptToken(stored, env as EnvWithKey);
}

async function getPublicToken(authHeader: string | undefined, env: Env): Promise<string | null> {
  const bearer = authHeader?.replace(/^Bearer\s+/i, "").trim();
  if (!bearer || bearer === "public") return null;
  return env.SESSIONS.get(`session:${bearer}:pk`);
}

/** Resolve an address string or "lng,lat" coordinate string to [lng, lat].
 *  Coordinates pass through; addresses are geocoded via Mapbox Geocoding API. */
async function geocodeOne(query: string, token: string): Promise<[number, number]> {
  if (/^-?\d+\.?\d*,-?\d+\.?\d*$/.test(query.trim())) {
    const [lng, lat] = query.trim().split(",").map(Number);
    return [lng, lat];
  }
  const res = await fetch(
    `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(query)}.json?access_token=${token}&limit=1`
  );
  if (!res.ok) throw new Error(`Geocoding error ${res.status} for "${query}"`);
  const json = await res.json() as { features?: Array<{ center: [number, number] }> };
  const feature = json.features?.[0];
  if (!feature) throw new Error(`Could not geocode: "${query}"`);
  return feature.center;
}

// Shared constants used by both the internal helpers and executeTool validation.
const ALLOWED_PROFILES = new Set(["driving", "driving-traffic", "walking", "cycling"]);

// ── Reusable Mapbox REST fetch helpers ────────────────────────────────────────

async function fetchDirectionsGeometry(
  waypoints: string[],
  profile: string,
  token: string,
): Promise<{ coordinates: [number, number][]; distance: number; duration: number }> {
  if (!ALLOWED_PROFILES.has(profile)) profile = "driving"; // clamp to safe default for internal helper
  const coords = await Promise.all(waypoints.map((wp) => geocodeOne(wp, token)));
  const coordStr = coords.map(([lng, lat]) => `${lng},${lat}`).join(";");
  const res = await fetch(
    `https://api.mapbox.com/directions/v5/mapbox/${profile}/${coordStr}?access_token=${token}&geometries=geojson&steps=false&overview=full`,
  );
  if (!res.ok) throw new Error(`Mapbox Directions API error ${res.status}: ${await res.text().catch(() => res.statusText)}`);
  const json = await res.json() as { routes?: Array<{ geometry: { coordinates: [number, number][] }; distance: number; duration: number }> };
  const route = json.routes?.[0];
  if (!route) throw new Error("Directions API returned no routes");
  return { coordinates: route.geometry.coordinates, distance: route.distance, duration: route.duration };
}

interface IsochroneFeature {
  contour_minutes: number;
  /** Outer ring + holes (each an array of [lng,lat] pairs). */
  rings: [number, number][][];
}

async function fetchIsochronePolygons(
  location: string,
  contours_minutes: number[],
  profile: string,
  token: string,
): Promise<IsochroneFeature[]> {
  if (!ALLOWED_PROFILES.has(profile)) profile = "driving"; // clamp to safe default for internal helper
  const [lng, lat] = await geocodeOne(location, token);
  const params = new URLSearchParams({
    access_token: token,
    contours_minutes: contours_minutes.join(","),
    polygons: "true",
  });
  const res = await fetch(
    `https://api.mapbox.com/isochrone/v1/mapbox/${profile}/${lng},${lat}?${params}`,
  );
  if (!res.ok) throw new Error(`Mapbox Isochrone API error ${res.status}: ${await res.text().catch(() => res.statusText)}`);
  const json = await res.json() as {
    features?: Array<{
      properties: { contour: number };
      geometry: { type: string; coordinates: [number, number][][] | [number, number][][][] };
    }>;
  };
  return (json.features ?? []).map((f) => {
    const contour = f.properties.contour;
    // Polygon → one ring array; MultiPolygon → flatten to ring arrays
    const coords = f.geometry.coordinates;
    const rings: [number, number][][] =
      f.geometry.type === "MultiPolygon"
        ? (coords as [number, number][][][]).flat()
        : (coords as [number, number][][]);
    return { contour_minutes: contour, rings };
  });
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
  .optional{font-size:10px;font-weight:400;color:#555;margin-left:6px;text-transform:none;letter-spacing:0}
  input{width:100%;background:#111;border:1px solid #333;border-radius:6px;padding:10px 12px;color:#e8e8e8;font-size:14px;font-family:monospace;outline:none;margin-bottom:16px}
  input:focus{border-color:#4d9fff}
  .scopes{background:#111;border:1px solid #2a2a2a;border-radius:6px;padding:10px 12px;font-size:12px;color:#888;font-family:monospace;margin:12px 0 20px;line-height:1.8}
  .divider{border:none;border-top:1px solid #2a2a2a;margin:20px 0}
  .hint{font-size:12px;color:#555;margin:-12px 0 16px;line-height:1.5}
  button{width:100%;background:#4d9fff;color:#fff;border:none;border-radius:6px;padding:11px;font-size:14px;font-weight:600;cursor:pointer;margin-top:4px}
  button:hover{background:#3d8fee}
  .error{background:#2a1010;border:1px solid #5a2020;border-radius:6px;padding:10px 12px;font-size:13px;color:#ff7070;margin-bottom:16px}
</style>
</head>
<body>
<div class="card">
  <h1>Connect Map Design MCP</h1>
  <p class="sub">Authorise with your Mapbox tokens to enable all map design tools.<br>
  <a href="https://account.mapbox.com/access-tokens" target="_blank" rel="noopener">Manage tokens →</a></p>
  ${error ? `<div class="error">${error}</div>` : ""}
  <form method="POST" action="/authorize/submit?nonce=${nonce}">
    <label>Secret key <code style="font-size:11px;color:#4d9fff">sk.*</code> — required</label>
    <div class="scopes">styles:read &nbsp; styles:list &nbsp; styles:write<br>styles:delete &nbsp; tokens:read &nbsp; tokens:write</div>
    <input id="token" name="token" type="password" placeholder="sk.eyJ1…" autocomplete="off" required>

    <hr class="divider">

    <label>Public key <code style="font-size:11px;color:#3fb950">pk.*</code><span class="optional">optional — for static map images</span></label>
    <p class="hint">Required for <strong>static_map</strong>. Any public token works — use a scopes-restricted one for safety.</p>
    <input id="pk_token" name="pk_token" type="password" placeholder="pk.eyJ1… (optional)" autocomplete="off">

    <button type="submit">Authorise</button>
  </form>
</div>
</body>
</html>`;
}

// ── App ─────────────────────────────────────────────────────────────────────

type Env = { SESSIONS: KVNamespace; MAPBOX_TOKEN?: string; BROWSER: Fetcher };

// ── Rate limiting helpers ─────────────────────────────────────────────────────

const RATE_LIMIT_TOOL_CALLS = 120;   // max tool calls per session per minute
const RATE_LIMIT_TOKEN_REQS = 10;    // max /oauth/token attempts per IP per minute

/**
 * Fixed-window KV counter. Returns true if the request is within limits.
 * Increments the counter atomically-ish (KV is eventually consistent; this is
 * a best-effort throttle, not a hard guarantee).
 */
async function checkRateLimit(
  kv: KVNamespace,
  key: string,
  maxPerWindow: number,
  windowSeconds = 60,
): Promise<boolean> {
  const raw = await kv.get(`rl:${key}`);
  const count = raw ? parseInt(raw, 10) : 0;
  if (count >= maxPerWindow) return false;
  // Best-effort increment — fire-and-forget so it doesn't add latency
  void kv.put(`rl:${key}`, String(count + 1), { expirationTtl: windowSeconds });
  return true;
}

const app = new Hono<{ Bindings: Env }>();
app.use("/*", cors({
  origin: "*",
  allowHeaders: ["Authorization", "Content-Type", "X-Client-Mode"],
}));

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
  if (!isAllowedRedirectUri(redirect_uri))
    return c.json({
      error: "invalid_request",
      error_description:
        "redirect_uri is not allowed. Accepted: https://<any-host>, " +
        "http://localhost:<port>/..., http://127.0.0.1:<port>/..., claude://<path>, vscode://<path>.",
    }, 400);
  // PKCE (S256) is mandatory — it is the only code-binding mechanism for this public client.
  if (!code_challenge)
    return c.json({ error: "invalid_request", error_description: "code_challenge (S256) is required" }, 400);
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
  const pkToken = (body.pk_token as string | undefined)?.trim() ?? "";

  const pending = await c.env.SESSIONS.get(`nonce:${nonce}`);
  if (!pending) return c.text("Session expired. Please go back and try again.", 400);
  const { redirect_uri, state: originalState, code_challenge } = JSON.parse(pending) as {
    redirect_uri: string; state?: string; code_challenge?: string;
  };

  // Basic JWT format check
  if (token.split(".").length !== 3)
    return c.html(consentPageHtml(nonce, "Invalid secret token format — Mapbox tokens have three dot-separated parts."));

  // sk.* required for the main token field
  if (token.startsWith("pk."))
    return c.html(consentPageHtml(nonce, "The first field requires a secret token (sk.*). Paste your public token (pk.*) in the second field below."));

  // Validate sk.* decodes a username and has required scopes
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
        return c.html(consentPageHtml(nonce, `Secret token is missing required scopes: ${missing.join(", ")}. Add them at account.mapbox.com/access-tokens.`));
    }
  } catch {
    return c.html(consentPageHtml(nonce, "Could not read username from secret token. Make sure it is a valid Mapbox sk.* token."));
  }

  // Validate pk.* if provided
  if (pkToken) {
    if (pkToken.split(".").length !== 3)
      return c.html(consentPageHtml(nonce, "Invalid public token format. Leave the field empty if you don't have one."));
    if (!pkToken.startsWith("pk."))
      return c.html(consentPageHtml(nonce, "The second field must be a public token (pk.*), not a secret token."));
  }

  const sessionCode = crypto.randomUUID();
  await c.env.SESSIONS.put(
    `code:${sessionCode}`,
    JSON.stringify({ mapboxToken: token, pkToken: pkToken || null, codeChallenge: code_challenge, redirectUri: redirect_uri }),
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
  // Rate-limit by IP to slow brute-force code guessing
  const ip = c.req.header("CF-Connecting-IP") ?? c.req.header("X-Forwarded-For") ?? "unknown";
  if (!(await checkRateLimit(c.env.SESSIONS, `token:${ip}`, RATE_LIMIT_TOKEN_REQS))) {
    return c.json({ error: "too_many_requests", error_description: "Too many token requests — wait 60 seconds" }, 429);
  }

  const body = await c.req.parseBody();
  const code = (body.code as string | undefined)?.trim();
  const codeVerifier = body.code_verifier as string | undefined;
  if (!code)
    return c.json({ error: "invalid_request", error_description: "missing code" }, 400);

  const raw = await c.env.SESSIONS.get(`code:${code}`);
  if (!raw || raw === "used")
    return c.json({ error: "invalid_grant", error_description: "invalid or expired code" }, 400);

  // Mark the code as used immediately to narrow the double-use race window.
  // KV is eventually consistent and the read-write is non-atomic, so this does
  // not eliminate the race entirely, but it makes concurrent redemption far less likely.
  await c.env.SESSIONS.put(`code:${code}`, "used", { expirationTtl: 60 });

  const { mapboxToken, pkToken, codeChallenge, redirectUri } = JSON.parse(raw) as {
    mapboxToken: string; pkToken?: string | null; codeChallenge: string; redirectUri?: string;
  };

  // PKCE validation (S256) — mandatory; /authorize always issues a challenge.
  if (!codeVerifier)
    return c.json({ error: "invalid_request", error_description: "code_verifier required" }, 400);
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier));
  const b64 = btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  if (b64 !== codeChallenge)
    return c.json({ error: "invalid_grant", error_description: "code_verifier mismatch" }, 400);

  // redirect_uri binding — the client must echo the same URI used at /authorize (T4-16).
  const incomingRedirectUri = (body.redirect_uri as string | undefined)?.trim();
  if (redirectUri && incomingRedirectUri && incomingRedirectUri !== redirectUri)
    return c.json({ error: "invalid_grant", error_description: "redirect_uri mismatch" }, 400);
  const sessionId = crypto.randomUUID();
  await c.env.SESSIONS.put(`session:${sessionId}`, await encryptToken(mapboxToken, c.env as EnvWithKey), { expirationTtl: 2592000 });
  if (pkToken) {
    await c.env.SESSIONS.put(`session:${sessionId}:pk`, pkToken, { expirationTtl: 2592000 });
  }

  return c.json({ access_token: sessionId, token_type: "bearer", expires_in: 2592000 });
});

// Legacy /token alias for older MCP clients
app.post("/token", (c) => c.redirect("/oauth/token", 307));

// ── Session revoke (sign-out) ───────────────────────────────────────────────
// POST /session/revoke with the current Bearer token to delete the session from KV.
// This is the only way to revoke access without waiting for the 30-day TTL to expire.
app.post("/session/revoke", async (c) => {
  const authHeader = c.req.header("Authorization");
  const bearer = authHeader?.replace(/^Bearer\s+/i, "").trim();
  if (!bearer || bearer === "public")
    return c.json({ error: "invalid_request", error_description: "No active session to revoke" }, 400);
  await Promise.all([
    c.env.SESSIONS.delete(`session:${bearer}`),
    c.env.SESSIONS.delete(`session:${bearer}:pk`),
  ]);
  return c.json({ revoked: true });
});

// ── Hosted image serving ────────────────────────────────────────────────────
// WebGL-rendered map images are stored in KV under an `img:` prefix with a 1-hour TTL.
// The agent curls this URL, saves to /tmp/, and uploads to Figma via upload_assets.
// Accepting both `/img/<uuid>` and `/img/<uuid>.png` so consumers that sniff by extension
// get the right codec. The KV key never includes the extension.

app.get("/img/:key", async (c) => {
  const raw = c.req.param("key");
  const id = raw.replace(/\.(png|jpe?g)$/i, "");
  try {
    const { value, metadata } = await c.env.SESSIONS.getWithMetadata<{ mimeType: string }>(
      `img:${id}`,
      { type: "arrayBuffer" },
    );
    if (!value) return c.json({ error: "not_found", error_description: "Image not found or expired" }, 404);
    const mimeType = metadata?.mimeType ?? "image/png";
    return c.body(value as ArrayBuffer, 200, {
      "Content-Type": mimeType,
      "Cache-Control": "public, max-age=3600",
      "Access-Control-Allow-Origin": "*",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: "server_error", error_description: msg }, 500);
  }
});

// ── MCP tool discovery ──────────────────────────────────────────────────────

const MCP_SERVER_INFO = { name: "map-design-mcp", version: "2.1.0" };

const MCP_TOOLS = [
      // ── Pattern library (no token required) ───────────────────────────
      {
        name: "get_dev_patterns",
          description:
            "⚠️ Figma Make (interactive prototyping) only. " +
            "For static Figma Design work do NOT implement an interactive map — " +
            "use static_map / segment_preset for images and get_design_guidance for UI recommendations. " +
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
        description: "⚠️ Figma Make only. Get turn-by-turn directions between two or more waypoints for a live interactive map.",
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
        description: "⚠️ Figma Make only. Generate travel-time or distance contours (isochrones) around a location — for live interactive maps.",
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
        description: "⚠️ Figma Make only. Compute a travel-time or distance matrix between origins and destinations — for live interactive maps.",
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
        description:
          "Render and return a map as an image. Returns a fetchable PNG URL in a text block. " +
          "To place in Figma: curl the URL to get bytes, upload via upload_assets, then set as image fill. " +
          "Available in both Figma Design (static deliverable) and Figma Make (quick preview during iteration). " +
          "Default renderer is 'webgl' (Mapbox GL JS in headless Chrome) using mapbox/standard — supports 3D buildings, " +
          "lightPreset, landmark icons, pitch/bearing, and all Standard config (~5-10s). " +
          "Use renderer='static' ONLY for speed-critical cases or when the user explicitly requests a Classic style — " +
          "'static' uses the Mapbox Static Images API (fast ~500ms) but is Classic styles only (streets-v12, dark-v11, etc.). " +
          "Use segment= to auto-apply cartographic presets and default camera position. " +
          "To place pins, routes, or isochrones at real geographic coordinates on top of the image in Figma Design, use static_overlay instead.",
        inputSchema: {
          type: "object",
          properties: {
            center: { type: "array", items: { type: "number" }, description: "[lng, lat] — optional if segment= is provided" },
            zoom: { type: "number", description: "Zoom level — optional if segment= is provided" },
            bearing: { type: "number", description: "Camera rotation in degrees 0–360 (default 0 = north-up)" },
            pitch: { type: "number", description: "Camera tilt in degrees 0–60 (default 0 = top-down; 45–60 = dramatic 3D perspective)" },
            retina: { type: "boolean", description: "Return @2x high-DPI image (default true)" },
            style: { type: "string", description: "Mapbox style to render. Defaults to 'mapbox/standard'. WebGL styles (support 3D + Standard config): 'mapbox/standard' — 3D buildings & landmarks, dynamic lighting (lightPreset day/dusk/dawn/night), themes, full Standard config (default, recommended); 'mapbox/standard-satellite' — satellite imagery base + 3D + place/road labels. Classic styles (fast Static Images API, 2D only): 'mapbox/streets-v12' — detailed street map, full labels/POIs; 'mapbox/light-v11' — minimal light/neutral backdrop, ideal for data overlays & choropleths; 'mapbox/dark-v11' — minimal dark backdrop for data viz & dark-mode UIs; 'mapbox/outdoors-v12' — terrain shading, contour lines, trails for hiking/outdoor; 'mapbox/satellite-v9' — pure satellite imagery, NO labels; 'mapbox/satellite-streets-v12' — satellite imagery + street & place labels. Or a custom 'username/styleId'." },
            segment: {
              type: "string",
              enum: SEGMENT_KEYS,
              description: "Apply segment-tuned Standard style config and auto-fill center/zoom if not provided",
            },
            standard_config: {
              type: "object",
              description: "Standard style config overrides: lightPreset (day/dusk/dawn/night), colorLand, colorWater, colorRoad, show3dBuildings, showPlaceLabels, etc. Auto-selects webgl renderer.",
            },
            renderer: {
              type: "string",
              enum: ["webgl", "static"],
              description: "'webgl' = full GL JS render via headless Chrome — supports mapbox/standard, 3D, all Standard config (~5-10s). Default for mapbox/standard. 'static' = Mapbox Static Images API — fast (~500ms) but Classic styles only; use only when speed matters or user asks for a Classic style. Default: auto (webgl for Standard, static for Classic).",
            },
          },
        },
      },
      {
        name: "static_overlay",
        description:
          "Figma Design mode only. Render a static map image AND project geographic features (pins, routes, isochrones) " +
          "to exact {x,y} pixel coordinates relative to that image, so Figma can place them as real, editable vector layers " +
          "on top of the map. Camera is always explicit (center + zoom required). " +
          "Routes and isochrones are fetched server-side — no interactive code needed. " +
          "Returns TWO text blocks: " +
          "(1) Fetchable PNG URL — curl to get bytes, upload via upload_assets, set as image fill. " +
          "(2) JSON with { viewport, overlays: { markers, routes, isochrones } }, each with pixel {x,y,in_view} per point. " +
          "Note: {x,y} coords are logical (non-retina) pixels — if retina=true the image bytes are 2×, " +
          "but size the Figma frame to width×height and use the logical pixel coords.",
        inputSchema: {
          type: "object",
          properties: {
            center: { type: "array", items: { type: "number" }, description: "[lng, lat] of the map center (required)" },
            zoom: { type: "number", description: "Zoom level (required)" },
            bearing: { type: "number", description: "Map rotation in degrees 0–360 (default 0 = north-up)" },
            retina: { type: "boolean", description: "Return @2x high-DPI image bytes (default true). Pixel coords are still in logical px." },
            style: { type: "string", description: "Mapbox style to render. Defaults to 'mapbox/standard'. WebGL styles (support 3D + Standard config): 'mapbox/standard' — 3D buildings & landmarks, dynamic lighting, themes, full Standard config (default); 'mapbox/standard-satellite' — satellite imagery base + 3D + labels. Classic styles (fast Static Images API, 2D only): 'mapbox/streets-v12' — detailed street map; 'mapbox/light-v11' — minimal light backdrop for data overlays; 'mapbox/dark-v11' — minimal dark backdrop; 'mapbox/outdoors-v12' — terrain/trails; 'mapbox/satellite-v9' — pure satellite, no labels; 'mapbox/satellite-streets-v12' — satellite + labels. Or a custom 'username/styleId'." },
            segment: { type: "string", enum: SEGMENT_KEYS, description: "Apply segment-tuned Standard config to the basemap" },
            standard_config: { type: "object", description: "Standard style config overrides (lightPreset, colorLand, show3dBuildings, etc.)" },
            markers: {
              type: "array",
              description: "Point features to project. Each projected to {lng,lat,x,y,in_view,label?}.",
              items: {
                type: "object",
                properties: {
                  lng: { type: "number" },
                  lat: { type: "number" },
                  label: { type: "string", description: "Optional text label for the pin" },
                  color: { type: "string", description: "Optional hex color hint for the pin (#rrggbb)" },
                },
                required: ["lng", "lat"],
              },
            },
            routes: {
              type: "array",
              description: "Routes to fetch (Directions API) and project. Each projected to {distance,duration,coordinates,pixels}.",
              items: {
                type: "object",
                properties: {
                  waypoints: { type: "array", items: { type: "string" }, description: "Addresses or 'lng,lat' strings" },
                  profile: { type: "string", enum: ["driving", "walking", "cycling"], description: "Default 'driving'" },
                },
                required: ["waypoints"],
              },
            },
            isochrones: {
              type: "array",
              description: "Isochrones to fetch and project. Each feature's ring vertices projected to pixel coords.",
              items: {
                type: "object",
                properties: {
                  location: { type: "string", description: "Address or 'lng,lat'" },
                  contours_minutes: { type: "array", items: { type: "number" }, description: "Travel-time contours in minutes, e.g. [5,10,15]" },
                  profile: { type: "string", enum: ["driving", "walking", "cycling"], description: "Default 'driving'" },
                },
                required: ["location", "contours_minutes"],
              },
            },
          },
          required: ["center", "zoom"],
        },
      },
      {
        name: "category_search",
        description: "⚠️ Figma Make only. Search for POIs or places by category near a location — for populating interactive map layers.",
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
        name: "manage_style",
        description:
          "Create, read, update, or delete Mapbox styles for the authenticated account. " +
          "action='list' — list all styles (optional limit, start pagination token). " +
          "action='retrieve' — fetch a style by styleId. " +
          "action='create' — create a new style (requires name + style spec object). " +
          "action='update' — PATCH an existing style (requires styleId; provide name and/or style fields to change). " +
          "action='delete' — permanently delete a style by styleId.",
        inputSchema: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["list", "retrieve", "create", "update", "delete"] },
            styleId: { type: "string", description: "Style ID — required for retrieve, update, delete" },
            name: { type: "string", description: "Style name — required for create, optional for update" },
            style: { type: "object", description: "Mapbox Style Spec object — required for create, optional partial for update" },
            limit: { type: "number", description: "Max styles to return (list only, recommend 5–10)" },
            start: { type: "string", description: "Pagination start token from previous list response" },
          },
          required: ["action"],
        },
      },
      // ── Mapbox Tokens API (session auth required) ──────────────────────
      {
        name: "manage_tokens",
        description:
          "List or create Mapbox public access tokens (pk.*) for the authenticated account. " +
          "action='list' — list existing tokens (check here before creating to avoid proliferation). " +
          "action='create' — create a new scoped token (requires note + scopes).",
        inputSchema: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["list", "create"] },
            note: { type: "string", description: "Description of the token — required for create" },
            scopes: {
              type: "array",
              items: { type: "string", enum: ["styles:tiles", "styles:read", "fonts:read", "datasets:read", "vision:read"] },
              description: "Token scopes — required for create",
            },
            allowedUrls: { type: "array", items: { type: "string" }, description: "URLs where token is valid (max 100, create only)" },
            expires: { type: "string", description: "ISO 8601 expiry (max 1h in the future, create only)" },
          },
          required: ["action"],
        },
      },
      // ── DevKit MCP proxy ───────────────────────────────────────────────
      {
        name: "validate_expression",
        description: "⚠️ Figma Make only. Validate a Mapbox GL filter or paint expression — a GL JS dev helper for interactive maps.",
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
        description: "Generate an interactive HTML preview URL for a Mapbox style. Open the returned URL in a browser to see the style live.",
        inputSchema: {
          type: "object",
          properties: {
            styleId: { type: "string", description: "Style ID (the part after the username in mapbox://styles/username/STYLE_ID)" },
            title: { type: "string", description: "Optional title to display in the preview" },
            zoomwheel: { type: "boolean", description: "Enable scroll-to-zoom (default true)" },
          },
          required: ["styleId"],
        },
      },
      {
        name: "get_reference",
        description:
          "⚠️ Figma Make only. Look up Mapbox Style Spec documentation for a property, layer type, or expression operator — GL JS dev reference.",
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
  {
    name: "mode_brief",
    description:
      "Inject at conversation start to brief the agent on which Figma product it is operating in. " +
      "Figma Design → static map images + UI/design recommendations + style CRUD only (no interactive GL JS). " +
      "Figma Make → full interactive Mapbox GL JS prototyping. " +
      "Pass mode='design' or mode='make'.",
    arguments: [
      {
        name: "mode",
        description: "Either 'design' (Figma Design — static only) or 'make' (Figma Make — interactive)",
        required: true,
      },
    ],
  },
];

const CARTOGRAPHY_PRIMER = `CARTOGRAPHY RULES:

MAP TYPE:
  Navigate / find location   → Reference map
  Understand data patterns   → Thematic map (choropleth for rates; symbols/heatmap for counts/points)
  Locate branded points      → Business locator (markers foreground, basemap neutral)
  Tell a data story          → Journalistic/expressive (flat over 3D)

VISUAL HIERARCHY (top → bottom):
  User content → POI symbols/labels → Road labels → Roads → Buildings → Land/water

FIGURE-GROUND:
  Desaturated land = background. Saturated data = foreground.
  Lighten/desaturate the basemap if data isn't reading — not the data.

COLOR:
  Land lightness ≥ 90% (light) / ≤ 15% (dark).
  Route/line contrast ≥ 4.5:1 on basemap (WCAG AA) — design_audit flags failures.

ZOOM:
  z0–4: capitals only · z5–8: cities/highways · z9–11: neighborhoods
  z12–15: streets/POIs · z16+: house numbers
  Fade over 1–2 zoom levels: ['interpolate',['linear'],['zoom'], 11, 0, 12, 1]

STANDARD STYLE:
  setConfigProperty("basemap", key, value) — never setStyle() for Standard.
  Keys: colorLand, colorWater, colorRoad, lightPreset, showPlaceLabels, show3dBuildings.`;

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

  if (name === "mode_brief") {
    const mode: ClientMode = args.mode === "design" ? "design" : "make";
    return [{ role: "user", content: { type: "text", text: modeBriefText(mode) } }];
  }

  throw new Error(`Unknown prompt: "${name}". Available: ${MCP_PROMPTS.map((p) => p.name).join(", ")}`);
}


app.get("/mcp", (c) => {
  const mode = getRequestMode(c);
  return c.json({
    ...MCP_SERVER_INFO,
    description: "Map Studio MCP gateway — cartographic design tools, Mapbox geocoding/routing/isochrone, and style DevKit",
    mode,
    tools: toolsForMode(mode, MCP_TOOLS),
  });
});

// ── Tool execution helpers ────────────────────────────────────────────────────

/** Validate a Mapbox routing profile string before interpolating it into a URL path. */
function validateProfile(profile: string): string {
  if (!ALLOWED_PROFILES.has(profile)) {
    throw new Error(
      `Invalid profile "${profile}". Must be one of: ${[...ALLOWED_PROFILES].join(", ")}.`
    );
  }
  return profile;
}

/** Validate a Mapbox style string before interpolating it into a URL path or HTML. */
function validateStyle(style: string): string {
  if (!STYLE_RE.test(style)) {
    throw new Error(
      `Invalid style "${style}". Use "owner/styleId" or "mapbox://styles/owner/styleId".`
    );
  }
  return style;
}

// ── Image hosting helpers ─────────────────────────────────────────────────────

/**
 * Store a base64-encoded image in KV and return a publicly fetchable URL.
 * Images expire after 1 hour. Keyed as `img:<uuid>` to avoid collision with sessions.
 * The URL includes a file extension so consumers that sniff by filename get the right codec.
 */
async function hostImage(
  env: Env,
  base: string,
  image: { data: string; mimeType: string },
): Promise<string> {
  const id = crypto.randomUUID();
  const binary = atob(image.data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  await env.SESSIONS.put(`img:${id}`, bytes.buffer, {
    expirationTtl: 3600,
    metadata: { mimeType: image.mimeType },
  });
  const ext = image.mimeType === "image/png" ? ".png" : ".jpg";
  return `${base}/img/${id}${ext}`;
}

// ── MCP response builder ──────────────────────────────────────────────────────

type McpContentBlock = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

/**
 * Map an `executeTool` result to an MCP content array.
 *
 * Contract for image tools:
 *   - `_image`     → WebGL render (base64). Stored in KV; first block is a fetchable URL
 *                    the agent can curl: `curl <url> -o /tmp/map.png` then upload via upload_assets.
 *   - `_image_url` → CDN URL (classic Static Images). First block is the URL string.
 * When `viewport` / `overlays` are present (static_overlay), a second JSON text block
 * is appended so Figma can place editable vector layers at the correct pixel positions.
 *
 * Exported for unit-testing the synchronous branches (no KV needed when env=null).
 */
export async function buildToolContent(
  result: unknown,
  env: Env | null,
  base: string,
): Promise<McpContentBlock[]> {
  if (result && typeof result === "object" && "_image" in (result as object)) {
    const r = result as { _image: { data: string; mimeType: string }; viewport?: unknown; overlays?: unknown; [k: string]: unknown };
    const url = env ? await hostImage(env, base, r._image) : `${base}/img/<no-env>`;
    const content: McpContentBlock[] = [
      { type: "image", data: r._image.data, mimeType: r._image.mimeType },
      { type: "text", text: url },
    ];
    if (r.viewport !== undefined || r.overlays !== undefined) {
      content.push({ type: "text", text: JSON.stringify({ viewport: r.viewport, overlays: r.overlays }, null, 2) });
    }
    return content;
  }

  if (result && typeof result === "object" && "_image_url" in (result as object)) {
    const r = result as { _image_url: string; viewport?: unknown; overlays?: unknown; [k: string]: unknown };
    const content: McpContentBlock[] = [{ type: "text", text: r._image_url }];
    if (r.viewport !== undefined || r.overlays !== undefined) {
      content.push({ type: "text", text: JSON.stringify({ viewport: r.viewport, overlays: r.overlays }, null, 2) });
    }
    return content;
  }

  const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
  return [{ type: "text", text }];
}

// ── Tool execution core ───────────────────────────────────────────────────────

async function executeTool(
  toolName: string,
  input: Record<string, unknown>,
  mapboxToken: string | null,
  publicToken: string | null = null,
  env: Env | null = null,
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
  }

  // ── Auth-required tools ───────────────────────────────────────────────────
  if (!mapboxToken) throw new Error("Authentication required. Connect the MCP server to authorise.");

  // Mapbox Styles / Tokens API — called directly, no proxy
  switch (toolName) {
    case "manage_style": {
      const { action, styleId, name, style, limit, start } = input as {
        action: string; styleId?: string; name?: string; style?: object;
        limit?: number; start?: string;
      };
      const u = encodeURIComponent(getUserNameFromToken(mapboxToken));
      if (action === "list") {
        const qs = new URLSearchParams({ access_token: mapboxToken });
        if (limit) qs.set("limit", String(limit));
        if (start) qs.set("start", String(start));
        const res = await fetch(`https://api.mapbox.com/styles/v1/${u}?${qs}`);
        if (!res.ok) throw new Error(`Mapbox Styles API error ${res.status}: ${await res.text().catch(() => res.statusText)}`);
        return res.json();
      }
      if (action === "retrieve") {
        if (!styleId) throw new Error("manage_style action='retrieve' requires styleId");
        const res = await fetch(`https://api.mapbox.com/styles/v1/${u}/${encodeURIComponent(styleId)}?access_token=${mapboxToken}`);
        if (!res.ok) throw new Error(`Mapbox Styles API error ${res.status}: ${await res.text().catch(() => res.statusText)}`);
        return res.json();
      }
      if (action === "create") {
        if (!name || !style) throw new Error("manage_style action='create' requires name and style");
        const res = await fetch(`https://api.mapbox.com/styles/v1/${u}?access_token=${mapboxToken}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...style, name }),
        });
        if (!res.ok) throw new Error(`Mapbox Styles API error ${res.status}: ${await res.text().catch(() => res.statusText)}`);
        return res.json();
      }
      if (action === "update") {
        if (!styleId) throw new Error("manage_style action='update' requires styleId");
        const styleUrl = `https://api.mapbox.com/styles/v1/${u}/${encodeURIComponent(styleId)}?access_token=${mapboxToken}`;
        // Styles API PATCH requires the full style object — GET current first, then merge
        const getRes = await fetch(styleUrl);
        if (!getRes.ok) throw new Error(`Mapbox Styles API error ${getRes.status}: ${await getRes.text().catch(() => getRes.statusText)}`);
        const current = await getRes.json() as Record<string, unknown>;
        const payload: Record<string, unknown> = { ...current };
        if (name) payload.name = name;
        if (style) Object.assign(payload, style);
        const res = await fetch(styleUrl, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!res.ok) throw new Error(`Mapbox Styles API error ${res.status}: ${await res.text().catch(() => res.statusText)}`);
        return res.json();
      }
      if (action === "delete") {
        if (!styleId) throw new Error("manage_style action='delete' requires styleId");
        const res = await fetch(`https://api.mapbox.com/styles/v1/${u}/${encodeURIComponent(styleId)}?access_token=${mapboxToken}`, { method: "DELETE" });
        if (res.status === 204) return { deleted: true };
        if (!res.ok) throw new Error(`Mapbox Styles API error ${res.status}: ${await res.text().catch(() => res.statusText)}`);
        return res.json();
      }
      throw new Error(`manage_style: unknown action "${action}". Use list | retrieve | create | update | delete`);
    }
    case "manage_tokens": {
      const { action, note, scopes, allowedUrls, expires } = input as {
        action: string; note?: string; scopes?: string[]; allowedUrls?: string[]; expires?: string;
      };
      if (mapboxToken.startsWith("pk.")) {
        throw new Error("A secret token (sk.*) is required to manage tokens. Public tokens (pk.*) cannot access the Tokens API. Create a secret token at account.mapbox.com and reconnect the MCP server with it.");
      }
      const u = encodeURIComponent(getUserNameFromToken(mapboxToken));
      if (action === "list") {
        const qs = new URLSearchParams({ access_token: mapboxToken });
        const res = await fetch(`https://api.mapbox.com/tokens/v2/${u}?${qs}`);
        if (!res.ok) throw new Error(`Mapbox Tokens API error ${res.status}: ${await res.text().catch(() => res.statusText)}`);
        return res.json();
      }
      if (action === "create") {
        if (!note || !scopes) throw new Error("manage_tokens action='create' requires note and scopes");
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
      throw new Error(`manage_tokens: unknown action "${action}". Use list | create`);
    }
    case "directions": {
      const { waypoints, profile = "driving" } = input as { waypoints: string[]; profile?: string };
      validateProfile(profile);
      // Use full steps=true response for the interactive tool (richer than the helper's overview-only fetch)
      const coords = await Promise.all((waypoints as string[]).map((wp) => geocodeOne(wp, mapboxToken)));
      const coordStr = coords.map(([lng, lat]) => `${lng},${lat}`).join(";");
      const res = await fetch(
        `https://api.mapbox.com/directions/v5/mapbox/${profile}/${coordStr}?access_token=${mapboxToken}&geometries=geojson&steps=true&overview=full`
      );
      if (!res.ok) throw new Error(`Mapbox Directions API error ${res.status}: ${await res.text().catch(() => res.statusText)}`);
      return res.json();
    }

    case "category_search": {
      const { category, proximity, limit = 5 } = input as { category: string; proximity?: string; limit?: number };
      const params = new URLSearchParams({
        access_token: mapboxToken,
        limit: String(Math.min(limit as number, 10)),
        language: "en",
      });
      if (proximity) {
        try {
          const [lng, lat] = await geocodeOne(proximity as string, mapboxToken);
          params.set("proximity", `${lng},${lat}`);
        } catch { /* proximity is optional — continue without it */ }
      }
      const res = await fetch(
        `https://api.mapbox.com/search/searchbox/v1/category/${encodeURIComponent(category as string)}?${params}`
      );
      if (!res.ok) throw new Error(`Mapbox Search API error ${res.status}: ${await res.text().catch(() => res.statusText)}`);
      const json = await res.json() as { features?: Array<{ properties: Record<string, unknown>; geometry: { coordinates: [number, number] } }> };
      return {
        results: (json.features ?? []).map((f) => ({
          name: f.properties.name,
          category: f.properties.poi_category,
          coordinates: f.geometry.coordinates,
          address: f.properties.full_address ?? f.properties.address,
          mapbox_id: f.properties.mapbox_id,
        })),
      };
    }

    // ── Previously-proxied Mapbox REST tools (now implemented natively) ────────

    case "geocode": {
      const { query } = input as { query: string };
      // Detect reverse geocode: "lng,lat"
      const isReverse = /^-?\d+\.?\d*,-?\d+\.?\d*$/.test(query.trim());
      const endpoint = isReverse
        ? `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(query.trim())}.json`
        : `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(query)}.json`;
      const res = await fetch(`${endpoint}?access_token=${mapboxToken}&limit=5`);
      if (!res.ok) throw new Error(`Mapbox Geocoding API error ${res.status}: ${await res.text().catch(() => res.statusText)}`);
      return res.json();
    }

    case "isochrone": {
      const { location, contours_minutes, profile = "driving" } = input as {
        location: string;
        contours_minutes: number[];
        profile?: string;
      };
      validateProfile(profile);
      const [lng, lat] = await geocodeOne(location, mapboxToken);
      const params = new URLSearchParams({
        access_token: mapboxToken,
        contours_minutes: (contours_minutes as number[]).join(","),
        polygons: "true",
      });
      const res = await fetch(
        `https://api.mapbox.com/isochrone/v1/mapbox/${profile}/${lng},${lat}?${params}`
      );
      if (!res.ok) throw new Error(`Mapbox Isochrone API error ${res.status}: ${await res.text().catch(() => res.statusText)}`);
      return res.json(); // raw GeoJSON for the interactive tool
    }

    case "matrix": {
      const { origins, destinations, profile = "driving" } = input as {
        origins: string[];
        destinations: string[];
        profile?: string;
      };
      validateProfile(profile);
      const originCoords = await Promise.all((origins as string[]).map((o) => geocodeOne(o, mapboxToken)));
      const destCoords = await Promise.all((destinations as string[]).map((d) => geocodeOne(d, mapboxToken)));
      const allCoords = [...originCoords, ...destCoords];
      const coordStr = allCoords.map(([lng, lat]) => `${lng},${lat}`).join(";");
      const sourceIdx = originCoords.map((_, i) => i).join(";");
      const destIdx = destCoords.map((_, i) => originCoords.length + i).join(";");
      const params = new URLSearchParams({
        access_token: mapboxToken,
        annotations: "duration,distance",
        sources: sourceIdx,
        destinations: destIdx,
      });
      const res = await fetch(
        `https://api.mapbox.com/directions-matrix/v1/mapbox/${profile}/${coordStr}?${params}`
      );
      if (!res.ok) throw new Error(`Mapbox Matrix API error ${res.status}: ${await res.text().catch(() => res.statusText)}`);
      return res.json();
    }

    case "static_map": {
      const width = 600;
      const height = 400;
      const {
        bearing = 0,
        pitch = 0,
        retina = true,
        style,
        segment,
        standard_config,
        renderer,
      } = input as {
        center?: [number, number];
        zoom?: number;
        bearing?: number;
        pitch?: number;
        retina?: boolean;
        style?: string;
        segment?: string;
        standard_config?: Record<string, unknown>;
        renderer?: "webgl" | "static";
      };

      // pk.* token required — needed for both renderers
      const token = publicToken ?? (mapboxToken.startsWith("pk.") ? mapboxToken : null);
      if (!token) {
        throw new Error(
          "static_map requires a public (pk.*) token. " +
          "Re-authorise the MCP server and paste your pk.* token in the 'Public key' field on the consent page."
        );
      }

      // Resolve center/zoom: explicit input → segment default → error
      let center = input.center as [number, number] | undefined;
      let zoom = input.zoom as number | undefined;
      if (segment && SEGMENT_PREVIEW_CENTERS[segment] && (center === undefined || zoom === undefined)) {
        const sc = SEGMENT_PREVIEW_CENTERS[segment];
        center = center ?? [sc.lng, sc.lat];
        zoom = zoom ?? sc.zoom;
      }
      if (center === undefined || zoom === undefined) {
        throw new Error("static_map: provide center=[lng,lat] and zoom, or segment= to auto-fill.");
      }

      // Build Standard config entries (merged: segment preset + manual overrides)
      const configEntries: Record<string, unknown> = {};
      if (segment && PRESETS[segment]) Object.assign(configEntries, PRESETS[segment]);
      if (standard_config && typeof standard_config === "object") Object.assign(configEntries, standard_config);

      // Style resolution + validation
      const hasStandardConfig = Object.keys(configEntries).length > 0;
      const resolvedStyle = validateStyle(style ?? "mapbox/standard");

      // ── Renderer routing ──────────────────────────────────────────────────────
      // WebGL (Cloudflare Browser Rendering): supports mapbox/standard, 3D, all Standard config
      // Static Images API: fast (~500ms), classic styles only
      const useWebGL =
        renderer === "webgl" ||
        (renderer !== "static" && (resolvedStyle === "mapbox/standard" || hasStandardConfig));

      if (useWebGL) {
        const imageData = await screenshotMap(
          { center, zoom, bearing, pitch, width, height, style: resolvedStyle, standardConfig: configEntries, publicToken: token, retina },
          env!.BROWSER,
        );
        return {
          _image: imageData,
          renderer: "webgl",
          width,
          height,
          center,
          zoom,
          bearing,
          pitch,
          style: resolvedStyle,
          ...(hasStandardConfig ? { standard_config: configEntries } : {}),
          // No url — image content is returned directly
        };
      }

      // ── Static Images API path (fast, classic styles) ─────────────────────────
      // Return the URL directly — CDN blocks server-side fetching, client fetches it instead.
      const [lng, lat] = center;
      const sizeStr = retina ? `${width}x${height}@2x` : `${width}x${height}`;
      const camera = pitch !== 0 ? `${lng},${lat},${zoom},${bearing},${pitch}` : `${lng},${lat},${zoom},${bearing}`;
      const staticUrl =
        `https://api.mapbox.com/styles/v1/${resolvedStyle}/static/` +
        `${camera}/${sizeStr}` +
        `?access_token=${token}`;

      return { _image_url: staticUrl, renderer: "static" };
    }

    case "static_overlay": {
      const width = 600;
      const height = 400;
      const {
        center,
        zoom,
        bearing = 0,
        retina = true,
        style,
        segment,
        standard_config,
        markers = [],
        routes = [],
        isochrones = [],
      } = input as {
        center: [number, number];
        zoom: number;
        bearing?: number;
        retina?: boolean;
        style?: string;
        segment?: string;
        standard_config?: Record<string, unknown>;
        markers?: Array<{ lng: number; lat: number; label?: string; color?: string }>;
        routes?: Array<{ waypoints: string[]; profile?: string }>;
        isochrones?: Array<{ location: string; contours_minutes: number[]; profile?: string }>;
      };

      // pk.* token required for image rendering
      const overlayToken = publicToken ?? (mapboxToken.startsWith("pk.") ? mapboxToken : null);
      if (!overlayToken) {
        throw new Error(
          "static_overlay requires a public (pk.*) token. " +
          "Re-authorise the MCP server and paste your pk.* token in the 'Public key' field."
        );
      }

      // Build config (segment preset + manual overrides)
      const overlayConfig: Record<string, unknown> = {};
      if (segment && PRESETS[segment]) Object.assign(overlayConfig, PRESETS[segment]);
      if (standard_config && typeof standard_config === "object") Object.assign(overlayConfig, standard_config);

      const resolvedOverlayStyle = validateStyle(style ?? "mapbox/standard");
      const hasOverlayConfig = Object.keys(overlayConfig).length > 0;
      const useOverlayWebGL =
        resolvedOverlayStyle === "mapbox/standard" || hasOverlayConfig;

      // 1. Render static image (parallel with geometry fetches)
      // WebGL path: returns { _image: { data, mimeType } } — bytes are later hosted in KV.
      // Classic path: returns { _image_url: url } — CDN URL the client fetches directly.
      //   (CDN blocks server-side fetch; returning the URL avoids an unnecessary round-trip.)
      type RenderResult = { _image: { data: string; mimeType: string } } | { _image_url: string };
      const renderPromise: Promise<RenderResult> = useOverlayWebGL
        ? screenshotMap(
            { center, zoom, bearing, pitch: 0, width, height, style: resolvedOverlayStyle, standardConfig: overlayConfig, publicToken: overlayToken, retina },
            env!.BROWSER,
          ).then((imageData) => ({ _image: imageData }))
        : Promise.resolve((() => {
            const [lng, lat] = center;
            const sizeStr = retina ? `${width}x${height}@2x` : `${width}x${height}`;
            const cameraStr = `${lng},${lat},${zoom},${bearing}`;
            const url =
              `https://api.mapbox.com/styles/v1/${resolvedOverlayStyle}/static/` +
              `${cameraStr}/${sizeStr}` +
              `?access_token=${overlayToken}`;
            return { _image_url: url };
          })());

      // 2. Fetch geometry in parallel
      const routePromises = routes.map((r) =>
        fetchDirectionsGeometry(r.waypoints, r.profile ?? "driving", mapboxToken)
      );
      const isoPromises = isochrones.map((iso) =>
        fetchIsochronePolygons(iso.location, iso.contours_minutes, iso.profile ?? "driving", mapboxToken)
      );

      const [imageResult, ...restResults] = await Promise.all([
        renderPromise,
        ...routePromises,
        ...isoPromises,
      ]);

      const routeResults = restResults.slice(0, routes.length) as Awaited<ReturnType<typeof fetchDirectionsGeometry>>[];
      const isoResults = restResults.slice(routes.length) as Awaited<ReturnType<typeof fetchIsochronePolygons>>[];

      // 3. Build viewport and project
      const viewport: Viewport = { center, zoom, width, height, bearing };

      const projectedMarkers = markers.map((m) => ({
        lng: m.lng,
        lat: m.lat,
        ...(m.label ? { label: m.label } : {}),
        ...(m.color ? { color: m.color } : {}),
        ...project(m.lng, m.lat, viewport),
      }));

      const projectedRoutes = routeResults.map((r, i) => ({
        profile: routes[i].profile ?? "driving",
        distance: r.distance,
        duration: r.duration,
        coordinates: r.coordinates,
        pixels: projectCoords(r.coordinates, viewport),
      }));

      const projectedIsochrones = isoResults.flatMap((features, i) =>
        features.map((f) => ({
          location: isochrones[i].location,
          contour_minutes: f.contour_minutes,
          rings: f.rings.map((ring) => projectCoords(ring, viewport)),
        }))
      );

      return {
        ...imageResult,   // either { _image: { data, mimeType } } or { _image_url: url }
        renderer: useOverlayWebGL ? "webgl" : "static",
        viewport,
        overlays: {
          markers: projectedMarkers,
          routes: projectedRoutes,
          isochrones: projectedIsochrones,
        },
      };
    }

    // ── Previously-proxied DevKit tools (now implemented natively) ─────────────

    case "validate_expression": {
      const { expression } = input as { expression: unknown };
      return validateExpression(expression);
    }

    case "preview_style": {
      const { styleId, title, zoomwheel = true } = input as { styleId: string; title?: string; zoomwheel?: boolean };
      if (!publicToken) {
        throw new Error(
          "preview_style requires a public (pk.*) token to generate a shareable URL. " +
          "Re-authorise the MCP server and paste your pk.* token in the 'Public key' field on the consent page. " +
          "A secret (sk.*) token will never be embedded in a preview URL."
        );
      }
      const user = encodeURIComponent(getUserNameFromToken(mapboxToken));
      const params = new URLSearchParams({ access_token: publicToken, fresh: "true" });
      if (title) params.set("title", String(title));
      if (!zoomwheel) params.set("zoomwheel", "false");
      const url = `https://api.mapbox.com/styles/v1/${user}/${encodeURIComponent(styleId)}.html?${params}`;
      return { url, styleId, note: "Open this URL in a browser to preview the style interactively." };
    }

    case "get_reference": {
      const { topic } = input as { topic: string };
      const result = getReference(topic);
      if (result.found) return result.entry;
      return {
        found: false,
        message: `No reference entry for "${topic}".`,
        available_topics: result.available,
      };
    }

  } // end switch

  throw new Error(`Unknown tool: ${toolName}`);
}

// ── MCP tool execution ──────────────────────────────────────────────────────

app.post("/mcp", async (c) => {
  const body = await c.req.json<Record<string, unknown>>();
  const base = `https://${c.req.header("host")}`;
  const authHeader = c.req.header("Authorization");
  const mapboxToken = await getMapboxToken(authHeader, c.env);
  const publicToken = await getPublicToken(authHeader, c.env);

  // ── Standard MCP JSON-RPC protocol ────────────────────────────────────────
  if (body.jsonrpc === "2.0") {
    const { id, method, params } = body as { id: unknown; method: string; params?: Record<string, unknown> };

    if (method === "initialize") {
      // Log clientInfo so we can later detect Figma Make vs Figma Design automatically.
      // To inspect: run `wrangler tail` after connecting from each Figma product.
      const clientInfo = (params as Record<string, unknown> | undefined)?.clientInfo;
      const clientRequestedVersion = (params as Record<string, unknown> | undefined)?.protocolVersion as string | undefined;
      console.log("[initialize] clientInfo:", JSON.stringify(clientInfo ?? null));
      const initMode = getRequestMode(c);
      // Echo the client's requested protocol version when it's a known version we support;
      // otherwise respond with the latest version we implement.
      const SUPPORTED_VERSIONS = new Set(["2024-11-05", "2025-03-26", "2025-06-18"]);
      const negotiatedVersion = (clientRequestedVersion && SUPPORTED_VERSIONS.has(clientRequestedVersion))
        ? clientRequestedVersion
        : "2025-06-18";
      return c.json({
        jsonrpc: "2.0", id,
        result: {
          protocolVersion: negotiatedVersion,
          capabilities: { tools: {}, prompts: { listChanged: false } },
          serverInfo: MCP_SERVER_INFO,
          // Spec-sanctioned auto-delivered instructions — surfaces as a system prompt
          // in compliant hosts so the agent knows its mode without fetching mode_brief.
          instructions: modeBriefText(initMode),
        },
      });
    }

    if (method === "notifications/initialized") {
      // JSON-RPC notifications must not receive a response (no id field in request).
      // Return 204 to satisfy the HTTP layer without sending a JSON-RPC response object.
      return new Response(null, { status: 204 });
    }

    if (method === "tools/list") {
      const mode = getRequestMode(c);
      return c.json({ jsonrpc: "2.0", id, result: { tools: toolsForMode(mode, MCP_TOOLS) } });
    }

    if (method === "tools/call") {
      // Rate-limit per session (or IP when unauthenticated)
      const rlKey = authHeader?.replace(/^Bearer\s+/i, "").trim() || (c.req.header("CF-Connecting-IP") ?? "unknown");
      if (!(await checkRateLimit(c.env.SESSIONS, `mcp:${rlKey}`, RATE_LIMIT_TOOL_CALLS))) {
        return c.json({ jsonrpc: "2.0", id, error: { code: -32000, message: "Rate limit exceeded — max 120 tool calls per minute per session." } }, 429);
      }

      const toolName = (params?.name ?? "") as string;
      const input = (params?.arguments ?? {}) as Record<string, unknown>;
      // Enforce mode gating on dispatch — same filtering as tools/list.
      // Design mode may not call interactive-only tools and vice versa.
      const callMode = getRequestMode(c);
      if (callMode === "design" && INTERACTIVE_ONLY_TOOLS.has(toolName)) {
        return c.json({ jsonrpc: "2.0", id, error: { code: -32601, message: `Tool "${toolName}" is not available in Design mode.` } });
      }
      if (callMode === "make" && DESIGN_ONLY_TOOLS.has(toolName)) {
        return c.json({ jsonrpc: "2.0", id, error: { code: -32601, message: `Tool "${toolName}" is not available in Make mode.` } });
      }
      try {
        const result = await executeTool(toolName, input, mapboxToken, publicToken, c.env);
        const content = await buildToolContent(result, c.env, base);
        return c.json({ jsonrpc: "2.0", id, result: { content } });
      } catch (err) {
        const raw = err instanceof Error ? err.message : String(err);
        // Signal re-auth if the error is an auth failure
        if (raw.includes("Authentication required") || raw.includes("Connect the MCP server")) {
          return c.json(
            { jsonrpc: "2.0", id, error: { code: -32001, message: raw } },
            401,
            { "WWW-Authenticate": `Bearer realm="${base}", resource_metadata="${base}/.well-known/oauth-protected-resource"` },
          );
        }
        // Sanitize upstream Mapbox API error bodies from the message to avoid leaking internal details.
        // Preserve our own informative messages; strip raw HTTP response bodies (they often contain JSON blobs).
        const sanitized = raw.replace(/:\s*\{.*\}$/s, "").replace(/:\s*\[.*\]$/s, "").trim();
        return c.json({ jsonrpc: "2.0", id, error: { code: -32000, message: sanitized } });
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
  // Apply the same mode gating as the JSON-RPC path.
  const legacyMode = getRequestMode(c);
  if (legacyMode === "design" && INTERACTIVE_ONLY_TOOLS.has(tool)) {
    return c.json({ error: `Tool "${tool}" is not available in Design mode.` }, 400);
  }
  if (legacyMode === "make" && DESIGN_ONLY_TOOLS.has(tool)) {
    return c.json({ error: `Tool "${tool}" is not available in Make mode.` }, 400);
  }
  try {
    return c.json(await executeTool(tool, input, mapboxToken, publicToken, c.env));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: msg.replace(/:\s*\{.*\}$/s, "").replace(/:\s*\[.*\]$/s, "").trim() }, 400);
  }
});

export default app;
