# bob-control-mcp

MCP plugin for remote Android phone control — ADB (local) or cloud relay.

Screenshot, tap, swipe, type, read UI tree, manage apps and notifications — all from Claude Code.

## Install

```bash
npm install -g bob-control-mcp
claude mcp add -s user bob-control -- bob-control-mcp
```

Restart Claude Code after adding.

## Setup

### ADB mode (local, fast, no internet)

1. Install [BOB Control](https://play.google.com/store/apps/details?id=bob.tools.control) on your Android phone
2. Connect phone via USB, enable USB debugging
3. In BOB Control app: Step 6 → Start ADB Server
4. Plugin auto-detects the device on startup

### Cloud mode (remote, no USB needed)

1. Install BOB Control app, complete device pairing (Step 1)
2. In Claude Code, ask Claude to connect to your phone
3. Claude calls `phone_authenticate` → browser opens → log in on bob.tools
4. Tokens are saved automatically, auto-refresh enabled

### Switching modes

Plugin auto-detects: ADB if a device is connected via USB, otherwise cloud. To switch manually, ask Claude to use `phone_set_transport`.

## Tools

| Tool | Description |
|------|-------------|
| `phone_authenticate` | Log in for cloud mode (OAuth) |
| `phone_logout` | Clear stored cloud tokens |
| `phone_set_transport` | Switch between "adb" and "cloud" |
| `phone_status` | Show connection status |
| `phone_screenshot` | Take a screenshot (JPEG) |
| `phone_get_ui_tree` | Get accessibility tree (preferred for reading text) |
| `phone_tap` | Tap at coordinates |
| `phone_tap_text` | Tap element by visible text |
| `phone_swipe` | Swipe gesture |
| `phone_type` | Type text into focused field |
| `phone_press_back` | Press Back |
| `phone_press_home` | Press Home |
| `phone_press_recents` | Press Recent Apps |
| `phone_get_apps` | List installed apps |
| `phone_open_app` | Open app by package name |
| `phone_get_notifications` | Get active notifications |
| `phone_open_notification` | Open notification by key |
| `phone_dismiss_notification` | Dismiss notification |
| `phone_dismiss_all_notifications` | Dismiss all |
| `phone_list_devices` | List devices (cloud) |
| `phone_select_device` | Select device (cloud) |

## Publishing new version

```bash
cd /Users/ivbar/code/bob-control-mcp
npm version patch
git push && git push --tags
```

GitHub Action publishes to npm automatically on tag push.

## License

MIT
