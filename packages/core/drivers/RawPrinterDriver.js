/**
 * RawPrinterDriver.js
 * ─────────────────────────────────────────────────────────────────────────────
 * OS-branched low-level hardware driver supporting WinSpool RAW (Windows),
 * POSIX /dev/usb/lp* direct writes (Linux/macOS), and raw Network TCP sockets.
 */

'use strict';

const os                 = require('os');
const fs                 = require('fs');
const path               = require('path');
const net                = require('net');
const { exec, execFile } = require('child_process');

class RawPrinterDriver {
  constructor() {
    this.id   = 'raw-driver';
    this.type = 'raw';
  }

  /**
   * Discover installed local printers.
   * @returns {Promise<Array<{ id: string, name: string, type: string, platform: string }>>}
   */
  async discover() {
    const platform = os.platform();
    if (platform === 'win32') {
      return this._discoverWindows();
    }
    return this._discoverLinux();
  }

  /**
   * Validate raw payload.
   * @param {string | Buffer} payload
   * @returns {Promise<boolean>}
   */
  async validate(payload) {
    if (!payload) return false;
    if (typeof payload === 'string' && payload.trim().length === 0) return false;
    if (Buffer.isBuffer(payload) && payload.length === 0) return false;
    return true;
  }

  /**
   * Print job to resolved target configuration.
   * @param {Object} job - PrintJob object
   * @param {Object} targetConfig - Resolved target hardware config from PrinterRegistry
   * @returns {Promise<{ success: boolean, jobId: string, byteLength: number, durationMs: number }>}
   */
  async print(job, targetConfig) {
    const start = Date.now();

    if (!targetConfig) {
      throw this._err('Missing target hardware configuration.', 'MISSING_TARGET_CONFIG');
    }

    const payload = Buffer.isBuffer(job.payload)
      ? job.payload
      : Buffer.from(String(job.payload || ''), 'utf8');

    if (payload.length === 0) {
      throw this._err('Payload cannot be empty.', 'EMPTY_PAYLOAD');
    }

    let result;
    const transport = targetConfig.transport || (os.platform() === 'win32' ? 'win32' : 'linux');

    if (transport === 'win32') {
      result = await this._printWindows(payload, targetConfig.printerName);
    } else if (transport === 'linux') {
      result = await this._printLinux(payload, targetConfig.devicePath);
    } else if (transport === 'network') {
      result = await this._printNetwork(payload, targetConfig.host, targetConfig.port || 9100);
    } else {
      throw this._err(`Unsupported transport "${transport}".`, 'UNSUPPORTED_TRANSPORT');
    }

    const durationMs = Date.now() - start;
    return {
      success: true,
      jobId: job.id,
      byteLength: result.byteLength,
      durationMs,
    };
  }

  /**
   * Query status of registered printer target.
   * @param {Object} targetConfig
   * @returns {Promise<{ id: string, state: string, detail?: string }>}
   */
  async getStatus(targetConfig) {
    if (!targetConfig) {
      return { id: 'unknown', state: 'offline', detail: 'No target config provided.' };
    }

    const transport = targetConfig.transport;
    if (transport === 'linux' && targetConfig.devicePath) {
      const exists = fs.existsSync(targetConfig.devicePath);
      return {
        id: targetConfig.id || 'linux-printer',
        state: exists ? 'online' : 'offline',
        detail: exists ? 'Device node ready' : 'Device file missing',
      };
    }

    return {
      id: targetConfig.id || 'printer',
      state: 'online',
      detail: 'Printer operational',
    };
  }

  async cancel() {
    return true;
  }

  async close() {
    return true;
  }

  // ─── Private Transport Methods ──────────────────────────────────────────

  _printWindows(payload, printerName) {
    return new Promise((resolve, reject) => {
      if (!printerName) {
        return reject(this._err('printerName required for Windows transport.', 'MISSING_PRINTER_NAME'));
      }

      const b64Payload = payload.toString('base64');
      const safeName = printerName.replace(/'/g, "''");

      const tmpDir = os.tmpdir();
      const uniqueId = `${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
      const tmpPs1Path = path.join(tmpDir, `raw_print_${uniqueId}.ps1`);

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
$docInfo.pDocName    = 'Print Job'
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
        return reject(this._err(`Failed temp script creation: ${e.message}`, 'TEMP_FILE_ERROR'));
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
              return reject(this._err(`Printer "${printerName}" not found.`, 'PRINTER_NOT_FOUND'));
            }
            if (raw.includes('PRINTER_OFFLINE')) {
              return reject(this._err(`Printer "${printerName}" is offline.`, 'PRINTER_OFFLINE'));
            }
            return reject(this._err(`Windows print error: ${raw}`, 'WINDOWS_PRINT_ERROR'));
          }
          resolve({ byteLength: payload.length });
        }
      );
    });
  }

  _printLinux(payload, devicePath) {
    return new Promise((resolve, reject) => {
      if (!devicePath) {
        return reject(this._err('devicePath required for POSIX transport.', 'MISSING_DEVICE_PATH'));
      }

      if (!fs.existsSync(devicePath)) {
        return reject(this._err(`Device not found: ${devicePath}`, 'DEVICE_NOT_FOUND'));
      }

      fs.open(devicePath, 'w', (openErr, fd) => {
        if (openErr) {
          if (openErr.code === 'EACCES') {
            return reject(this._err(`Permission denied for device ${devicePath}`, 'EACCES'));
          }
          return reject(this._err(`Failed to open ${devicePath}: ${openErr.message}`, 'OPEN_ERROR'));
        }

        fs.write(fd, payload, (writeErr, written) => {
          fs.close(fd, () => {});
          if (writeErr) {
            return reject(this._err(`Write error on ${devicePath}: ${writeErr.message}`, 'WRITE_ERROR'));
          }
          resolve({ byteLength: written });
        });
      });
    });
  }

  _printNetwork(payload, host, port) {
    return new Promise((resolve, reject) => {
      const client = new net.Socket();
      client.setTimeout(10_000);

      client.connect(port, host, () => {
        client.write(payload, () => {
          client.end();
          resolve({ byteLength: payload.length });
        });
      });

      client.on('error', (err) => {
        client.destroy();
        reject(this._err(`Network print failure to ${host}:${port} — ${err.message}`, 'NETWORK_PRINT_ERROR'));
      });

      client.on('timeout', () => {
        client.destroy();
        reject(this._err(`Network connection timed out to ${host}:${port}`, 'NETWORK_TIMEOUT'));
      });
    });
  }

  _discoverWindows() {
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
          resolve(
            names.map((name) => ({
              id: `win_${name.toLowerCase().replace(/[^a-z0-9_-]/g, '_')}`,
              name,
              type: 'raw',
              status: 'online',
              platform: 'win32',
            }))
          );
        }
      );
    });
  }

  _discoverLinux() {
    return new Promise((resolve) => {
      const usbDir = '/dev/usb';
      if (!fs.existsSync(usbDir)) return resolve([]);
      try {
        const files = fs
          .readdirSync(usbDir)
          .filter((f) => f.startsWith('lp'))
          .map((f) => path.join(usbDir, f));
        resolve(
          files.map((devicePath, index) => ({
            id: `linux_usb_lp${index}`,
            name: `USB Printer ${devicePath}`,
            type: 'raw',
            status: 'online',
            platform: 'linux',
          }))
        );
      } catch (_) {
        resolve([]);
      }
    });
  }

  _err(message, code) {
    const err = new Error(message);
    err.code = code;
    return err;
  }
}

module.exports = { RawPrinterDriver };
