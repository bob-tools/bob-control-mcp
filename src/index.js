#!/usr/bin/env node

/**
 * BOB Control MCP Plugin — phone control via ADB or cloud relay.
 *
 * Stateless per-call transport resolution:
 *   - Each tool call can specify `transport` ("adb"/"cloud") and `device_id`
 *   - If omitted, auto-detects: ADB if devices connected, cloud if authenticated
 *   - For ADB, device_id is the serial number (from `adb devices`)
 *   - For cloud, device_id is the cloud device ID (from phone_list_devices)
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

// ── State (minimal, cached) ──

// ADB per-device cache: serial -> { token, tokenFetchedAt, portForwarded }
const adbDeviceCache = new Map();
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

function checkDeviceLock(deviceId) {
  const fp = lockFilePath(deviceId);
  try {
    const data = JSON.parse(fs.readFileSync(fp, "utf-8"));
    if (data.pid === MY_PID) return { locked: false };
    if (Date.now() > data.expiresAt) {
      try { fs.unlinkSync(fp); } catch {}
      return { locked: false };
    }
    try { process.kill(data.pid, 0); } catch {
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
  fs.writeFileSync(lockFilePath(deviceId), JSON.stringify({ pid: MY_PID, expiresAt: Date.now() + seconds * 1000 }));
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
  const absolutePaths = [
    "/opt/homebrew/bin/adb",
    "/usr/local/bin/adb",
    `${os.homedir()}/Library/Android/sdk/platform-tools/adb`,
    `${os.homedir()}/Android/Sdk/platform-tools/adb`,
  ];
  for (const p of absolutePaths) {
    try {
      if (fs.existsSync(p)) { log(`Found adb: ${p}`); return p; }
    } catch {}
  }
  try {
    execSync("adb version", { stdio: "pipe", timeout: 5000 });
    log("Found adb in PATH");
    return "adb";
  } catch {}
  log("WARNING: adb not found");
  return "adb";
})();

function adbCmd(serial) {
  return serial ? `${ADB_BIN} -s ${serial} ` : `${ADB_BIN} `;
}

/** Parse `adb devices -l` into [{serial, model, product, device}]. */
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
        return { serial, model, product, device };
      });
  } catch {
    return [];
  }
}

function ensureAdbForward(serial) {
  const cache = adbDeviceCache.get(serial) || {};
  if (cache.portForwarded) return;
  execSync(`${adbCmd(serial)}forward tcp:${ADB_PORT} tcp:${ADB_PORT}`, { stdio: "pipe", timeout: 5000 });
  cache.portForwarded = true;
  adbDeviceCache.set(serial, cache);
}

function fetchAdbToken(serial) {
  const cache = adbDeviceCache.get(serial) || {};
  const now = Date.now();
  if (cache.token && now - cache.tokenFetchedAt < 14 * 60 * 1000) return cache.token;
  cache.token = execSync(`${adbCmd(serial)}shell run-as bob.tools.control cat files/adb_token`, {
    stdio: "pipe", encoding: "utf-8", timeout: 5000,
  }).trim();
  cache.tokenFetchedAt = now;
  adbDeviceCache.set(serial, cache);
  return cache.token;
}

/** Check if BOB Control ADB server is running on a specific device. */
function adbServerRunningOn(serial) {
  try {
    ensureAdbForward(serial);
    fetchAdbToken(serial);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve which ADB serial to use.
 * - If device_id given, validate it
 * - If omitted and one device, auto-select
 * - If omitted and multiple, try to find one with ADB server running
 */
function resolveAdbSerial(deviceId) {
  const devices = listAdbDevices();
  if (devices.length === 0) return { error: "No ADB devices connected. Connect a device via USB." };

  if (deviceId) {
    const match = devices.find((d) => d.serial === deviceId);
    if (!match) return { error: `ADB device ${deviceId} not found. Connected: ${devices.map((d) => `${d.serial} (${d.model})`).join(", ")}` };
    return { serial: deviceId };
  }

  if (devices.length === 1) return { serial: devices[0].serial };

  // Multiple devices — try to find one with ADB server
  for (const d of devices) {
    if (adbServerRunningOn(d.serial)) return { serial: d.serial };
  }
  return { error: `Multiple ADB devices connected. Specify device_id.\nDevices: ${devices.map((d) => `${d.serial} (${d.model})`).join(", ")}` };
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
        const sid = res.headers["mcp-session-id"];
        if (sid) cloudSessionId = sid;
        try { resolve({ status: res.statusCode, body: JSON.parse(data), headers: res.headers }); }
        catch { resolve({ status: res.statusCode, body: data, headers: res.headers }); }
      });
    });
    req.on("error", reject);
    req.setTimeout(65000, () => { req.destroy(); reject(new Error("Request timed out")); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ── ADB command execution ──

async function sendCommandAdb(serial, command, params) {
  ensureAdbForward(serial);
  let token = fetchAdbToken(serial);
  let result = await httpRequest(
    `http://127.0.0.1:${ADB_PORT}/command`, "POST",
    { command, params: params || undefined },
    { Authorization: `Bearer ${token}` }
  );

  if (result.status === 401) {
    // Token expired — force refresh and retry
    const cache = adbDeviceCache.get(serial) || {};
    cache.token = null;
    cache.tokenFetchedAt = 0;
    adbDeviceCache.set(serial, cache);
    try {
      token = fetchAdbToken(serial);
      result = await httpRequest(
        `http://127.0.0.1:${ADB_PORT}/command`, "POST",
        { command, params: params || undefined },
        { Authorization: `Bearer ${token}` }
      );
    } catch (e) {
      throw new Error(
        "ADB Unauthorized: token refresh failed.\n" +
        "Fix: restart this MCP server (it will re-read the token from device)."
      );
    }
  }

  if (result.status === 401) {
    throw new Error(
      "ADB Unauthorized even after token refresh.\n" +
      "Possible causes:\n" +
      "1. ADB server was restarted — restart this MCP server\n" +
      "2. Accessibility Service is disabled — re-enable in Settings\n" +
      "3. App was reinstalled — re-enable Accessibility Service"
    );
  }

  if (result.status !== 200) throw new Error(result.body?.error || `ADB command failed: HTTP ${result.status}`);
  return result.body;
}

// ── Cloud MCP proxy ──

async function cloudMcpCall(toolName, toolArgs) {
  let token = await getAccessToken();
  if (!token) throw new Error("Not authenticated. Use phone_authenticate to log in first.");

  const jsonRpc = {
    jsonrpc: "2.0", id: Date.now(),
    method: "tools/call",
    params: { name: toolName, arguments: toolArgs },
  };

  const headers = { Authorization: `Bearer ${token}` };
  if (cloudSessionId) headers["Mcp-Session-Id"] = cloudSessionId;

  let result = await httpRequest(CLOUD_MCP_URL, "POST", jsonRpc, headers);

  if (result.status === 401) {
    log("Access token expired, refreshing...");
    token = await getAccessToken();
    if (!token) throw new Error("Re-authentication required. Use phone_authenticate.");
    headers.Authorization = `Bearer ${token}`;
    result = await httpRequest(CLOUD_MCP_URL, "POST", jsonRpc, headers);
  }

  if (result.status !== 200) throw new Error(result.body?.error?.message || `Cloud MCP error: HTTP ${result.status}`);
  const rpc = result.body;
  if (rpc.error) throw new Error(rpc.error.message || "Cloud MCP error");
  return rpc.result;
}

// ── Tool definitions ──

const ROUTING_PROPS = {
  transport: {
    type: "string", enum: ["adb", "cloud"],
    description: 'Transport mode. "adb" for local USB, "cloud" for remote relay. Auto-detected if omitted.',
  },
  device_id: {
    type: "string",
    description: "Device ID: ADB serial (from phone_list_devices) or cloud device ID. Auto-detected if only one device.",
  },
};

const LOCK_PROP = {
  lock: {
    type: "integer",
    description: "Exclusive lock duration in seconds (default: 10, max: 120). Prevents other sessions from controlling this device. Set to 0 to skip.",
  },
};

const META_TOOLS = [
  {
    name: "phone_authenticate",
    description: "Log in to BOB Control cloud. Opens browser for OAuth. Required for cloud mode.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "phone_logout",
    description: "Log out from BOB Control cloud. Clears stored tokens.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "phone_status",
    description: "Show connection status: ADB devices, cloud auth, available transports.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "phone_list_devices",
    description: "List available devices. Shows ADB-connected devices and/or cloud-registered devices.",
    inputSchema: {
      type: "object",
      properties: {
        transport: ROUTING_PROPS.transport,
      },
    },
  },
  {
    name: "phone_unlock_device",
    description: "Release the exclusive lock on a device, allowing other sessions to control it.",
    inputSchema: {
      type: "object",
      properties: { device_id: ROUTING_PROPS.device_id },
    },
  },
];

const DEVICE_TOOLS = [
  {
    name: "phone_screenshot",
    description: "Take a screenshot of the phone screen. Returns JPEG image.",
    inputSchema: { type: "object", properties: { ...ROUTING_PROPS, ...LOCK_PROP } },
  },
  {
    name: "phone_get_ui_tree",
    description: "Get the UI accessibility tree. Returns text content, bounds, and element type.",
    inputSchema: { type: "object", properties: { ...ROUTING_PROPS, ...LOCK_PROP } },
  },
  {
    name: "phone_tap",
    description: "Tap at specific screen coordinates.",
    inputSchema: {
      type: "object",
      properties: { x: { type: "number" }, y: { type: "number" }, ...ROUTING_PROPS, ...LOCK_PROP },
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
        ...ROUTING_PROPS, ...LOCK_PROP,
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
        startX: { type: "number" }, startY: { type: "number" },
        endX: { type: "number" }, endY: { type: "number" },
        duration: { type: "number", description: "Duration in ms (default: 300)" },
        ...ROUTING_PROPS, ...LOCK_PROP,
      },
      required: ["startX", "startY", "endX", "endY"],
    },
  },
  {
    name: "phone_type",
    description: "Type text into the currently focused input field.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" }, ...ROUTING_PROPS, ...LOCK_PROP },
      required: ["text"],
    },
  },
  {
    name: "phone_press_back",
    description: "Press the Back button.",
    inputSchema: { type: "object", properties: { ...ROUTING_PROPS, ...LOCK_PROP } },
  },
  {
    name: "phone_press_home",
    description: "Press the Home button.",
    inputSchema: { type: "object", properties: { ...ROUTING_PROPS, ...LOCK_PROP } },
  },
  {
    name: "phone_press_recents",
    description: "Press the Recent Apps button.",
    inputSchema: { type: "object", properties: { ...ROUTING_PROPS, ...LOCK_PROP } },
  },
  {
    name: "phone_get_apps",
    description: "List installed apps.",
    inputSchema: { type: "object", properties: { ...ROUTING_PROPS, ...LOCK_PROP } },
  },
  {
    name: "phone_open_app",
    description: "Open an app by package name.",
    inputSchema: {
      type: "object",
      properties: { package: { type: "string" }, ...ROUTING_PROPS, ...LOCK_PROP },
      required: ["package"],
    },
  },
  {
    name: "phone_get_notifications",
    description: "Get active notifications.",
    inputSchema: { type: "object", properties: { ...ROUTING_PROPS, ...LOCK_PROP } },
  },
  {
    name: "phone_open_notification",
    description: "Open a notification by key.",
    inputSchema: {
      type: "object",
      properties: { key: { type: "string" }, ...ROUTING_PROPS, ...LOCK_PROP },
      required: ["key"],
    },
  },
  {
    name: "phone_dismiss_notification",
    description: "Dismiss a notification by key.",
    inputSchema: {
      type: "object",
      properties: { key: { type: "string" }, ...ROUTING_PROPS, ...LOCK_PROP },
      required: ["key"],
    },
  },
  {
    name: "phone_dismiss_all_notifications",
    description: "Dismiss all notifications.",
    inputSchema: { type: "object", properties: { ...ROUTING_PROPS, ...LOCK_PROP } },
  },
  {
    name: "phone_enable_adb",
    description: "Enable ADB local server on the device. Returns port and auth token.",
    inputSchema: {
      type: "object",
      properties: {
        auto_start: { type: "boolean", description: "Auto-start on service restart (default: true)" },
        ...ROUTING_PROPS, ...LOCK_PROP,
      },
    },
  },
  {
    name: "phone_disable_adb",
    description: "Disable ADB local server on the device.",
    inputSchema: { type: "object", properties: { ...ROUTING_PROPS, ...LOCK_PROP } },
  },
  {
    name: "phone_check_command",
    description: "Check the result of a previously sent cloud command.",
    inputSchema: {
      type: "object",
      properties: {
        command_id: { type: "string", description: "Command ID to check" },
        ...ROUTING_PROPS,
      },
      required: ["command_id"],
    },
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

// ── Transport resolution ──

/**
 * Resolve transport and device for a tool call.
 * Returns { transport: "adb"|"cloud", serial?, error? }
 */
function resolveTransport(args) {
  const requestedTransport = args.transport;
  const deviceId = args.device_id;

  if (requestedTransport === "adb") {
    const resolved = resolveAdbSerial(deviceId);
    if (resolved.error) return { error: resolved.error };
    return { transport: "adb", serial: resolved.serial };
  }

  if (requestedTransport === "cloud") {
    if (!isAuthenticated()) return { error: "Not authenticated. Use phone_authenticate first." };
    return { transport: "cloud", deviceId };
  }

  // Auto-detect: prefer ADB if devices are connected
  const devices = listAdbDevices();
  if (devices.length > 0) {
    const resolved = resolveAdbSerial(deviceId);
    if (!resolved.error && adbServerRunningOn(resolved.serial)) {
      return { transport: "adb", serial: resolved.serial };
    }
  }

  // Fall back to cloud
  if (isAuthenticated()) {
    return { transport: "cloud", deviceId };
  }

  return {
    error: "No transport available.\n\n" +
      "ADB: connect device via USB and enable ADB server in BOB Control app.\n" +
      "Cloud: use phone_authenticate to log in."
  };
}

// ── Tool execution ──

async function executeTool(name, args) {
  try {
    // Meta tools — no transport needed
    if (name === "phone_authenticate") return await handleAuthenticate();
    if (name === "phone_logout") return handleLogout();
    if (name === "phone_status") return handleStatus();
    if (name === "phone_unlock_device") return handleUnlock(args.device_id);

    if (name === "phone_list_devices") {
      return handleListDevices(args.transport);
    }

    // Resolve transport for device commands
    const route = resolveTransport(args);
    if (route.error) return err(route.error);

    // Strip routing params before forwarding
    const { transport: _t, device_id: _d, ...toolArgs } = args;

    if (route.transport === "adb") {
      return await executeAdb(name, toolArgs, route.serial);
    }

    // Cloud — pass device_id through if specified
    if (route.deviceId) toolArgs.device_id = route.deviceId;
    return await cloudMcpCall(name, toolArgs);
  } catch (e) {
    if (e.code === "ECONNREFUSED" || e.message?.includes("ECONNREFUSED")) {
      return err(
        "Cannot connect to ADB server on device.\n" +
        "Fix: in BOB Control app, toggle ADB server OFF then ON."
      );
    }
    if (e.code === "ECONNRESET" || e.message?.includes("socket hang up")) {
      return err("Connection lost. Fix: restart MCP server or re-plug USB cable.");
    }
    return err(e.message);
  }
}

async function executeAdb(name, args, serial) {
  const command = TOOL_TO_ADB_COMMAND[name];
  if (!command) {
    if (name === "phone_check_command") {
      return ok("Not needed in ADB mode — commands return synchronously.");
    }
    return err(`Unknown tool: ${name}`);
  }

  // Device lock
  const lockCheck = checkDeviceLock(serial);
  if (lockCheck.locked) {
    return err(`Device is currently in use by another session (pid ${lockCheck.pid}). It will be available in ~${lockCheck.remainingSeconds}s. Retry after that.`);
  }

  const lockSeconds = Math.min(LOCK_MAX_S, Math.max(0, args.lock ?? LOCK_DEFAULT_S));
  acquireDeviceLock(serial, lockSeconds);

  // Strip lock param before sending to device
  const { lock: _lock, ...deviceArgs } = args;
  const params = Object.keys(deviceArgs).length > 0 ? deviceArgs : undefined;

  const result = await sendCommandAdb(serial, command, params);

  if (!result.success) return err(result.error || "Command failed");

  if (command === "screenshot" && typeof result.data === "string") {
    return { content: [{ type: "image", data: result.data, mimeType: "image/jpeg" }] };
  }

  const text = typeof result.data === "string" ? result.data : JSON.stringify(result.data, null, 2);
  return ok(text);
}

// ── Handlers ──

async function handleAuthenticate() {
  if (isAuthenticated()) {
    return ok("Already authenticated. Use phone_logout first to re-authenticate.");
  }
  try {
    await authorize();
    return ok("Authenticated successfully! Use phone_list_devices to see your devices.");
  } catch (e) {
    return err(`Authentication failed: ${e.message}`);
  }
}

function handleLogout() {
  logout();
  return ok("Logged out. Cloud tokens cleared.");
}

function handleListDevices(requestedTransport) {
  const sections = [];

  // ADB devices
  if (!requestedTransport || requestedTransport === "adb") {
    const devices = listAdbDevices();
    if (devices.length > 0) {
      const lines = devices.map((d) => {
        const server = adbServerRunningOn(d.serial) ? " [ADB server running]" : "";
        return `  ${d.serial}  ${d.model || d.product || d.device}${server}`;
      });
      sections.push(`ADB devices (${devices.length}):\n${lines.join("\n")}`);
    } else {
      sections.push("ADB devices: none connected");
    }
  }

  // Cloud devices
  if (!requestedTransport || requestedTransport === "cloud") {
    if (isAuthenticated()) {
      sections.push("Cloud devices: use phone_list_devices with transport=cloud to query server");
      // For cloud, we proxy to server — but phone_list_devices itself needs cloud call
      if (requestedTransport === "cloud") {
        return cloudMcpCall("phone_list_devices", {}).catch((e) => err(e.message));
      }
    } else {
      sections.push("Cloud: not authenticated (use phone_authenticate)");
    }
  }

  return ok(sections.join("\n\n"));
}

function handleUnlock(deviceId) {
  if (deviceId) {
    releaseDeviceLock(deviceId);
    return ok(`Device ${deviceId} unlocked.`);
  }
  // Release all locks held by this process
  try {
    const files = fs.readdirSync(LOCK_DIR).filter((f) => f.startsWith("lock_"));
    for (const f of files) {
      const fp = path.join(LOCK_DIR, f);
      try {
        const data = JSON.parse(fs.readFileSync(fp, "utf-8"));
        if (data.pid === MY_PID) fs.unlinkSync(fp);
      } catch {}
    }
  } catch {}
  return ok("All device locks released.");
}

function handleStatus() {
  const devices = listAdbDevices();
  const authed = isAuthenticated();
  const info = [
    `ADB devices: ${devices.length > 0 ? devices.map((d) => `${d.serial} (${d.model || d.product})`).join(", ") : "none"}`,
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
  try { request = JSON.parse(line); } catch { return; }

  const { id, method, params } = request;

  switch (method) {
    case "initialize":
      send({
        jsonrpc: "2.0", id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "bob-control", version: "1.1.0" },
        },
      });
      break;

    case "notifications/initialized":
      log("BOB Control ready (stateless transport — specify transport/device_id per call or auto-detect)");
      break;

    case "tools/list":
      send({ jsonrpc: "2.0", id, result: { tools: ALL_TOOLS } });
      break;

    case "tools/call": {
      const toolName = params?.name;
      const toolArgs = params?.arguments || {};
      log(`${toolName} ${JSON.stringify(toolArgs)}`);
      trackRequest(
        Promise.resolve(executeTool(toolName, toolArgs)).then((result) => {
          // handleListDevices may return a promise for cloud
          return Promise.resolve(result);
        }).then((result) => {
          send({ jsonrpc: "2.0", id, result });
        })
      );
      break;
    }

    default:
      if (id !== undefined) {
        send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
      }
  }
});

rl.on("close", () => {
  stdinClosed = true;
  if (pendingRequests === 0) process.exit(0);
});

// Clean up locks on exit
function cleanupLocks() {
  try {
    const files = fs.readdirSync(LOCK_DIR).filter((f) => f.startsWith("lock_"));
    for (const f of files) {
      const fp = path.join(LOCK_DIR, f);
      try {
        const data = JSON.parse(fs.readFileSync(fp, "utf-8"));
        if (data.pid === MY_PID) fs.unlinkSync(fp);
      } catch {}
    }
  } catch {}
}
process.on("exit", cleanupLocks);
process.on("SIGINT", () => { cleanupLocks(); process.exit(0); });
process.on("SIGTERM", () => { cleanupLocks(); process.exit(0); });

log("BOB Control MCP plugin started");
