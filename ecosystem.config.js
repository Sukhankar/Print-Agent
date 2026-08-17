/**
 * ecosystem.config.js — PM2 process definitions for jp-pos-print-agent
 *
 * Usage (run from the print-agent/ directory or the project root):
 *
 *   # Start (or restart) all defined processes
 *   pm2 start ecosystem.config.js
 *
 *   # First-time OS-boot persistence setup:
 *   pm2 startup          # follow the printed command (may need sudo on Linux)
 *   pm2 save             # persist the current process list
 *
 *   # Useful management commands
 *   pm2 status           # overview of all running processes
 *   pm2 logs print-agent # tail the print-agent logs
 *   pm2 restart print-agent
 *   pm2 stop    print-agent
 */

'use strict';

module.exports = {
  apps: [
    {
      // ── jp-pos-print-agent ──────────────────────────────────────────────
      name   : 'print-agent',
      script : './server.js',

      // Working directory is the print-agent folder itself so relative paths
      // (e.g. ./logs) resolve correctly regardless of where PM2 was invoked from.
      cwd    : __dirname,

      // Restart automatically if the process crashes
      autorestart  : true,
      restart_delay: 3000,    // wait 3 s before restarting (avoids rapid-restart loops)
      max_restarts : 15,       // give up after 15 consecutive restarts in a short window

      // Restart if RSS memory exceeds 512 MB (safety valve — this agent should be tiny)
      max_memory_restart: '512M',

      // Don't watch source files in production (avoids spurious restarts)
      watch: false,

      // ── Environment variables ─────────────────────────────────────────
      // Override any of these in a .env file in the print-agent directory
      // or by exporting them before running PM2.
      env: {
        NODE_ENV          : 'production',
        PRINT_AGENT_PORT  : '9200',
        PRINT_AGENT_HOST  : '127.0.0.1',   // bind only to loopback
        // ALLOWED_ORIGIN is the JP-POS web app origin that may call this agent
        // from a browser tab on the same machine.  Remote calls from the central
        // server arrive via Cloudflare Tunnel without an Origin header and are
        // always allowed (Cloudflare Access enforces auth at that layer).
        ALLOWED_ORIGIN    : 'http://localhost:3000',
        LOG_DIR           : './logs',
        MAX_LOG_DAYS      : '14',
      },

      // ── Log file configuration (PM2-level) ────────────────────────────
      // These are PM2's own stdout/stderr captures in addition to the
      // application-level rotating log written by logger.js.
      out_file   : './logs/pm2-out.log',
      error_file : './logs/pm2-err.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs : true,
    },
  ],
};
