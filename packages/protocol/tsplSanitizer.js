/**
 * tsplSanitizer.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Strict TSPL command validator & sanitizer.
 * Mitigates hardware destruction and firmware modification attacks by validating
 * that incoming TSPL payloads contain only known-safe label layout commands.
 *
 * ALLOWED COMMANDS (Strict Mode):
 *   SIZE, GAP, OFFSET, SPEED, DENSITY, DIRECTION, REFERENCE, CLS, TEXT, BARCODE,
 *   QRCODE, BITMAP, BOX, BAR, REVERSE, CODEPAGE, SOUND, CUT, FEED, PRINT
 *
 * FORBIDDEN COMMANDS (Strict Mode):
 *   FLASH, DOWNLOAD, EOP, RUN, KILL, SET COUNTER, SET IP, SET WLAN, UPGRADE, DELDRV
 */

'use strict';

/** Standard allowed formatting and output commands in TSPL */
const ALLOWED_TSPL_COMMANDS = new Set([
  'SIZE',
  'GAP',
  'OFFSET',
  'SPEED',
  'DENSITY',
  'DIRECTION',
  'REFERENCE',
  'CLS',
  'TEXT',
  'BARCODE',
  'QRCODE',
  'BITMAP',
  'BOX',
  'BAR',
  'REVERSE',
  'CODEPAGE',
  'SOUND',
  'CUT',
  'FEED',
  'PRINT',
  'LIMITFEED',
  'HOME',
]);

/** Forbidden dangerous commands in strict mode */
const FORBIDDEN_TSPL_COMMANDS = new Set([
  'FLASH',
  'DOWNLOAD',
  'EOP',
  'RUN',
  'KILL',
  'SET',
  'WLAN',
  'NET',
  'UPGRADE',
  'DELDRV',
  'SYSTEM',
]);

/**
 * Validate a TSPL command string against the security policy.
 *
 * @param {string | Buffer} payload - Raw TSPL input string or buffer
 * @param {Object} [options]
 * @param {boolean} [options.strict=true] - If true, enforces strict command allowlist
 * @returns {{ valid: boolean, errors: string[], sanitizedPayload: string }}
 */
function validateTspl(payload, options = {}) {
  const isStrict = options.strict !== false;
  const errors = [];

  if (!payload) {
    return { valid: false, errors: ['Payload cannot be empty.'], sanitizedPayload: '' };
  }

  const rawStr = Buffer.isBuffer(payload) ? payload.toString('utf8') : String(payload);
  const lines  = rawStr.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith(';')) continue; // Ignore empty lines or TSPL comments

    // Extract leading command keyword
    const match = line.match(/^([a-zA-Z]+)/);
    if (!match) continue;

    const command = match[1].toUpperCase();

    if (isStrict) {
      if (FORBIDDEN_TSPL_COMMANDS.has(command)) {
        errors.push(`Line ${i + 1}: Forbidden TSPL command "${command}" is not allowed in strict mode.`);
      } else if (!ALLOWED_TSPL_COMMANDS.has(command)) {
        errors.push(`Line ${i + 1}: Unrecognized command "${command}". Not in TSPL strict allowlist.`);
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    sanitizedPayload: errors.length === 0 ? rawStr : '',
  };
}

module.exports = {
  validateTspl,
  ALLOWED_TSPL_COMMANDS,
  FORBIDDEN_TSPL_COMMANDS,
};
