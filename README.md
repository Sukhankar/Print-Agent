# Universal Print Agent

A lightweight, self-hosted Node.js background service and package that runs on a local host PC or counter machine and prints raw printer commands (TSPL, ESC/POS, ZPL) directly to connected USB thermal barcode and receipt printers.

- **No OS print dialog** — raw bytes go directly to the printer driver queue (Windows WinSpool RAW) or device file (Linux `/dev/usb/lp*`).
- **No `window.print()`** anywhere.
- **No third-party cloud print subscriptions** — fully self-hosted, offline-capable, and private.
- **Universal compatibility** — easily integrates with any web frontend (React, Vue, Next.js, HTML/JS), desktop app (Electron), or central backend via standard REST APIs.
- **Distributed as a Node package** — can be embedded into Node.js applications or executed as a standalone CLI / background service daemon.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Prerequisites](#prerequisites)
3. [Installation & Setup](#installation--setup)
4. [Environment Variables](#environment-variables)
5. [Windows RAW Printer Setup](#windows-raw-printer-setup)
6. [Linux USB Device Permissions (udev)](#linux-usb-device-permissions-udev)
7. [Running the Agent](#running-the-agent)
8. [PM2 Process Management & Boot Persistence](#pm2-process-management--boot-persistence)
9. [API Reference](#api-reference)
10. [Verify the Agent is Working (curl / PowerShell)](#verify-the-agent-is-working-curl--powershell)
11. [Cloudflare Tunnel Integration (Remote Printing)](#cloudflare-tunnel-integration-remote-printing)
12. [Troubleshooting](#troubleshooting)
13. [Log Files](#log-files)

---

## Architecture Overview

```
Any Web App / POS Frontend / Central Server
        │
        │  POST /print  (HTTP REST API or via Secure Tunnel)
        ▼
┌───────────────────────────────────┐
│       Universal Print Agent       │   ← Local Node.js service / package
│  Express   :9200  127.0.0.1       │
└────────────────┬──────────────────┘
                 │ raw command bytes (TSPL / ESC-POS / ZPL)
        ┌────────▼────────┐
        │                 │
   [Windows]          [Linux]
   WinSpool RAW    /dev/usb/lp0
   (OpenPrinter    (direct device
    WritePrinter)   file write)
        │                 │
        ▼                 ▼
   USB Thermal Printer (TSC / Xprinter / Zebra / Epson)
```

**Security layers (in order):**

1. **Localhost binding** — server binds to `127.0.0.1` by default so it is only accessible locally unless remote access is explicitly configured.
2. **CORS control** — restricts browser-originated requests to configured `ALLOWED_ORIGIN` domains.
3. **Optional Secure Tunneling** — for remote printing across networks/subnets (e.g. Cloudflare Tunnel with service-token authentication).

---

## Prerequisites

| Requirement | Minimum version |
|---|---|
| Node.js | 18.0.0+ |
| npm | 9.0.0+ |
| PM2 (global) | 5.x (`npm i -g pm2`) |
| PowerShell | 5.1+ (Windows — pre-installed on Win 7+) |

---

## Installation & Setup

### As a Standalone Service / Project

```bash
# 1. Clone or navigate to the print-agent repository
cd print-agent

# 2. Install dependencies
npm install

# 3. Create a .env file to configure settings (optional)
cp .env.example .env
```

### As a Node Package

```bash
# Install as a dependency in your Node.js project
npm install print-agent
```

---

## Environment Variables

Create a `.env` file in the root directory (or export them into your shell environment):

```env
# TCP port the agent listens on (default: 9200)
PRINT_AGENT_PORT=9200

# Bind address — keep as 127.0.0.1 unless LAN access is specifically required
PRINT_AGENT_HOST=127.0.0.1

# Web app origin allowed to trigger prints from browser clients
ALLOWED_ORIGIN=http://localhost:3000

# Directory where rotating daily log files are written (default: ./logs)
LOG_DIR=./logs

# Number of days to retain log files before auto-deletion (default: 14)
MAX_LOG_DAYS=14
```

---

## Windows RAW Printer Setup

The Windows print path uses WinSpool's `WritePrinter` API with `DataType = "RAW"`, sending bytes directly to the printer spooler without GDI rasterisation or print dialogs.

**The printer must be configured as a RAW-capable queue:**

### Option A — "Generic / Text Only" driver (recommended for TSC/Xprinter/Zebra labels)

1. Open **Control Panel → Devices and Printers**.
2. Click **Add a printer** → **Add a local printer or network printer with manual settings**.
3. Select the correct USB port (e.g. `USB001`).
4. Choose driver: **Generic → Generic / Text Only**.
5. Give it a recognisable name (e.g. `Thermal-Label-Printer`).
6. Do not share the printer unless needed on local network.

### Option B — Manufacturer driver + RAW queue

If using a manufacturer driver (e.g., TSC Bartender or Seagull driver):

1. Open **Control Panel → Devices and Printers** → right-click your printer → **Printer properties**.
2. Go to the **Advanced** tab.
3. Ensure **Spool print documents** is selected and **Start printing immediately** is checked.
4. Click **Print Processor…** → set **Default data type** to `RAW`.
5. Click **OK** and restart the print spooler:
   ```powershell
   Restart-Service -Name Spooler
   ```

### Verify from command line

```powershell
# List installed printers — note the exact Name to use in API calls
Get-Printer | Select-Object Name, DriverName, PortName
```

---

## Linux USB Device Permissions (udev)

By default, `/dev/usb/lp0` (and similar) are owned by `root:lp` with permissions `660`. Running the print agent as a non-root user requires permission adjustments:

### Method 1 — Add service user to `lp` group (simplest)

```bash
sudo usermod -aG lp <your-service-user>
# Log out and back in, or restart PM2 daemon:
pm2 kill
pm2 resurrect
```

### Method 2 — udev rule (recommended for production)

Create `/etc/udev/rules.d/99-usb-printer.rules`:

```udev
# Allow all users in the 'lp' group to read/write USB printer devices
SUBSYSTEM=="usb", ATTRS{idVendor}=="0519", MODE="0664", GROUP="lp"
# Note: For TSC printers, idVendor is 0x0519. Check yours via: lsusb

# Generic rule for all USB printers:
SUBSYSTEM=="usbmisc", KERNEL=="lp*", MODE="0664", GROUP="lp"
```

Apply the rule without rebooting:

```bash
sudo udevadm control --reload-rules
sudo udevadm trigger
```

### Verify device accessibility

```bash
# Find the device
ls -la /dev/usb/

# Test raw write (should print or feed page to confirm permissions)
echo "TEST" > /dev/usb/lp0
```

---

## Running the Agent

### Development (direct node)

```bash
node server.js
# → [print-agent] Listening on http://127.0.0.1:9200 platform=win32
```

### Production (PM2)

```bash
pm2 start ecosystem.config.js
pm2 status   # confirm "print-agent" shows "online"
```

---

## PM2 Process Management & Boot Persistence

### First-time boot persistence setup

#### Linux

```bash
# Generate and execute startup script
pm2 startup systemd
# Run the command generated by pm2 startup with sudo

# Save process list for auto-restore on reboot
pm2 save
```

#### Windows

Using `pm2-windows-startup` or Windows Task Scheduler:

```powershell
# Install PM2 Windows startup helper
npm install -g pm2-windows-startup
pm2-startup install

# Save current process list
pm2 save
```

Alternatively, create a Task Scheduler entry:

```powershell
$action  = New-ScheduledTaskAction -Execute "npm" -Argument "exec pm2 resurrect" -WorkingDirectory "C:\path\to\print-agent"
$trigger = New-ScheduledTaskTrigger -AtStartup
Register-ScheduledTask -Action $action -Trigger $trigger -TaskName "Universal-PrintAgent" -RunLevel Highest -Force
```

### Essential PM2 commands

```bash
pm2 status              # view running services
pm2 logs print-agent    # view live output logs
pm2 restart print-agent # restart service
pm2 stop print-agent    # stop service
```

---

## API Reference

Base URL: `http://127.0.0.1:9200`

---

### `GET /health`

Verifies the print agent is running and accessible.

**Response `200 OK`:**
```json
{
  "status": "ok",
  "platform": "win32",
  "uptime": 3842
}
```

---

### `GET /printers`

Lists available printers on the system. Use this to determine `printerName` (Windows) or `devicePath` (Linux).

**Response `200 OK`:**
```json
{
  "success": true,
  "platform": "win32",
  "printers": ["TSC TTP-244 Pro", "Generic / Text Only", "Receipt Printer"]
}
```

On Linux:
```json
{
  "success": true,
  "platform": "linux",
  "printers": ["/dev/usb/lp0", "/dev/usb/lp1"]
}
```

---

### `POST /print`

Sends raw printer commands (TSPL / ESC-POS / ZPL) directly to the specified printer.

**Request body:**
```json
{
  "tsplCommands": "SIZE 50 mm, 25 mm\nGAP 2 mm, 0 mm\nDIRECTION 1\nCLS\nTEXT 10,10,\"3\",0,1,1,\"UNIVERSAL PRINT AGENT\"\nBARCODE 10,40,\"128\",50,1,0,2,2,\"890123456789\"\nTEXT 10,100,\"2\",0,1,1,\"PRICE: $9.99\"\nPRINT 1,1",
  "printerName": "TSC TTP-244 Pro",
  "devicePath": "/dev/usb/lp0"
}
```

> **Note:** `printerName` is used on Windows; `devicePath` is used on Linux. You can provide both — the agent selects the appropriate parameter for the host OS.

**Success response `200 OK`:**
```json
{
  "success": true,
  "byteLength": 182
}
```

**Error responses:**

| HTTP | `error` message example | Cause |
|---|---|---|
| `400` | `tsplCommands is required…` | Payload missing or empty |
| `400` | `printerName is required…` | Missing printer identifier |
| `403` | `Permission denied writing to /dev/usb/lp0…` | Linux permissions / udev issue |
| `422` | `Device not found: /dev/usb/lp0…` | Disconnected or powered off printer |
| `422` | `Printer "TSC" not found or not installed…` | Printer name mismatch on Windows |
| `503` | `Printer may be offline or busy…` | Hardware error, paper jam, or offline state |

---

## Verify the Agent is Working (curl / PowerShell)

### Health check

```bash
curl http://127.0.0.1:9200/health
```

### List printers

```bash
curl http://127.0.0.1:9200/printers
```

### Send test print job (Linux curl)

```bash
curl -X POST http://127.0.0.1:9200/print \
  -H "Content-Type: application/json" \
  -d '{
    "tsplCommands": "SIZE 50 mm, 25 mm\nGAP 2 mm, 0 mm\nDIRECTION 1\nCLS\nTEXT 10,10,\"3\",0,1,1,\"TEST LABEL\"\nPRINT 1,1",
    "devicePath": "/dev/usb/lp0"
  }'
```

### Send test print job (Windows PowerShell)

```powershell
$body = @{
  tsplCommands = "SIZE 50 mm, 25 mm`nGAP 2 mm, 0 mm`nDIRECTION 1`nCLS`nTEXT 10,10,`"3`",0,1,1,`"TEST LABEL`"`nPRINT 1,1"
  printerName  = "TSC TTP-244 Pro"
} | ConvertTo-Json

Invoke-RestMethod -Method POST -Uri "http://127.0.0.1:9200/print" `
  -ContentType "application/json" -Body $body
```

---

## Cloudflare Tunnel Integration (Remote Printing)

To securely receive print jobs from cloud-hosted services or remote web apps over HTTPS without public port forwarding:

1. **Install `cloudflared`** on the counter/host PC:
   - Windows: [Cloudflare Downloads](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)
   - Linux: `curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o /usr/local/bin/cloudflared && chmod +x /usr/local/bin/cloudflared`

2. **Authenticate and create a tunnel:**
   ```bash
   cloudflared tunnel login
   cloudflared tunnel create print-agent-tunnel
   ```

3. **Configure `~/.cloudflared/config.yml`:**
   ```yaml
   tunnel: <tunnel-id>
   credentials-file: /home/<user>/.cloudflared/<tunnel-id>.json

   ingress:
     - hostname: printer.yourdomain.com
       service: http://127.0.0.1:9200
     - service: http_status:404
   ```

4. **Start as a service:**
   ```bash
   cloudflared service install
   ```

---

## Troubleshooting

| Symptom | Likely Cause | Solution |
|---|---|---|
| `"Device not found: /dev/usb/lp0"` | USB cable unplugged or printer powered off | Verify cable connection, run `ls /dev/usb/` |
| `"Permission denied writing to /dev/usb/lp0"` | Service user missing `lp` group permissions | `sudo usermod -aG lp <user>` and restart service |
| `"OpenPrinter failed"` (Windows) | Printer name mismatch | Query `GET /printers` for exact name |
| `"StartDocPrinter returned 0"` | Windows Spooler service stopped | Run `Restart-Service Spooler` in PowerShell as Admin |
| `CORS error in browser console` | `ALLOWED_ORIGIN` mismatch | Update `ALLOWED_ORIGIN` in `.env` to match client web app URL |
| Label prints garbled output | Invalid command syntax or baud rate | Verify syntax against manufacturer specification (TSPL / ESC-POS / ZPL) |

---

## Log Files

Log files are saved to `./logs/` (configurable via `LOG_DIR`).

| File | Contents |
|---|---|
| `print-agent-YYYY-MM-DD.log` | Daily structured JSON application logs |
| `pm2-out.log` | PM2 stdout logs |
| `pm2-err.log` | PM2 stderr logs |

---

*Universal Print Agent — Standalone, cross-platform thermal printing service & Node package.*
