# JP-POS Print Agent

A lightweight, self-hosted Node.js background service that runs on a **store's counter PC** and prints raw TSPL commands to a locally-connected USB thermal barcode printer.

- **No OS print dialog** — raw bytes go directly to the printer driver queue (Windows) or device file (Linux).
- **No `window.print()`** anywhere.
- **No third-party cloud print services** — fully self-hosted.
- Reachable from a browser on the same PC (`http://localhost:9200`) or from the central JP-POS server via a **Cloudflare Tunnel**.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Prerequisites](#prerequisites)
3. [Installation](#installation)
4. [Environment Variables](#environment-variables)
5. [Windows RAW Printer Setup](#windows-raw-printer-setup)
6. [Linux USB Device Permissions (udev)](#linux-usb-device-permissions-udev)
7. [Running the Agent](#running-the-agent)
8. [PM2 Process Management & Boot Persistence](#pm2-process-management--boot-persistence)
9. [API Reference](#api-reference)
10. [Verify the Agent is Working (curl tests)](#verify-the-agent-is-working-curl-tests)
11. [Cloudflare Tunnel Integration](#cloudflare-tunnel-integration)
12. [Troubleshooting](#troubleshooting)
13. [Log Files](#log-files)

---

## Architecture Overview

```
Central JP-POS Server
        │
        │  POST /print  (via Cloudflare Tunnel + Access token)
        ▼
┌───────────────────────────────────┐
│      jp-pos-print-agent           │   ← This service (print-agent/)
│  Express   :9200  127.0.0.1       │
└────────────────┬──────────────────┘
                 │ raw TSPL bytes
        ┌────────▼────────┐
        │                 │
   [Windows]          [Linux]
   WinSpool RAW    /dev/usb/lp0
   (OpenPrinter    (direct device
    WritePrinter)   file write)
        │                 │
        ▼                 ▼
   USB Thermal Printer (TSC / Xprinter / Zebra)
```

**Security layers (in order):**

1. **Cloudflare Access** — service-token authentication on the Cloudflare Tunnel (outer layer, handles all remote auth). This agent does **not** implement its own auth and **must not** be the sole security layer.
2. **Localhost binding** — server binds to `127.0.0.1` by default; LAN access requires explicit tunnel configuration.
3. **CORS** — restricts browser-originated calls to `ALLOWED_ORIGIN` only.

---

## Prerequisites

| Requirement | Minimum version |
|---|---|
| Node.js | 18.0.0 |
| npm | 9.0.0 |
| PM2 (global) | 5.x (`npm i -g pm2`) |
| PowerShell | 5.1+ (Windows — pre-installed on Win 7+) |

---

## Installation

```bash
# 1. Navigate to the print-agent directory
cd print-agent

# 2. Install dependencies (only express + cors)
npm install

# 3. (Optional) Create a .env file to override defaults — see Environment Variables
cp .env.example .env   # if provided, else create manually
```

---

## Environment Variables

Create a `.env` file in the `print-agent/` directory (or export them to the shell before starting PM2):

```env
# TCP port the agent listens on (default: 9200)
PRINT_AGENT_PORT=9200

# Bind address — keep this as 127.0.0.1 unless you have a specific reason
# to expose the agent on the LAN (Cloudflare Tunnel handles remote exposure)
PRINT_AGENT_HOST=127.0.0.1

# The JP-POS web app origin allowed to call this agent from a browser
# on the same PC.  Remote calls from the central server (via Cloudflare Tunnel)
# do not send an Origin header and are always permitted.
ALLOWED_ORIGIN=http://localhost:3000

# Directory where rotating daily log files are written (default: ./logs)
LOG_DIR=./logs

# Number of days to retain log files before auto-deletion (default: 14)
MAX_LOG_DAYS=14
```

---

## Windows RAW Printer Setup

The Windows print path uses WinSpool's `WritePrinter` API with `DataType = "RAW"`, which sends bytes directly to the printer without any GDI rasterisation or dialog.

**The printer must be configured as a RAW-capable queue:**

### Option A — "Generic / Text Only" driver (recommended for most TSC/Xprinter labels)

1. Open **Control Panel → Devices and Printers**.
2. Click **Add a printer** → **Add a local printer or network printer with manual settings**.
3. Select the correct USB port (e.g. `USB001`).
4. Choose driver: **Generic → Generic / Text Only**.
5. Give it a recognisable name (e.g. `TSC-Label-Printer`).
6. **Do not share** the printer unless you need to.

### Option B — Manufacturer driver + RAW queue

If you've already installed the manufacturer's driver (e.g. TSC Bartender):

1. **Control Panel → Devices and Printers** → right-click your printer → **Printer properties**.
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

By default, `/dev/usb/lp0` (and similar) are owned by `root:lp` with permissions `660`.  Running the print agent as a non-root user requires one of:

### Method 1 — Add service user to `lp` group (simplest)

```bash
sudo usermod -aG lp <your-service-user>
# Log out and back in, or restart the PM2 daemon:
pm2 kill
pm2 resurrect
```

### Method 2 — udev rule (recommended for production)

Create `/etc/udev/rules.d/99-usb-printer.rules`:

```udev
# Allow all users in the 'lp' group to read/write USB printer devices
SUBSYSTEM=="usb", ATTRS{idVendor}=="0519", MODE="0664", GROUP="lp"
# For TSC printers, idVendor is 0x0519.  Find yours via: lsusb
# Generic rule for all USB printers:
SUBSYSTEM=="usbmisc", KERNEL=="lp*", MODE="0664", GROUP="lp"
```

Apply the new rule without rebooting:

```bash
sudo udevadm control --reload-rules
sudo udevadm trigger
```

### Verify the device is accessible

```bash
# Find the device
ls -la /dev/usb/

# Test raw write (should print garbage but confirms permissions work)
echo "TEST" > /dev/usb/lp0
```

---

## Running the Agent

### Development (direct node)

```bash
cd print-agent
node server.js
# → [jp-pos-print-agent] Listening on http://127.0.0.1:9200  platform=linux
```

### Production (PM2)

```bash
cd print-agent
pm2 start ecosystem.config.js
pm2 status   # confirm "print-agent" shows "online"
```

---

## PM2 Process Management & Boot Persistence

### First-time boot persistence setup

#### Linux

```bash
# Generate and execute the startup script (PM2 will print a command to run — do so)
pm2 startup systemd    # or 'pm2 startup' and follow printed instructions
# Example output: sudo env PATH=... pm2 startup systemd -u <user> --hp /home/<user>
# → Run the printed command with sudo

# Save the current process list so it's restored on reboot
pm2 save
```

#### Windows

PM2 uses the `pm2-windows-startup` module or the built-in Windows startup script:

```powershell
# Install PM2 Windows startup helper (one-time)
npm install -g pm2-windows-startup
pm2-startup install

# Save current process list
pm2 save
```

Alternatively, create a Scheduled Task that runs `pm2 resurrect` on login:

```powershell
# Create a Windows Task Scheduler entry (run as SYSTEM, trigger: At startup)
$action  = New-ScheduledTaskAction -Execute "npm" -Argument "exec pm2 resurrect" -WorkingDirectory "C:\path\to\print-agent"
$trigger = New-ScheduledTaskTrigger -AtStartup
Register-ScheduledTask -Action $action -Trigger $trigger -TaskName "JP-POS-PrintAgent" -RunLevel Highest -Force
```

### Everyday PM2 commands

```bash
pm2 status              # view all processes
pm2 logs print-agent    # tail live logs
pm2 restart print-agent
pm2 stop    print-agent
pm2 delete  print-agent  # remove from PM2 list
```

---

## API Reference

Base URL: `http://127.0.0.1:9200`

---

### `GET /health`

Used by the central JP-POS server to verify the print agent is alive before dispatching a job.

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

Lists available printer identifiers for the current OS.  Use this during setup to find the correct `printerName` (Windows) or `devicePath` (Linux) without digging through OS settings.

**Response `200 OK`:**
```json
{
  "success": true,
  "platform": "linux",
  "printers": ["/dev/usb/lp0", "/dev/usb/lp1"]
}
```

On Windows:
```json
{
  "success": true,
  "platform": "win32",
  "printers": ["TSC TTP-244 Pro", "Generic / Text Only", "Microsoft Print to PDF"]
}
```

---

### `POST /print`

Sends a raw TSPL command string to the printer.

**Request body:**
```json
{
  "tsplCommands": "SIZE 50 mm, 25 mm\nGAP 2 mm, 0 mm\nDIRECTION 1\nCLS\nTEXT 10,10,\"3\",0,1,1,\"Jain Plastic POS\"\nBARCODE 10,40,\"128\",50,1,0,2,2,\"890123456789\"\nTEXT 10,100,\"2\",0,1,1,\"MRP: RS. 499.00\"\nPRINT 1,1",
  "printerName": "TSC TTP-244 Pro",
  "devicePath": "/dev/usb/lp0"
}
```

> **Note:** `printerName` is used on Windows; `devicePath` is used on Linux.  You can send both fields — the agent picks the correct one for the current OS automatically.

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
| `400` | `tsplCommands is required…` | Missing/empty payload |
| `400` | `printerName is required…` | Missing printer identifier |
| `403` | `Permission denied writing to /dev/usb/lp0…` | Linux udev/group issue |
| `422` | `Device not found: /dev/usb/lp0…` | USB cable unplugged |
| `422` | `Printer "TSC" not found or not installed…` | Printer removed from Windows |
| `503` | `Printer may be offline or busy…` | Paper jam, power off, etc. |
| `500` | `Windows print error: …` | Unexpected WinSpool failure |

---

## Verify the Agent is Working (curl tests)

### Health check

```bash
curl http://127.0.0.1:9200/health
# → {"status":"ok","platform":"linux","uptime":12}
```

### List printers

```bash
curl http://127.0.0.1:9200/printers
# → {"success":true,"platform":"win32","printers":["TSC TTP-244 Pro"]}
```

### Send a test print job (Linux)

```bash
curl -X POST http://127.0.0.1:9200/print \
  -H "Content-Type: application/json" \
  -d '{
    "tsplCommands": "SIZE 50 mm, 25 mm\nGAP 2 mm, 0 mm\nDIRECTION 1\nCLS\nTEXT 10,10,\"3\",0,1,1,\"TEST LABEL\"\nPRINT 1,1",
    "devicePath": "/dev/usb/lp0"
  }'
# → {"success":true,"byteLength":96}
```

### Send a test print job (Windows — PowerShell)

```powershell
$body = @{
  tsplCommands = "SIZE 50 mm, 25 mm`nGAP 2 mm, 0 mm`nDIRECTION 1`nCLS`nTEXT 10,10,`"3`",0,1,1,`"TEST LABEL`"`nPRINT 1,1"
  printerName  = "TSC TTP-244 Pro"
} | ConvertTo-Json

Invoke-RestMethod -Method POST -Uri "http://127.0.0.1:9200/print" `
  -ContentType "application/json" -Body $body
# → success byteLength
#   ------- ----------
#   True    96
```

---

## Cloudflare Tunnel Integration

To allow the central JP-POS server to dispatch print jobs to a store's counter PC over the internet without opening firewall ports:

1. **Install `cloudflared`** on the counter PC:
   - Windows: [Download the MSI](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)
   - Linux: `curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o /usr/local/bin/cloudflared && chmod +x /usr/local/bin/cloudflared`

2. **Authenticate and create a tunnel:**
   ```bash
   cloudflared tunnel login
   cloudflared tunnel create jp-pos-store-01-printer
   ```

3. **Configure the tunnel** (`~/.cloudflared/config.yml`):
   ```yaml
   tunnel: <tunnel-id>
   credentials-file: /home/<user>/.cloudflared/<tunnel-id>.json

   ingress:
     - hostname: store01-printer.yourdomain.com
       service: http://127.0.0.1:9200
     - service: http_status:404
   ```

4. **Run `cloudflared` as a service** so it starts on boot:
   ```bash
   # Linux (systemd)
   cloudflared service install
   systemctl enable cloudflared
   systemctl start cloudflared

   # Windows
   cloudflared service install
   ```

5. **Protect the tunnel with Cloudflare Access** (Zero Trust dashboard):
   - Create a service token for the JP-POS central server.
   - Add an Access policy: only requests with a valid service token are allowed.
   - The print agent does **not** need to verify the token itself — Cloudflare handles it at the edge.

---

## Troubleshooting

| Symptom | Likely Cause | Fix |
|---|---|---|
| `"Device not found: /dev/usb/lp0"` | USB cable unplugged or printer off | Plug in printer, run `ls /dev/usb/` to confirm device appears |
| `"Permission denied writing to /dev/usb/lp0"` | User not in `lp` group | `sudo usermod -aG lp <user>` then restart PM2 daemon |
| `"OpenPrinter failed"` (Windows) | Printer name wrong or printer deleted | Run `GET /printers` to get the exact name |
| `"StartDocPrinter returned 0"` | Print spooler stopped | `Restart-Service -Name Spooler` in PowerShell as admin |
| `CORS error in browser console` | `ALLOWED_ORIGIN` mismatch | Set `ALLOWED_ORIGIN` to the exact origin shown in the browser |
| Agent not reachable from central server | Cloudflare Tunnel not running | `systemctl status cloudflared` or check Cloudflare dashboard |
| Labels print but content is garbled | TSPL command syntax issue | Validate with TSC label printing software first; confirm baud/encoding |

---

## Log Files

Log files are written to `./logs/` (configurable via `LOG_DIR`).

| File | Contents |
|---|---|
| `print-agent-YYYY-MM-DD.log` | Application-level structured JSON log (one per day) |
| `pm2-out.log` | PM2 stdout capture |
| `pm2-err.log` | PM2 stderr capture |

### Sample log line

```json
{"ts":"2026-07-27T05:18:32.411Z","level":"INFO","event":"print_success","target":"/dev/usb/lp0","byteLength":182,"durationMs":14}
{"ts":"2026-07-27T05:18:45.001Z","level":"ERROR","event":"print_failed","target":"/dev/usb/lp0","code":"DEVICE_NOT_FOUND","error":"Device not found: /dev/usb/lp0. Is the USB printer plugged in?","durationMs":2}
```

Log files older than `MAX_LOG_DAYS` (default 14 days) are automatically deleted on agent startup.

---

*Part of the JP-POS multi-location POS/ERP platform.*
