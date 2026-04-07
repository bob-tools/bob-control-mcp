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
import fs from "fs";
import path from "path";
import os from "os";
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
let adbSerial = null; // selected device serial (null = auto if only one)

// Cloud state
let cloudSessionId = null;

// ── Logging ──

function log(msg) {
  process.stderr.write(`[bob-control] ${msg}\n`);
}

// ── Device lock (file-based, cross-process) ──

const LOCK_DIR = path.join(os.homedir(), ".bob-control-mcp");
const LOCK_DEFAULT_S = 10;
const LOCK_MAX_S = 120;
const MY_PID = process.pid;

function lockFilePath(deviceId) {
  const safe = (deviceId || "adb-local").replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(LOCK_DIR, `lock_${safe}.json`);
}

/**
 * Check if device is locked by another process.
 * Returns { locked: false } or { locked: true, remainingSeconds, pid }.
 */
function checkDeviceLock(deviceId) {
  const fp = lockFilePath(deviceId);
  try {
    const data = JSON.parse(fs.readFileSync(fp, "utf-8"));
    if (data.pid === MY_PID) return { locked: false };
    if (Date.now() > data.expiresAt) {
      // Expired — clean up
      try { fs.unlinkSync(fp); } catch {}
      return { locked: false };
    }
    // Check if holding process is still alive
    try {
      process.kill(data.pid, 0); // signal 0 = just check existence
    } catch {
      // Process is dead — stale lock
      try { fs.unlinkSync(fp); } catch {}
      return { locked: false };
    }
    const remaining = Math.ceil((data.expiresAt - Date.now()) / 1000);
    return { locked: true, remainingSeconds: Math.max(1, remaining), pid: data.pid };
  } catch {
    return { locked: false };
  }
}

function acquireDeviceLock(deviceId, seconds) {
  if (seconds <= 0) return;
  fs.mkdirSync(LOCK_DIR, { recursive: true });
  const fp = lockFilePath(deviceId);
  fs.writeFileSync(fp, JSON.stringify({ pid: MY_PID, expiresAt: Date.now() + seconds * 1000 }));
}

function releaseDeviceLock(deviceId) {
  const fp = lockFilePath(deviceId);
  try {
    const data = JSON.parse(fs.readFileSync(fp, "utf-8"));
    if (data.pid === MY_PID) fs.unlinkSync(fp);
  } catch {}
}

// ── ADB helpers ──

/** Resolve full path to adb binary (PATH may be minimal in MCP context). */
const ADB_BIN = (() => {
  // Try absolute paths first (MCP servers often have minimal PATH)
  const absolutePaths = [
    "/opt/homebrew/bin/adb",
    "/usr/local/bin/adb",
    `${os.homedir()}/Library/Android/sdk/platform-tools/adb`,
    `${os.homedir()}/Android/Sdk/platform-tools/adb`,
  ];
  for (const p of absolutePaths) {
    try {
      if (fs.existsSync(p)) {
        log(`Found adb: ${p}`);
        return p;
      }
    } catch {}
  }
  // Fall back to PATH lookup
  try {
    execSync("adb version", { stdio: "pipe", timeout: 5000 });
    log("Found adb in PATH");
    return "adb";
  } catch {}
  log("WARNING: adb not found");
  return "adb";
})();

/** Returns "-s <serial> " prefix if a device is selected, or "" for auto. */
function adbPrefix() {
  return adbSerial ? `${ADB_BIN} -s ${adbSerial} ` : `${ADB_BIN} `;
}

/** Parse `adb devices -l` into [{serial, status, model, product, device, transportId}]. */
function listAdbDevices() {
  try {
    const out = execSync(`${ADB_BIN} devices -l`, { stdio: "pipe", encoding: "utf-8", timeout: 5000 });
    return out.trim().split("\n").slice(1)
      .filter((l) => /\s+device\b/.test(l))
      .map((line) => {
        const [serial] = line.split(/\s+/);
        const model = line.match(/model:(\S+)/)?.[1] || "";
        const product = line.match(/product:(\S+)/)?.[1] || "";
        const device = line.match(/device:(\S+)/)?.[1] || "";
        const tid = line.match(/transport_id:(\d+)/)?.[1] || "";
        return { serial, model, product, device, transport_id: tid };
      });
  } catch {
    return [];
  }
}

function adbAvailable() {
  return listAdbDevices().length > 0;
}

function ensureAdbForward(force = false) {
  if (adbPortForwarded && !force) return;
  execSync(`${adbPrefix()}forward tcp:${ADB_PORT} tcp:${ADB_PORT}`, { stdio: "pipe", timeout: 5000 });
  adbPortForwarded = true;
}

function fetchAdbToken() {
  const now = Date.now();
  if (adbToken && now - adbTokenFetchedAt < ADB_TOKEN_REFRESH_MS) return adbToken;
  adbToken = execSync(`${adbPrefix()}shell run-as bob.tools.control cat files/adb_token`, {
    stdio: "pipe",
    encoding: "utf-8",
    timeout: 5000,
  }).trim();
  adbTokenFetchedAt = now;
  return adbToken;
}

function adbServerRunning() {
  // If no serial selected and multiple devices, try each one
  if (!adbSerial) {
    const devices = listAdbDevices();
    if (devices.length > 1) {
      for (const d of devices) {
        try {
          execSync(`${ADB_BIN} -s ${d.serial} forward tcp:${ADB_PORT} tcp:${ADB_PORT}`, { stdio: "pipe", timeout: 5000 });
          execSync(`${ADB_BIN} -s ${d.serial} shell run-as bob.tools.control cat files/adb_token`, { stdio: "pipe", timeout: 5000 });
          // Found a device with ADB server — auto-select it
          adbSerial = d.serial;
          adbPortForwarded = true;
          adbToken = null;
          adbTokenFetchedAt = 0;
          log(`Auto-selected device with ADB server: ${d.serial}`);
          return true;
        } catch {}
      }
      return false;
    }
  }
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

  if (result.status === 401) {
    // Token expired or invalid — force refresh and retry once
    adbToken = null;
    adbTokenFetchedAt = 0;
    try {
      const newToken = fetchAdbToken();
      result = await httpRequest(
        `http://127.0.0.1:${ADB_PORT}/command`,
        "POST",
        { command, params: params || undefined },
        { Authorization: `Bearer ${newToken}` }
      );
    } catch (e) {
      throw new Error(
        "ADB Unauthorized: token refresh failed.\n" +
          "Fix: restart this MCP server (it will re-read the token from device).\n" +
          "The ADB token rotates every 15 minutes — a server restart picks up the fresh one."
      );
    }
  }

  if (result.status === 401) {
    throw new Error(
      "ADB Unauthorized even after token refresh.\n" +
        "Possible causes:\n" +
        "1. ADB server in BOB Control app was restarted (generates new token) — restart this MCP server\n" +
        "2. Accessibility Service is disabled — re-enable in Settings → Accessibility → BOB Control\n" +
        "3. App was reinstalled — re-enable Accessibility Service in Settings"
    );
  }

  if (result.status !== 200) throw new Error(result.body?.error || `ADB command failed: HTTP ${result.status}`);
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
  {
    name: "phone_unlock_device",
    description: "Release the exclusive lock on a device, allowing other sessions to control it.",
    inputSchema: {
      type: "object",
      properties: {
        device_id: { type: "string", description: "Device ID to unlock (optional, uses current device if omitted)" },
      },
    },
  },
];

const LOCK_PROP = {
  lock: {
    type: "integer",
    description: "Exclusive lock duration in seconds (default: 10, max: 120). Prevents other sessions from controlling this device. Set to 0 to skip.",
  },
};

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
    inputSchema: { type: "object", properties: { ...LOCK_PROP } },
  },
  {
    name: "phone_get_ui_tree",
    description:
      "Get the UI accessibility tree. Returns text content, bounds, and element type. Preferred over screenshot.",
    inputSchema: { type: "object", properties: { ...LOCK_PROP } },
  },
  {
    name: "phone_tap",
    description: "Tap at specific screen coordinates.",
    inputSchema: {
      type: "object",
      properties: { x: { type: "number" }, y: { type: "number" }, ...LOCK_PROP },
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
        ...LOCK_PROP,
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
        ...LOCK_PROP,
      },
      required: ["startX", "startY", "endX", "endY"],
    },
  },
  {
    name: "phone_type",
    description: "Type text into the currently focused input field.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" }, ...LOCK_PROP },
      required: ["text"],
    },
  },
  {
    name: "phone_press_back",
    description: "Press the Back button.",
    inputSchema: { type: "object", properties: { ...LOCK_PROP } },
  },
  {
    name: "phone_press_home",
    description: "Press the Home button.",
    inputSchema: { type: "object", properties: { ...LOCK_PROP } },
  },
  {
    name: "phone_press_recents",
    description: "Press the Recent Apps button.",
    inputSchema: { type: "object", properties: { ...LOCK_PROP } },
  },
  {
    name: "phone_get_apps",
    description: "List installed apps.",
    inputSchema: { type: "object", properties: { ...LOCK_PROP } },
  },
  {
    name: "phone_open_app",
    description: "Open an app by package name.",
    inputSchema: {
      type: "object",
      properties: { package: { type: "string" }, ...LOCK_PROP },
      required: ["package"],
    },
  },
  {
    name: "phone_get_notifications",
    description: "Get active notifications.",
    inputSchema: { type: "object", properties: { ...LOCK_PROP } },
  },
  {
    name: "phone_open_notification",
    description: "Open a notification by key.",
    inputSchema: {
      type: "object",
      properties: { key: { type: "string" }, ...LOCK_PROP },
      required: ["key"],
    },
  },
  {
    name: "phone_dismiss_notification",
    description: "Dismiss a notification by key.",
    inputSchema: {
      type: "object",
      properties: { key: { type: "string" }, ...LOCK_PROP },
      required: ["key"],
    },
  },
  {
    name: "phone_dismiss_all_notifications",
    description: "Dismiss all notifications.",
    inputSchema: { type: "object", properties: { ...LOCK_PROP } },
  },
  {
    name: "phone_enable_adb",
    description: "Enable ADB local server on the device. Returns port and auth token for direct USB control.",
    inputSchema: {
      type: "object",
      properties: {
        auto_start: { type: "boolean", description: "Auto-start on service restart (default: true)" },
        ...LOCK_PROP,
      },
    },
  },
  {
    name: "phone_disable_adb",
    description: "Disable ADB local server on the device.",
    inputSchema: { type: "object", properties: { ...LOCK_PROP } },
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
  phone_enable_adb: "enable_adb",
  phone_disable_adb: "disable_adb",
};

// ── Tool execution ──

async function executeTool(name, args) {
  try {
    // Meta tools — handled locally regardless of transport
    if (name === "phone_authenticate") return await handleAuthenticate();
    if (name === "phone_logout") return handleLogout();
    if (name === "phone_set_transport") return handleSetTransport(args.mode);
    if (name === "phone_status") return handleStatus();
    if (name === "phone_unlock_device") {
      if (transport === "adb") return handleUnlock(args.device_id);
      // Cloud mode — fall through to cloudMcpCall below
    }

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
          "No transport available. Cannot reach device.\n\n" +
            "Option 1 — ADB (local, faster):\n" +
            "  1. Connect phone via USB\n" +
            "  2. Run 'adb devices' to verify connection\n" +
            "  3. In BOB Control app → enable ADB server (Step 6)\n" +
            "  4. Restart this MCP server to re-detect\n\n" +
            "Option 2 — Cloud (remote):\n" +
            "  1. Use phone_authenticate to log in\n" +
            "  2. In BOB Control app → pair device (Step 1)"
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
    if (e.code === "ECONNREFUSED" || e.message?.includes("ECONNREFUSED")) {
      // Port forward may be stale — re-establish and retry once
      if (transport === "adb") {
        try {
          log("Connection refused — re-establishing ADB port forward and retrying...");
          ensureAdbForward(true);
          adbToken = null;
          adbTokenFetchedAt = 0;
          const retryResult = await executeAdb(name, args);
          return retryResult;
        } catch (retryErr) {
          if (retryErr.code === "ECONNREFUSED" || retryErr.message?.includes("ECONNREFUSED")) {
            return err(
              "Cannot connect to ADB server on device (connection refused).\n" +
                "The ADB port forward was re-established but the server on the device is not responding.\n" +
                "Fix: in BOB Control app → Step 6, toggle ADB server OFF then ON again."
            );
          }
          return err(retryErr.message);
        }
      }
      return err(
        "Cannot connect to ADB server on device (connection refused).\n" +
          "Fix: in BOB Control app → Step 6, toggle ADB server OFF then ON again."
      );
    }
    if (e.code === "ECONNRESET" || e.message?.includes("socket hang up")) {
      return err(
        "Connection to device lost (socket hang up).\n" +
          "This usually means the MCP server or ADB connection was interrupted.\n" +
          "Fix: restart this MCP server. If using USB, re-plug the cable."
      );
    }
    return err(e.message);
  }
}

async function executeAdb(name, args) {
  const command = TOOL_TO_ADB_COMMAND[name];
  if (!command) {
    // ADB device management
    if (name === "phone_list_devices") {
      const devices = listAdbDevices();
      if (devices.length === 0) return err("No ADB devices connected.");
      const lines = devices.map((d) => {
        const selected = d.serial === adbSerial ? " ← selected" : "";
        return `${d.serial}  ${d.model || d.product || d.device}${selected}`;
      });
      if (!adbSerial && devices.length === 1) {
        lines[0] += " (auto)";
      }
      return ok(`Connected devices (${devices.length}):\n${lines.join("\n")}` +
        (devices.length > 1 && !adbSerial ? "\n\nMultiple devices — use phone_select_device to pick one." : ""));
    }
    if (name === "phone_select_device") {
      const serial = args.device_id;
      const devices = listAdbDevices();
      const match = devices.find((d) => d.serial === serial);
      if (!match) return err(`Device ${serial} not found. Available: ${devices.map((d) => d.serial).join(", ")}`);
      adbSerial = serial;
      // Reset port forward and token for the new device
      adbPortForwarded = false;
      adbToken = null;
      adbTokenFetchedAt = 0;
      return ok(`Selected device: ${serial} (${match.model || match.product})`);
    }
    if (name === "phone_check_command") {
      return ok("Not needed in ADB mode — commands return synchronously.");
    }
    return err(`Unknown tool: ${name}`);
  }

  // Auto-select if only one device; error if multiple and none selected
  if (!adbSerial) {
    const devices = listAdbDevices();
    if (devices.length > 1) {
      return err(`Multiple ADB devices connected. Use phone_select_device first.\nDevices: ${devices.map((d) => d.serial).join(", ")}`);
    }
    if (devices.length === 1) adbSerial = devices[0].serial;
  }

  // Device lock check (file-based, cross-process)
  const deviceId = adbSerial || "adb-local";
  const lockCheck = checkDeviceLock(deviceId);
  if (lockCheck.locked) {
    return err(`Device is currently in use by another session (pid ${lockCheck.pid}). It will be available in ~${lockCheck.remainingSeconds}s. Retry after that.`);
  }

  const lockSeconds = Math.min(LOCK_MAX_S, Math.max(0, args.lock ?? LOCK_DEFAULT_S));
  acquireDeviceLock(deviceId, lockSeconds);

  // Strip lock param before sending to device
  const { lock: _lock, ...deviceArgs } = args;
  const params = Object.keys(deviceArgs).length > 0 ? deviceArgs : undefined;

  const result = await sendCommandAdb(command, params);

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
    if (!adbServerRunning())
      return err(
        "ADB server not responding on device.\n" +
          "Fix: use phone_enable_adb (via cloud) to start it remotely, or toggle ADB server ON in BOB Control app → Step 6.\n" +
          "Also check: USB cable connected and 'adb devices' shows your device."
      );
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

function handleUnlock(deviceId) {
  if (transport === "adb") {
    releaseDeviceLock(deviceId || adbSerial || "adb-local");
    return ok("Device unlocked.");
  }
  // Cloud mode — proxy to server (it handles its own lock)
  // Fall through to cloudMcpCall would be ideal but we handle it here
  // since unlock is in META_TOOLS. For cloud, just release local lock
  // and note the server lock is managed server-side.
  return ok("Cloud device lock is managed server-side. The lock will expire automatically.");
}

function handleStatus() {
  const devices = listAdbDevices();
  const authed = isAuthenticated();
  const adbServerOk = transport === "adb" || (devices.length > 0 && adbServerRunning());
  const info = [
    `Transport: ${transport || "not set"}`,
    `ADB devices: ${devices.length > 0 ? devices.map((d) => `${d.serial} (${d.model || d.product})${d.serial === adbSerial ? " ← selected" : ""}`).join(", ") : "none"}`,
    `ADB server: ${adbServerOk ? "running" : devices.length > 0 ? "not running (use phone_enable_adb)" : "n/a"}`,
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

    case "notifications/initialized": {
      const devices = listAdbDevices();
      if (devices.length === 1) adbSerial = devices[0].serial;
      if (devices.length > 0 && adbServerRunning()) {
        transport = "adb";
        log(`Auto-detected ADB device → local transport${adbSerial ? ` (${adbSerial})` : ""}`);
      } else if (isAuthenticated()) {
        transport = "cloud";
        log("Using cloud transport (authenticated)");
      } else {
        log("No transport detected. Connect ADB or use phone_authenticate.");
      }
      break;
    }

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

// Clean up locks on exit
function cleanupLocks() {
  releaseDeviceLock("adb-local");
  if (adbSerial) releaseDeviceLock(adbSerial);
}
process.on("exit", cleanupLocks);
process.on("SIGINT", () => { cleanupLocks(); process.exit(0); });
process.on("SIGTERM", () => { cleanupLocks(); process.exit(0); });

log("BOB Control MCP plugin started");
