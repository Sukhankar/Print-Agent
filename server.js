/**
 * server.js — JP-POS Print Agent
 * ─────────────────────────────────────────────────────────────────────────────
 * Lightweight Express HTTP server that accepts raw TSPL command strings and
 * writes them directly to a USB thermal printer — no OS print dialog,
 * no window.print(), no GDI/driver rendering.
 *
 * SECURITY MODEL (read before exposing via Cloudflare Tunnel):
 *   This server binds to 127.0.0.1 by default so it is NOT reachable from
 *   the LAN without an explicit tunnel.  In production, a Cloudflare Tunnel
 *   + Cloudflare Access service-token (Zero Trust) sits in front of this agent
 *   and handles authentication.  This app does NOT implement auth itself and
 *   MUST NOT be assumed to be the only security layer.
 *
 *   CORS is enforced as a defence-in-depth measure for browser-originated
 *   calls from the same PC.  The Cloudflare Access layer protects remote calls.
 *
 * ENVIRONMENT VARIABLES (all optional, have sane defaults):
 *   PRINT_AGENT_PORT   - TCP port to listen on           (default: 9200)
 *   PRINT_AGENT_HOST   - Bind address                    (default: 127.0.0.1)
 *   ALLOWED_ORIGIN     - CORS allowed origin             (default: http://localhost:3000)
 *   LOG_DIR            - Directory for rotating log files (default: ./logs)
 */

'use strict';

const express    = require('express');
const cors       = require('cors');
const os         = require('os');
const fs         = require('fs');
const path       = require('path');

const { printTspl, listPrinters, PLATFORM } = require('./tsplUsbClient');
const { createRotatingLogger }              = require('./logger');

// ─── Configuration ──────────────────────────────────────────────────────────
const PORT           = parseInt(process.env.PRINT_AGENT_PORT  || '9200', 10);
const HOST           = process.env.PRINT_AGENT_HOST            || '127.0.0.1';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN              || 'http://localhost:3000';

const log = createRotatingLogger();

// ─── Express setup ──────────────────────────────────────────────────────────
const app = express();

// Parse JSON bodies (reasonable size cap — TSPL payloads are never huge)
app.use(express.json({ limit: '256kb' }));

// ── CORS ─────────────────────────────────────────────────────────────────
// Allow only the configured JP-POS origin.  Cloudflare Tunnel requests from
// the central server use service-tokens and typically don't send an Origin
// header, so we allow requests with no Origin (non-browser fetch).
app.use(
  cors({
    origin: (origin, callback) => {
      // No Origin header = non-browser client (curl, server-side fetch) — allow
      if (!origin) return callback(null, true);
      if (origin === ALLOWED_ORIGIN) return callback(null, true);
      callback(new Error(`CORS: origin "${origin}" is not allowed.`));
    },
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);

// Handle CORS pre-flight rejections uniformly
app.use((err, _req, res, next) => {
  if (err.message && err.message.startsWith('CORS:')) {
    return res.status(403).json({ success: false, error: err.message });
  }
  next(err);
});

// ─── Routes ─────────────────────────────────────────────────────────────────

// ── GET /health ─────────────────────────────────────────────────────────────
/**
 * Used by the central JP-POS server to verify the print agent is alive before
 * dispatching a job to this store's counter PC.
 */
app.get('/health', (_req, res) => {
  res.json({
    status  : 'ok',
    platform: PLATFORM,
    uptime  : Math.floor(process.uptime()),
  });
});

// ── GET /printers ────────────────────────────────────────────────────────────
/**
 * Convenience endpoint for store IT staff during initial setup:
 *   - Windows : returns installed printer names
 *   - Linux   : returns /dev/usb/lp* device paths present on the system
 * Helps staff identify the correct devicePath / printerName without digging
 * through OS settings.
 */
app.get('/printers', async (_req, res) => {
  try {
    const printers = await listPrinters();
    res.json({ success: true, platform: PLATFORM, printers });
  } catch (err) {
    log.error({ event: 'list_printers_error', error: err.message });
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /print ──────────────────────────────────────────────────────────────
/**
 * Main print endpoint.
 *
 * Request body (JSON):
 *   {
 *     tsplCommands : string,   // Required — raw TSPL command block
 *     devicePath   : string,   // Required on Linux  (e.g. "/dev/usb/lp0")
 *     printerName  : string,   // Required on Windows (e.g. "TSC TTP-244")
 *   }
 *
 * Response:
 *   200  { success: true,  byteLength: number }
 *   400  { success: false, error: string }   — validation / payload issues
 *   422  { success: false, error: string }   — device/printer not found
 *   503  { success: false, error: string }   — printer offline / busy
 *   500  { success: false, error: string }   — unexpected errors
 */
app.post('/print', async (req, res) => {
  const start       = Date.now();
  const { tsplCommands, devicePath, printerName } = req.body || {};
  const target      = devicePath || printerName || '(none)';

  // ── Input validation ──────────────────────────────────────────────────
  if (!tsplCommands || typeof tsplCommands !== 'string' || tsplCommands.trim() === '') {
    log.warn({ event: 'print_rejected', reason: 'missing_tspl', target });
    return res.status(400).json({
      success: false,
      error  : 'tsplCommands is required and must be a non-empty string.',
    });
  }

  // Warn if no device identifier was provided at all
  if (PLATFORM === 'win32' && !printerName) {
    log.warn({ event: 'print_rejected', reason: 'missing_printer_name', target });
    return res.status(400).json({
      success: false,
      error  : 'printerName is required in the request body on Windows.',
    });
  }
  if (PLATFORM !== 'win32' && !devicePath) {
    log.warn({ event: 'print_rejected', reason: 'missing_device_path', target });
    return res.status(400).json({
      success: false,
      error  : 'devicePath is required in the request body on Linux/macOS.',
    });
  }

  // ── Send to printer ───────────────────────────────────────────────────
  try {
    const { byteLength } = await printTspl(tsplCommands, { devicePath, printerName });
    const ms = Date.now() - start;

    log.info({
      event    : 'print_success',
      target,
      byteLength,
      durationMs: ms,
    });

    return res.json({ success: true, byteLength });

  } catch (err) {
    const ms = Date.now() - start;

    log.error({
      event    : 'print_failed',
      target,
      code     : err.code,
      error    : err.message,
      durationMs: ms,
    });

    // ── Map error codes to meaningful HTTP statuses ──────────────────
    const statusMap = {
      INVALID_PAYLOAD    : 400,
      MISSING_DEVICE_PATH: 400,
      MISSING_PRINTER_NAME: 400,
      DEVICE_NOT_FOUND   : 422,
      PRINTER_NOT_FOUND  : 422,
      EACCES             : 403,
      PRINTER_OFFLINE    : 503,
      WINDOWS_PRINT_ERROR: 500,
    };
    const httpStatus = statusMap[err.code] || 500;

    return res.status(httpStatus).json({ success: false, error: err.message });
  }
});

// ─── Global error handler ───────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  log.error({ event: 'unhandled_error', error: err.message });
  res.status(500).json({ success: false, error: 'Internal server error.' });
});

// ─── Startup ────────────────────────────────────────────────────────────────
app.listen(PORT, HOST, () => {
  log.info({
    event   : 'server_started',
    host    : HOST,
    port    : PORT,
    platform: PLATFORM,
    allowedOrigin: ALLOWED_ORIGIN,
  });
  console.log(`[jp-pos-print-agent] Listening on http://${HOST}:${PORT}  platform=${PLATFORM}`);
});

// ─── Graceful shutdown ───────────────────────────────────────────────────────
// PM2 sends SIGINT on restart/stop — flush log buffers before exiting.
process.on('SIGINT',  () => { log.info({ event: 'shutdown', signal: 'SIGINT'  }); process.exit(0); });
process.on('SIGTERM', () => { log.info({ event: 'shutdown', signal: 'SIGTERM' }); process.exit(0); });
