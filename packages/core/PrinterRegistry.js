/**
 * PrinterRegistry.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Admin-controlled server-side printer registry.
 * Maps logical client printer IDs (aliases) to validated hardware targets.
 *
 * SECURITY REQUIREMENT:
 *   Untrusted callers must NEVER supply arbitrary device paths (/dev/usb/lp0)
 *   or printer queue names in request bodies. The registry acts as the exclusive
 *   allowlist authority.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');

class PrinterRegistry {
  /**
   * @param {Object} [options]
   * @param {string} [options.storagePath] - Path to persistent printers.json
   */
  constructor(options = {}) {
    this.storagePath = options.storagePath || path.join(process.cwd(), 'printers.json');
    /** @type {Map<string, Object>} */
    this.printers = new Map();
    this._loadFromDisk();
  }

  /**
   * Register a new printer alias in the registry.
   *
   * @param {Object} config
   * @param {string} config.id - Logical unique alias (e.g. "counter_label_1")
   * @param {string} config.name - Human-readable description
   * @param {'tspl'|'escpos'|'raw'} config.type - Printer command format
   * @param {'win32'|'linux'|'network'} config.transport - Hardware transport type
   * @param {string} [config.printerName] - Windows print queue name (required if transport=win32)
   * @param {string} [config.devicePath] - Linux device file path (required if transport=linux)
   * @param {string} [config.host] - Network printer IP address (required if transport=network)
   * @param {number} [config.port] - Network printer TCP port (default: 9100)
   * @returns {Object} Clean registered printer object
   */
  registerPrinter(config) {
    if (!config || !config.id || typeof config.id !== 'string') {
      throw this._err('Printer id is required and must be a string.', 'INVALID_REGISTRATION');
    }

    // Sanitize ID — alphanumeric, underscores, hyphens only
    const cleanId = config.id.trim();
    if (!/^[a-zA-Z0-9_-]+$/.test(cleanId)) {
      throw this._err(
        `Invalid printer id "${cleanId}". Only alphanumeric characters, hyphens, and underscores are allowed.`,
        'INVALID_PRINTER_ID'
      );
    }

    const type = config.type || 'tspl';
    if (!['tspl', 'escpos', 'raw'].includes(type)) {
      throw this._err(`Invalid printer format type "${type}".`, 'INVALID_FORMAT');
    }

    const transport = config.transport || (os.platform() === 'win32' ? 'win32' : 'linux');

    // Transport specific validation
    if (transport === 'win32') {
      if (!config.printerName || typeof config.printerName !== 'string') {
        throw this._err('printerName is required for win32 transport.', 'INVALID_TRANSPORT_CONFIG');
      }
    } else if (transport === 'linux') {
      if (!config.devicePath || typeof config.devicePath !== 'string') {
        throw this._err('devicePath is required for linux transport.', 'INVALID_TRANSPORT_CONFIG');
      }
      // Path traversal check: must start with /dev/usb/ or /dev/lp
      const normalized = path.normalize(config.devicePath);
      if (!normalized.startsWith('/dev/usb/lp') && !normalized.startsWith('/dev/lp')) {
        throw this._err(
          `Security violation: devicePath "${config.devicePath}" must be under /dev/usb/lp* or /dev/lp*.`,
          'SECURITY_VIOLATION'
        );
      }
    } else if (transport === 'network') {
      if (!config.host || typeof config.host !== 'string') {
        throw this._err('host IP is required for network transport.', 'INVALID_TRANSPORT_CONFIG');
      }
      // SSRF check: prevent localhost / loopback / link-local addresses
      if (/^(127\.|0\.|169\.254\.|::1)/.test(config.host)) {
        throw this._err(
          `Security violation: network host "${config.host}" cannot be a loopback or link-local address.`,
          'SECURITY_VIOLATION'
        );
      }
    } else {
      throw this._err(`Unsupported transport "${transport}".`, 'INVALID_TRANSPORT');
    }

    const record = {
      id: cleanId,
      name: config.name || cleanId,
      type,
      transport,
      printerName: config.printerName || null,
      devicePath: config.devicePath || null,
      host: config.host || null,
      port: config.port || 9100,
      createdAt: Date.now(),
    };

    this.printers.set(cleanId, record);
    this._saveToDisk();
    return record;
  }

  /**
   * Remove a printer alias from the registry.
   * @param {string} id
   * @returns {boolean}
   */
  unregisterPrinter(id) {
    const deleted = this.printers.delete(id);
    if (deleted) this._saveToDisk();
    return deleted;
  }

  /**
   * Get target hardware configuration for an authenticated printer ID.
   * @param {string} id
   * @returns {Object}
   */
  getPrinter(id) {
    if (!id || typeof id !== 'string') return null;
    return this.printers.get(id) || null;
  }

  /**
   * List all registered public printer aliases.
   * Internal hardware paths/queue names are stripped for security.
   * @returns {Array<Object>}
   */
  listPrinters() {
    return Array.from(this.printers.values()).map((p) => ({
      id: p.id,
      name: p.name,
      type: p.type,
      transport: p.transport,
    }));
  }

  /** Load persistent registry state from disk. */
  _loadFromDisk() {
    try {
      if (fs.existsSync(this.storagePath)) {
        const raw = fs.readFileSync(this.storagePath, 'utf8');
        const items = JSON.parse(raw);
        if (Array.isArray(items)) {
          for (const item of items) {
            if (item && item.id) this.printers.set(item.id, item);
          }
        }
      }
    } catch (_) {
      // Ignore disk load failures, fallback to empty registry
    }
  }

  /** Persist registry state to disk safely. */
  _saveToDisk() {
    try {
      const items = Array.from(this.printers.values());
      fs.writeFileSync(this.storagePath, JSON.stringify(items, null, 2), 'utf8');
    } catch (_) {
      // Non-fatal if storage write fails
    }
  }

  /** Helper error generator */
  _err(message, code) {
    const err = new Error(message);
    err.code = code;
    return err;
  }
}

module.exports = { PrinterRegistry };
