/**
 * schemas.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Protocol validation schemas and helpers for API requests.
 */

'use strict';

/**
 * Validate a PrintJob creation payload.
 * @param {Object} body
 * @returns {{ valid: boolean, errors: string[], value?: Object }}
 */
function validateCreateJobSchema(body) {
  const errors = [];
  if (!body || typeof body !== 'object') {
    return { valid: false, errors: ['Request body must be a JSON object.'] };
  }

  const { printerId, format = 'tspl', payload, idempotencyKey } = body;

  if (!printerId || typeof printerId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(printerId.trim())) {
    errors.push('printerId is required and must contain alphanumeric characters, hyphens, or underscores only.');
  }

  if (!['tspl', 'escpos', 'raw'].includes(format)) {
    errors.push('format must be one of "tspl", "escpos", or "raw".');
  }

  if (!payload || (typeof payload !== 'string' && !Buffer.isBuffer(payload)) || String(payload).trim() === '') {
    errors.push('payload is required and must be a non-empty string or Buffer.');
  }

  if (idempotencyKey && (typeof idempotencyKey !== 'string' || idempotencyKey.length > 128)) {
    errors.push('idempotencyKey must be a string up to 128 characters.');
  }

  return {
    valid: errors.length === 0,
    errors,
    value: errors.length === 0 ? {
      printerId: printerId.trim(),
      format,
      payload,
      idempotencyKey: idempotencyKey ? idempotencyKey.trim() : undefined,
    } : undefined,
  };
}

/**
 * Validate a Printer registration payload.
 * @param {Object} body
 * @returns {{ valid: boolean, errors: string[], value?: Object }}
 */
function validateRegisterPrinterSchema(body) {
  const errors = [];
  if (!body || typeof body !== 'object') {
    return { valid: false, errors: ['Request body must be a JSON object.'] };
  }

  const { id, name, type = 'tspl', transport, printerName, devicePath, host, port } = body;

  if (!id || typeof id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(id.trim())) {
    errors.push('id is required and must contain alphanumeric characters, hyphens, or underscores only.');
  }

  if (!['tspl', 'escpos', 'raw'].includes(type)) {
    errors.push('type must be one of "tspl", "escpos", or "raw".');
  }

  if (!['win32', 'linux', 'network'].includes(transport)) {
    errors.push('transport must be one of "win32", "linux", or "network".');
  }

  if (transport === 'win32' && (!printerName || typeof printerName !== 'string')) {
    errors.push('printerName string is required for win32 transport.');
  }

  if (transport === 'linux' && (!devicePath || typeof devicePath !== 'string')) {
    errors.push('devicePath string is required for linux transport.');
  }

  if (transport === 'network' && (!host || typeof host !== 'string')) {
    errors.push('host IP string is required for network transport.');
  }

  return {
    valid: errors.length === 0,
    errors,
    value: errors.length === 0 ? {
      id: id.trim(),
      name: name ? String(name).trim() : id.trim(),
      type,
      transport,
      printerName: printerName ? String(printerName).trim() : undefined,
      devicePath: devicePath ? String(devicePath).trim() : undefined,
      host: host ? String(host).trim() : undefined,
      port: port ? parseInt(port, 10) : 9100,
    } : undefined,
  };
}

module.exports = {
  validateCreateJobSchema,
  validateRegisterPrinterSchema,
};
