/**
 * tsplUsbClient.js
 * ─────────────────────────────────────────────────────────────────────────────
 * OS-branched, raw TSPL command writer for the JP-POS print agent.
 *
 * SECURITY NOTE:
 *   This module runs on a store's local counter PC.  In production it sits
 *   behind a Cloudflare Tunnel with Cloudflare Access (service-token auth) as
 *   the outer security layer.  Do NOT expose the parent HTTP server directly
 *   to the public internet — this module does not implement authentication and
 *   should never be assumed to be the only security layer.
 *
 * LINUX PERMISSION NOTE:
 *   Writing to /dev/usb/lpX requires one of:
 *     a) Running the process as root (NOT recommended for production).
 *     b) Adding the service user to the 'lp' group:
 *          sudo usermod -aG lp <service-user>
 *          (Then log out / restart the PM2 daemon for it to take effect.)
 *     c) A udev rule — see README.md for the recommended one-liner.
 *   Without one of the above, writes will fail with EACCES.
 *
 * WINDOWS NOTE:
 *   The Windows branch shells out to a PowerShell inline script that uses
 *   WinSpool's OpenPrinter / WritePrinter API with "RAW" DataType — this
 *   bypasses the GDI/driver rendering pipeline entirely (no rasterisation,
 *   no dialog box).  The printer must be installed as "Generic / Text Only"
 *   or any RAW-capable queue.  See README.md → "Windows RAW Printer Setup".
 *
 *   Strategy: PowerShell shell-out is preferred over a native .node addon
 *   because it avoids recompilation on every Node version bump and PowerShell
 *   is guaranteed present on all Windows 7+ machines in production fleets.
 */

'use strict';

const os         = require('os');
const fs         = require('fs');
const path       = require('path');
const { exec, execFile } = require('child_process');

// ─── Platform detection ─────────────────────────────────────────────────────
const PLATFORM = os.platform(); // 'linux' | 'win32' | 'darwin' …

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Write raw TSPL command bytes to the printer.
 *
 * @param {string}  tsplCommands          - Raw TSPL string (e.g. "SIZE …\nPRINT 1,1")
 * @param {object}  options
 * @param {string}  [options.devicePath]  - Linux device file, e.g. "/dev/usb/lp0"
 * @param {string}  [options.printerName] - Windows printer name (exact, from Control Panel)
 * @returns {Promise<{ byteLength: number }>}
 * @throws {Error}  with a .code property describing the failure category
 */
async function printTspl(tsplCommands, { devicePath, printerName } = {}) {
  // ── Payload validation ─────────────────────────────────────────────────
  if (!tsplCommands || typeof tsplCommands !== 'string' || tsplCommands.trim() === '') {
    throw _err('tsplCommands must be a non-empty string.', 'INVALID_PAYLOAD');
  }

  const payload = Buffer.from(tsplCommands, 'utf8');

  if (PLATFORM === 'win32') {
    return _printWindows(payload, printerName);
  }
  // Linux / macOS / other POSIX — write raw bytes directly to device file
  return _printLinux(payload, devicePath);
}

/**
 * Returns a list of available printer identifiers for the current OS.
 *  - Windows : array of printer names (from PowerShell Get-Printer)
 *  - Linux   : array of /dev/usb/lp* device paths that exist on the system
 *
 * @returns {Promise<string[]>}
 */
async function listPrinters() {
  if (PLATFORM === 'win32') return _listWindowsPrinters();
  return _listLinuxDevices();
}

// ─── Linux branch ───────────────────────────────────────────────────────────

function _printLinux(payload, devicePath) {
  return new Promise((resolve, reject) => {
    if (!devicePath) {
      return reject(_err('devicePath is required on Linux (e.g. "/dev/usb/lp0").', 'MISSING_DEVICE_PATH'));
    }

    // Quick existence check before even trying to open
    if (!fs.existsSync(devicePath)) {
      return reject(_err(
        `Device not found: ${devicePath}. Is the USB printer plugged in?`,
        'DEVICE_NOT_FOUND'
      ));
    }

    // Open for writing (non-blocking so we don't hang if printer is offline)
    fs.open(devicePath, 'w', (openErr, fd) => {
      if (openErr) {
        if (openErr.code === 'EACCES') {
          return reject(_err(
            `Permission denied writing to ${devicePath}. ` +
            'Add the service user to the "lp" group or create a udev rule — see README.md.',
            'EACCES'
          ));
        }
        if (openErr.code === 'ENOENT') {
          return reject(_err(`Device path does not exist: ${devicePath}`, 'DEVICE_NOT_FOUND'));
        }
        return reject(_err(`Failed to open ${devicePath}: ${openErr.message}`, openErr.code || 'OPEN_ERROR'));
      }

      fs.write(fd, payload, (writeErr, written) => {
        // Always attempt to close; ignore close errors
        fs.close(fd, () => {});

        if (writeErr) {
          if (writeErr.code === 'EIO' || writeErr.code === 'ENOSPC') {
            return reject(_err(
              `Write failed — printer may be offline or paper jam: ${writeErr.message}`,
              'PRINTER_OFFLINE'
            ));
          }
          return reject(_err(`Write to ${devicePath} failed: ${writeErr.message}`, writeErr.code || 'WRITE_ERROR'));
        }

        resolve({ byteLength: written });
      });
    });
  });
}

function _listLinuxDevices() {
  return new Promise((resolve) => {
    const usbDir = '/dev/usb';
    if (!fs.existsSync(usbDir)) return resolve([]);
    try {
      const files = fs
        .readdirSync(usbDir)
        .filter((f) => f.startsWith('lp'))
        .map((f) => path.join(usbDir, f));
      resolve(files);
    } catch {
      resolve([]);
    }
  });
}

// ─── Windows branch ─────────────────────────────────────────────────────────

function _printWindows(payload, printerName) {
  return new Promise((resolve, reject) => {
    if (!printerName) {
      return reject(_err('printerName is required on Windows.', 'MISSING_PRINTER_NAME'));
    }

    const byteLength  = payload.length;
    // Base64-encode payload for safe shell transport
    const b64Payload  = payload.toString('base64');

    // Escape the printer name for safe embedding inside the PS string literal
    const safeName = printerName.replace(/'/g, "''");

    const tmpDir = os.tmpdir();
    const uniqueId = `${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const tmpPs1Path = path.join(tmpDir, `jp_print_${uniqueId}.ps1`);

    const psScript = `
$ErrorActionPreference = 'Stop'
try {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class WinSpool {
    [DllImport("winspool.drv", SetLastError=true, CharSet=CharSet.Ansi)]
    public static extern bool OpenPrinter(string pPrinterName, ref IntPtr phPrinter, IntPtr pDefault);
    [DllImport("winspool.drv", SetLastError=true)]
    public static extern bool ClosePrinter(IntPtr hPrinter);
    [DllImport("winspool.drv", SetLastError=true, CharSet=CharSet.Ansi)]
    public static extern int StartDocPrinter(IntPtr hPrinter, int Level, ref DOCINFO pDocInfo);
    [DllImport("winspool.drv", SetLastError=true)]
    public static extern bool EndDocPrinter(IntPtr hPrinter);
    [DllImport("winspool.drv", SetLastError=true)]
    public static extern bool StartPagePrinter(IntPtr hPrinter);
    [DllImport("winspool.drv", SetLastError=true)]
    public static extern bool EndPagePrinter(IntPtr hPrinter);
    [DllImport("winspool.drv", SetLastError=true)]
    public static extern bool WritePrinter(IntPtr hPrinter, IntPtr pBytes, int dwCount, ref int dwWritten);
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Ansi)]
    public struct DOCINFO {
        [MarshalAs(UnmanagedType.LPStr)] public string pDocName;
        [MarshalAs(UnmanagedType.LPStr)] public string pOutputFile;
        [MarshalAs(UnmanagedType.LPStr)] public string pDataType;
    }
}
'@ -IgnoreWarnings 2>$null
} catch {}

$printerName = '${safeName}'
$data = [Convert]::FromBase64String('${b64Payload}')

$hPrinter = [IntPtr]::Zero
if (-not [WinSpool]::OpenPrinter($printerName, [ref]$hPrinter, [IntPtr]::Zero)) {
  $err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
  Write-Error "PRINTER_NOT_FOUND: OpenPrinter failed for '$printerName' (Win32 error $err)"
  exit 1
}

$docInfo       = New-Object WinSpool+DOCINFO
$docInfo.pDocName    = 'Universal Print Job'
$docInfo.pOutputFile = $null
$docInfo.pDataType   = 'RAW'

$jobId = [WinSpool]::StartDocPrinter($hPrinter, 1, [ref]$docInfo)
if ($jobId -le 0) {
  [WinSpool]::ClosePrinter($hPrinter) | Out-Null
  Write-Error "PRINTER_OFFLINE: StartDocPrinter returned $jobId"
  exit 1
}

[WinSpool]::StartPagePrinter($hPrinter) | Out-Null

$ptr     = [System.Runtime.InteropServices.Marshal]::AllocHGlobal($data.Length)
$written = 0
[System.Runtime.InteropServices.Marshal]::Copy($data, 0, $ptr, $data.Length)
$ok = [WinSpool]::WritePrinter($hPrinter, $ptr, $data.Length, [ref]$written)
[System.Runtime.InteropServices.Marshal]::FreeHGlobal($ptr)

[WinSpool]::EndPagePrinter($hPrinter) | Out-Null
[WinSpool]::EndDocPrinter($hPrinter)  | Out-Null
[WinSpool]::ClosePrinter($hPrinter)   | Out-Null

if (-not $ok) {
  $err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
  Write-Error "WINDOWS_PRINT_ERROR: WritePrinter failed (Win32 error $err)"
  exit 1
}
exit 0
`.trim();

    try {
      fs.writeFileSync(tmpPs1Path, psScript, 'utf8');
    } catch (e) {
      return reject(_err(`Failed to write temp script: ${e.message}`, 'TEMP_FILE_ERROR'));
    }

    const cleanup = () => {
      try {
        if (fs.existsSync(tmpPs1Path)) fs.unlinkSync(tmpPs1Path);
      } catch (_) {}
    };

    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', tmpPs1Path],
      { timeout: 15_000 },
      (err, _stdout, stderr) => {
        cleanup();
        if (err) {
          const raw = (stderr || err.message || '').trim();
          if (raw.includes('PRINTER_NOT_FOUND')) {
            return reject(_err(
              `Printer "${printerName}" not found or not installed. ${raw}`,
              'PRINTER_NOT_FOUND'
            ));
          }
          if (raw.includes('PRINTER_OFFLINE')) {
            return reject(_err(
              `Printer "${printerName}" is offline or busy. ${raw}`,
              'PRINTER_OFFLINE'
            ));
          }
          return reject(_err(`Windows print error: ${raw}`, 'WINDOWS_PRINT_ERROR'));
        }

        resolve({ byteLength });
      }
    );
  });
}

function _listWindowsPrinters() {
  return new Promise((resolve) => {
    exec(
      'powershell.exe -NoProfile -NonInteractive -Command "Get-Printer | Select-Object -ExpandProperty Name"',
      { timeout: 8_000 },
      (err, stdout) => {
        if (err) return resolve([]);
        const names = stdout
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean);
        resolve(names);
      }
    );
  });
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Construct an Error with a machine-readable .code property. */
function _err(message, code) {
  return Object.assign(new Error(message), { code });
}

// ─── Exports ─────────────────────────────────────────────────────────────── 
module.exports = { printTspl, listPrinters, PLATFORM };
