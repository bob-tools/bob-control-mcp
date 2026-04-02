/**
 * OAuth 2.0 client for BOB Control MCP server.
 * Implements Authorization Code + PKCE flow.
 *
 * Flow:
 *   1. Register client (dynamic registration)
 *   2. Open browser → user logs in on bob.tools
 *   3. Callback on localhost captures auth code
 *   4. Exchange code for access_token + refresh_token
 *   5. Auto-refresh access_token when expired
 *
 * Tokens are persisted to ~/.bob-control-mcp/tokens.json
 */

import { execSync } from "child_process";
import { createHash, randomBytes } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import http from "http";
import https from "https";
import { homedir } from "os";
import { join } from "path";

const CONFIG_DIR = join(homedir(), ".bob-control-mcp");
const TOKEN_FILE = join(CONFIG_DIR, "tokens.json");
const CLIENT_FILE = join(CONFIG_DIR, "client.json");

const SERVER_BASE = process.env.BOB_SERVER_URL?.replace(/\/mcp-control$/, "") || "https://api.bob.tools";
const CALLBACK_PORT = 19274; // Random high port for OAuth callback
const REDIRECT_URI = `http://127.0.0.1:${CALLBACK_PORT}/callback`;

function log(msg) {
  process.stderr.write(`[bob-control:oauth] ${msg}\n`);
}

// ── PKCE ──

function generateCodeVerifier() {
  return randomBytes(32).toString("base64url");
}

function generateCodeChallenge(verifier) {
  return createHash("sha256").update(verifier).digest("base64url");
}

// ── HTTP helper ──

function httpPost(url, body, { formEncoded = false } = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === "https:" ? https : http;
    const bodyStr = formEncoded
      ? new URLSearchParams(body).toString()
      : JSON.stringify(body);

    const req = mod.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: "POST",
        headers: {
          "Content-Type": formEncoded ? "application/x-www-form-urlencoded" : "application/json",
          "Content-Length": Buffer.byteLength(bodyStr),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode, body: data });
          }
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(15000, () => {
      req.destroy();
      reject(new Error("Timeout"));
    });
    req.write(bodyStr);
    req.end();
  });
}

// ── Token persistence ──

function ensureConfigDir() {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
}

function loadTokens() {
  try {
    if (existsSync(TOKEN_FILE)) {
      return JSON.parse(readFileSync(TOKEN_FILE, "utf-8"));
    }
  } catch {}
  return null;
}

function saveTokens(tokens) {
  ensureConfigDir();
  writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2), { mode: 0o600 });
}

function loadClient() {
  try {
    if (existsSync(CLIENT_FILE)) {
      return JSON.parse(readFileSync(CLIENT_FILE, "utf-8"));
    }
  } catch {}
  return null;
}

function saveClient(client) {
  ensureConfigDir();
  writeFileSync(CLIENT_FILE, JSON.stringify(client, null, 2), { mode: 0o600 });
}

// ── Client registration ──

async function ensureClient() {
  let client = loadClient();
  if (client?.client_id) return client;

  log("Registering OAuth client...");
  const result = await httpPost(`${SERVER_BASE}/oauth/register`, {
    client_name: "BOB Control MCP Plugin",
    redirect_uris: [REDIRECT_URI],
  });

  if (result.status !== 201) {
    throw new Error(`Client registration failed: ${JSON.stringify(result.body)}`);
  }

  client = result.body;
  saveClient(client);
  log(`Client registered: ${client.client_id}`);
  return client;
}

// ── OAuth flow ──

function startCallbackServer(state, codeVerifier) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://127.0.0.1:${CALLBACK_PORT}`);

      if (url.pathname !== "/callback") {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      const code = url.searchParams.get("code");
      const returnedState = url.searchParams.get("state");
      const error = url.searchParams.get("error");

      if (error) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<html><body><h2>Authorization failed</h2><p>You can close this tab.</p></body></html>");
        server.close();
        reject(new Error(`OAuth error: ${error}`));
        return;
      }

      if (returnedState !== state) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<html><body><h2>Invalid state</h2><p>CSRF protection triggered.</p></body></html>");
        server.close();
        reject(new Error("OAuth state mismatch"));
        return;
      }

      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        "<html><body><h2>BOB Control authorized!</h2><p>You can close this tab and return to Claude Code.</p></body></html>"
      );
      server.close();
      resolve(code);
    });

    server.listen(CALLBACK_PORT, "127.0.0.1", () => {
      log(`OAuth callback server listening on 127.0.0.1:${CALLBACK_PORT}`);
    });

    server.on("error", (e) => {
      reject(new Error(`Callback server failed: ${e.message}`));
    });

    // Timeout after 5 minutes
    setTimeout(() => {
      server.close();
      reject(new Error("OAuth flow timed out (5 minutes). Try again."));
    }, 5 * 60 * 1000);
  });
}

function openBrowser(url) {
  try {
    const platform = process.platform;
    if (platform === "darwin") {
      execSync(`open "${url}"`, { stdio: "pipe" });
    } else if (platform === "win32") {
      execSync(`start "" "${url}"`, { stdio: "pipe" });
    } else {
      execSync(`xdg-open "${url}"`, { stdio: "pipe" });
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Run the full OAuth authorization flow.
 * Opens browser, waits for callback, exchanges code for tokens.
 * Returns { access_token, refresh_token, expires_at }.
 */
export async function authorize() {
  const client = await ensureClient();

  const state = randomBytes(16).toString("hex");
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);

  // Start callback server before opening browser
  const codePromise = startCallbackServer(state, codeVerifier);

  // Build authorization URL
  const params = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: REDIRECT_URI,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    response_type: "code",
  });

  const authUrl = `${SERVER_BASE}/oauth/authorize?${params}`;
  log(`Opening browser for authorization...`);

  const opened = openBrowser(authUrl);
  if (!opened) {
    log(`Could not open browser. Please open this URL manually:\n${authUrl}`);
  }

  // Wait for callback
  const code = await codePromise;
  log("Authorization code received, exchanging for tokens...");

  // Exchange code for tokens
  const tokenResult = await httpPost(`${SERVER_BASE}/oauth/token`, {
    grant_type: "authorization_code",
    code,
    code_verifier: codeVerifier,
    client_id: client.client_id,
    redirect_uri: REDIRECT_URI,
  }, { formEncoded: true });

  if (tokenResult.status !== 200) {
    throw new Error(`Token exchange failed: ${JSON.stringify(tokenResult.body)}`);
  }

  const tokens = {
    access_token: tokenResult.body.access_token,
    refresh_token: tokenResult.body.refresh_token,
    expires_at: Date.now() + tokenResult.body.expires_in * 1000,
  };

  saveTokens(tokens);
  log("Tokens saved. Authorized successfully.");
  return tokens;
}

/**
 * Refresh the access token using the stored refresh token.
 */
export async function refreshAccessToken() {
  const tokens = loadTokens();
  if (!tokens?.refresh_token) {
    throw new Error("No refresh token. Run authorize() first.");
  }

  const client = loadClient();

  const result = await httpPost(`${SERVER_BASE}/oauth/token`, {
    grant_type: "refresh_token",
    refresh_token: tokens.refresh_token,
    client_id: client?.client_id,
  }, { formEncoded: true });

  if (result.status !== 200) {
    // Refresh token expired or invalid — need full re-auth
    log("Refresh token expired. Need to re-authorize.");
    try {
      unlinkSync(TOKEN_FILE);
    } catch {}
    throw new Error("Refresh token expired. Use phone_authenticate to log in again.");
  }

  tokens.access_token = result.body.access_token;
  tokens.expires_at = Date.now() + result.body.expires_in * 1000;
  saveTokens(tokens);
  log("Access token refreshed.");
  return tokens;
}

/**
 * Get a valid access token, auto-refreshing if needed.
 * Returns null if no tokens stored (need to authorize first).
 */
export async function getAccessToken() {
  let tokens = loadTokens();
  if (!tokens) return null;

  // Refresh 5 minutes before expiry
  if (tokens.expires_at && Date.now() > tokens.expires_at - 5 * 60 * 1000) {
    tokens = await refreshAccessToken();
  }

  return tokens.access_token;
}

/**
 * Check if user has stored tokens (is authenticated).
 */
export function isAuthenticated() {
  const tokens = loadTokens();
  return tokens?.refresh_token != null;
}

/**
 * Clear stored tokens (logout).
 */
export function logout() {
  try {
    unlinkSync(TOKEN_FILE);
  } catch {}
  log("Logged out. Tokens cleared.");
}
