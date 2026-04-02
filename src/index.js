#!/usr/bin/env node

/**
 * BOB Control MCP Plugin — phone control via ADB or cloud relay.
 *
 * Two transport modes:
 *   - ADB (local):  Direct HTTP to device via adb forward. Zero latency, no internet needed.
 *   - Cloud (remote): JSON-RPC proxy to McpControlServlet with OAuth auth.
 *
 * Auto-detects ADB on startup. Falls back to cloud if authenticated.
 * Use phone_set_transport to switch manually.
 * Use phone_authenticate to log in for cloud mode (opens browser, OAuth flow).
 */

import { execSync } from "child_process";
import { createInterface } from "readline";
import http from "http";
import https from "https";
import { authorize, getAccessToken, isAuthenticated, logout } from "./oauth.js";

// ── Config ──

const ADB_PORT = 7071;
const CLOUD_MCP_URL =
  (process.env.BOB_SERVER_URL?.replace(/\/$/, "") || "https://api.bob.tools") + "/mcp-control";

// ── State ──

let transport = null; // "adb" | "cloud"

// ADB state
let adbToken = null;
let adbTokenFetchedAt = 0;
const ADB_TOKEN_REFRESH_MS = 14 * 60 * 1000;
let adbPortForwarded = false;

// Cloud state
let cloudSessionId = null;

// ── Logging ──

function log(msg) {
  process.stderr.write(`[bob-control] ${msg}\n`);
}

// ── ADB helpers ──

function adbAvailable() {
  try {
    const out = execSync("adb devices", { stdio: "pipe", encoding: "utf-8", timeout: 5000 });
    return out.trim().split("\n").slice(1).filter((l) => l.includes("\tdevice")).length > 0;
  } catch {
    return false;
  }
}

function ensureAdbForward() {
  if (adbPortForwarded) return;
  execSync(`adb forward tcp:${ADB_PORT} tcp:${ADB_PORT}`, { stdio: "pipe", timeout: 5000 });
  adbPortForwarded = true;
}

function fetchAdbToken() {
  const now = Date.now();
  if (adbToken && now - adbTokenFetchedAt < ADB_TOKEN_REFRESH_MS) return adbToken;
  adbToken = execSync("adb shell run-as bob.tools.control cat files/adb_token", {
    stdio: "pipe",
    encoding: "utf-8",
    timeout: 5000,
  }).trim();
  adbTokenFetchedAt = now;
  return adbToken;
}

function adbServerRunning() {
  try {
    ensureAdbForward();
    fetchAdbToken();
    return true;
  } catch {
    return false;
  }
}

// ── HTTP helpers ──

function httpRequest(url, method, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === "https:" ? https : http;
    const bodyStr = body ? (typeof body === "string" ? body : JSON.stringify(body)) : null;

    const opts = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method,
      headers: { "Content-Type": "application/json", ...headers },
    };
    if (bodyStr) opts.headers["Content-Length"] = Buffer.byteLength(bodyStr);

    const req = mod.request(opts, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        // Capture session ID from response headers
        const sid = res.headers["mcp-session-id"];
        if (sid) cloudSessionId = sid;
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data), headers: res.headers });
        } catch {
          resolve({ status: res.statusCode, body: data, headers: res.headers });
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(65000, () => {
      req.destroy();
      reject(new Error("Request timed out"));
    });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ── ADB command execution ──

async function sendCommandAdb(command, params) {
  ensureAdbForward();
  const token = fetchAdbToken();
  let result = await httpRequest(
    `http://127.0.0.1:${ADB_PORT}/command`,
    "POST",
    { command, params: params || undefined },
    { Authorization: `Bearer ${token}` }
  );

  if (result.status === 401 && result.body?.error?.includes("expired")) {
    adbToken = null;
    adbTokenFetchedAt = 0;
    const newToken = fetchAdbToken();
    result = await httpRequest(
      `http://127.0.0.1:${ADB_PORT}/command`,
      "POST",
      { command, params: params || undefined },
      { Authorization: `Bearer ${newToken}` }
    );
  }

  if (result.status !== 200) throw new Error(result.body?.error || `HTTP ${result.status}`);
  return result.body;
}

// ── Cloud MCP proxy ──

async function cloudMcpCall(toolName, toolArgs) {
  let token = await getAccessToken();
  if (!token) {
    throw new Error("Not authenticated. Use phone_authenticate to log in first.");
  }

  const jsonRpc = {
    jsonrpc: "2.0",
    id: Date.now(),
    method: "tools/call",
    params: { name: toolName, arguments: toolArgs },
  };

  const headers = { Authorization: `Bearer ${token}` };
  if (cloudSessionId) headers["Mcp-Session-Id"] = cloudSessionId;

  let result = await httpRequest(CLOUD_MCP_URL, "POST", jsonRpc, headers);

  // Token expired — refresh and retry once
  if (result.status === 401) {
    log("Access token expired, refreshing...");
    token = await getAccessToken(); // Will auto-refresh
    if (!token) throw new Error("Re-authentication required. Use phone_authenticate.");
    headers.Authorization = `Bearer ${token}`;
    result = await httpRequest(CLOUD_MCP_URL, "POST", jsonRpc, headers);
  }

  if (result.status !== 200) {
    throw new Error(result.body?.error?.message || `Cloud MCP error: HTTP ${result.status}`);
  }

  const rpc = result.body;
  if (rpc.error) throw new Error(rpc.error.message || "Cloud MCP error");

  return rpc.result;
}

// ── Tool definitions ──

const META_TOOLS = [
  {
    name: "phone_authenticate",
    description:
      "Log in to BOB Control cloud. Opens browser for OAuth. Required for cloud mode. Not needed for ADB.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "phone_logout",
    description: "Log out from BOB Control cloud. Clears stored tokens.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "phone_set_transport",
    description:
      'Set connection mode: "adb" for local USB/WiFi, or "cloud" for remote cloud relay via OAuth. ADB is faster and works offline.',
    inputSchema: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["adb", "cloud"], description: '"adb" or "cloud"' },
      },
      required: ["mode"],
    },
  },
  {
    name: "phone_status",
    description: "Show current connection status: transport mode, device, ADB/cloud auth availability.",
    inputSchema: { type: "object", properties: {} },
  },
];

const DEVICE_TOOLS = [
  {
    name: "phone_list_devices",
    description: "List registered devices. In cloud mode, uses authenticated MCP session.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "phone_select_device",
    description: "Select a device to control by its device ID.",
    inputSchema: {
      type: "object",
      properties: {
        device_id: { type: "string", description: "Device ID to select" },
      },
      required: ["device_id"],
    },
  },
  {
    name: "phone_check_command",
    description: "Check the result of a previously sent cloud command.",
    inputSchema: {
      type: "object",
      properties: {
        command_id: { type: "string", description: "Command ID to check" },
      },
      required: ["command_id"],
    },
  },
  {
    name: "phone_screenshot",
    description: "Take a screenshot of the phone screen. Returns JPEG image.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "phone_get_ui_tree",
    description:
      "Get the UI accessibility tree. Returns text content, bounds, and element type. Preferred over screenshot.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "phone_tap",
    description: "Tap at specific screen coordinates.",
    inputSchema: {
      type: "object",
      properties: {
        x: { type: "number" },
        y: { type: "number" },
      },
      required: ["x", "y"],
    },
  },
  {
    name: "phone_tap_text",
    description: "Find a UI element by visible text/description and tap on it. More reliable than coordinates.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text or content description to find" },
        exact: { type: "boolean", description: "Exact match (default: false)" },
        index: { type: "integer", description: "Which match to tap (0-based)" },
      },
      required: ["text"],
    },
  },
  {
    name: "phone_swipe",
    description: "Perform a swipe gesture.",
    inputSchema: {
      type: "object",
      properties: {
        startX: { type: "number" },
        startY: { type: "number" },
        endX: { type: "number" },
        endY: { type: "number" },
        duration: { type: "number", description: "Duration in ms (default: 300)" },
      },
      required: ["startX", "startY", "endX", "endY"],
    },
  },
  {
    name: "phone_type",
    description: "Type text into the currently focused input field.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
  },
  {
    name: "phone_press_back",
    description: "Press the Back button.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "phone_press_home",
    description: "Press the Home button.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "phone_press_recents",
    description: "Press the Recent Apps button.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "phone_get_apps",
    description: "List installed apps.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "phone_open_app",
    description: "Open an app by package name.",
    inputSchema: {
      type: "object",
      properties: { package: { type: "string" } },
      required: ["package"],
    },
  },
  {
    name: "phone_get_notifications",
    description: "Get active notifications.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "phone_open_notification",
    description: "Open a notification by key.",
    inputSchema: {
      type: "object",
      properties: { key: { type: "string" } },
      required: ["key"],
    },
  },
  {
    name: "phone_dismiss_notification",
    description: "Dismiss a notification by key.",
    inputSchema: {
      type: "object",
      properties: { key: { type: "string" } },
      required: ["key"],
    },
  },
  {
    name: "phone_dismiss_all_notifications",
    description: "Dismiss all notifications.",
    inputSchema: { type: "object", properties: {} },
  },
];

const ALL_TOOLS = [...META_TOOLS, ...DEVICE_TOOLS];

const TOOL_TO_ADB_COMMAND = {
  phone_screenshot: "screenshot",
  phone_get_ui_tree: "get_ui_tree",
  phone_tap: "tap",
  phone_tap_text: "find_and_tap",
  phone_swipe: "swipe",
  phone_type: "type",
  phone_press_back: "press_back",
  phone_press_home: "press_home",
  phone_press_recents: "press_recents",
  phone_get_apps: "get_apps",
  phone_open_app: "open_app",
  phone_get_notifications: "get_notifications",
  phone_open_notification: "open_notification",
  phone_dismiss_notification: "dismiss_notification",
  phone_dismiss_all_notifications: "dismiss_all_notifications",
};

// ── Tool execution ──

async function executeTool(name, args) {
  try {
    // Meta tools — handled locally regardless of transport
    if (name === "phone_authenticate") return await handleAuthenticate();
    if (name === "phone_logout") return handleLogout();
    if (name === "phone_set_transport") return handleSetTransport(args.mode);
    if (name === "phone_status") return handleStatus();

    // Auto-detect transport on first command
    if (!transport) {
      if (adbAvailable() && adbServerRunning()) {
        transport = "adb";
        log("Auto-detected ADB transport");
      } else if (isAuthenticated()) {
        transport = "cloud";
        log("Using cloud transport (authenticated)");
      } else {
        return err(
          "No transport available.\n" +
            "- For ADB: connect phone via USB, enable ADB server in BOB Control app\n" +
            "- For cloud: use phone_authenticate to log in first"
        );
      }
    }

    // ADB mode — execute locally
    if (transport === "adb") {
      return await executeAdb(name, args);
    }

    // Cloud mode — proxy to McpControlServlet
    return await cloudMcpCall(name, args);
  } catch (e) {
    return err(e.message);
  }
}

async function executeAdb(name, args) {
  const command = TOOL_TO_ADB_COMMAND[name];
  if (!command) {
    // Cloud-only tools called in ADB mode
    if (name === "phone_list_devices" || name === "phone_select_device") {
      return ok("Not needed in ADB mode — device is connected directly via USB.");
    }
    if (name === "phone_check_command") {
      return ok("Not needed in ADB mode — commands return synchronously.");
    }
    return err(`Unknown tool: ${name}`);
  }

  const result = await sendCommandAdb(command, args);

  if (!result.success) return err(result.error || "Command failed");

  if (command === "screenshot" && typeof result.data === "string") {
    return { content: [{ type: "image", data: result.data, mimeType: "image/jpeg" }] };
  }

  const text = typeof result.data === "string" ? result.data : JSON.stringify(result.data, null, 2);
  return ok(text);
}

async function handleAuthenticate() {
  if (isAuthenticated()) {
    return ok("Already authenticated. Use phone_logout first to re-authenticate.");
  }
  try {
    await authorize();
    transport = "cloud";
    return ok("Authenticated successfully! Cloud transport is now active.\nUse phone_list_devices to see your devices.");
  } catch (e) {
    return err(`Authentication failed: ${e.message}`);
  }
}

function handleLogout() {
  logout();
  if (transport === "cloud") transport = null;
  return ok("Logged out. Cloud tokens cleared.");
}

function handleSetTransport(mode) {
  if (mode === "adb") {
    if (!adbAvailable()) return err("No ADB device connected.");
    if (!adbServerRunning()) return err("ADB server not running in BOB Control app. Enable it in Step 6.");
    transport = "adb";
    return ok("Transport: ADB (local). Commands go directly to device via USB.");
  }
  if (mode === "cloud") {
    if (!isAuthenticated()) return err("Not authenticated. Use phone_authenticate first.");
    transport = "cloud";
    return ok("Transport: Cloud. Commands go through api.bob.tools with OAuth.");
  }
  return err('Invalid mode. Use "adb" or "cloud".');
}

function handleStatus() {
  const hasAdb = adbAvailable();
  const authed = isAuthenticated();
  const info = [
    `Transport: ${transport || "not set"}`,
    `ADB device: ${hasAdb ? "connected" : "not found"}`,
    `ADB server: ${transport === "adb" ? "active" : hasAdb ? "not checked" : "n/a"}`,
    `Cloud auth: ${authed ? "logged in" : "not logged in"}`,
    `Cloud session: ${cloudSessionId || "none"}`,
  ];
  return ok(info.join("\n"));
}

function ok(text) {
  return { content: [{ type: "text", text: text || "OK" }] };
}
function err(text) {
  return { isError: true, content: [{ type: "text", text }] };
}

// ── MCP stdio protocol ──

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

let pendingRequests = 0;
let stdinClosed = false;

function trackRequest(promise) {
  pendingRequests++;
  return promise.finally(() => {
    pendingRequests--;
    if (stdinClosed && pendingRequests === 0) process.exit(0);
  });
}

const rl = createInterface({ input: process.stdin });

rl.on("line", async (line) => {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }

  const { id, method, params } = request;

  switch (method) {
    case "initialize":
      send({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "bob-control", version: "1.0.0" },
        },
      });
      break;

    case "notifications/initialized":
      if (adbAvailable() && adbServerRunning()) {
        transport = "adb";
        log("Auto-detected ADB device → local transport");
      } else if (isAuthenticated()) {
        transport = "cloud";
        log("Using cloud transport (authenticated)");
      } else {
        log("No transport detected. Connect ADB or use phone_authenticate.");
      }
      break;

    case "tools/list":
      send({ jsonrpc: "2.0", id, result: { tools: ALL_TOOLS } });
      break;

    case "tools/call": {
      const toolName = params?.name;
      const toolArgs = params?.arguments || {};
      log(`${toolName} ${JSON.stringify(toolArgs)}`);
      trackRequest(
        executeTool(toolName, toolArgs).then((result) => {
          send({ jsonrpc: "2.0", id, result });
        })
      );
      break;
    }

    default:
      if (id !== undefined) {
        send({
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Method not found: ${method}` },
        });
      }
  }
});

rl.on("close", () => {
  stdinClosed = true;
  if (pendingRequests === 0) process.exit(0);
});

log("BOB Control MCP plugin started");
