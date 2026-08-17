/**
 * logger.js — Rotating file logger for jp-pos-print-agent
 * ─────────────────────────────────────────────────────────────────────────────
 * Writes structured JSON log lines to a daily-rotating file under LOG_DIR
 * (default: ./logs).  Old log files beyond MAX_LOG_DAYS are deleted on startup.
 *
 * Each log line is a JSON object:
 *   { ts: ISO-timestamp, level: "INFO"|"WARN"|"ERROR", ...eventFields }
 *
 * Intentionally uses only Node.js core modules (fs, path, os) — no extra deps.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const LOG_DIR      = process.env.LOG_DIR     || path.join(__dirname, 'logs');
const MAX_LOG_DAYS = parseInt(process.env.MAX_LOG_DAYS || '14', 10);

// Ensure log directory exists at module load time
fs.mkdirSync(LOG_DIR, { recursive: true });

/** Returns the log file path for today (one file per calendar day). */
function _todayFile() {
  const d = new Date();
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return path.join(LOG_DIR, `print-agent-${stamp}.log`);
}

/** Append a single log line (JSON + newline) to today's file. */
function _write(level, fields) {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, ...fields }) + '\n';

  // Also mirror to stdout so PM2 `pm2 logs` shows live entries
  process.stdout.write(`[${level}] ${line}`);

  try {
    fs.appendFileSync(_todayFile(), line, 'utf8');
  } catch (e) {
    // If we can't write to the log file, don't crash the server — just warn
    process.stderr.write(`[logger] Could not write to log file: ${e.message}\n`);
  }
}

/** Delete log files older than MAX_LOG_DAYS (called once on startup). */
function _pruneOldLogs() {
  try {
    const cutoff = Date.now() - MAX_LOG_DAYS * 24 * 60 * 60 * 1000;
    fs.readdirSync(LOG_DIR)
      .filter((f) => f.startsWith('print-agent-') && f.endsWith('.log'))
      .forEach((f) => {
        const full = path.join(LOG_DIR, f);
        if (fs.statSync(full).mtimeMs < cutoff) {
          fs.unlinkSync(full);
        }
      });
  } catch {
    // Non-fatal
  }
}

/**
 * Creates and returns a logger instance.
 * Call once in server.js; pass the returned object around.
 *
 * @returns {{ info: Function, warn: Function, error: Function }}
 */
function createRotatingLogger() {
  _pruneOldLogs(); // prune once at startup
  return {
    info : (fields) => _write('INFO',  fields),
    warn : (fields) => _write('WARN',  fields),
    error: (fields) => _write('ERROR', fields),
  };
}

module.exports = { createRotatingLogger };
