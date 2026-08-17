/**
 * EscPosPrinterDriver.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Driver implementation for ESC/POS receipt thermal printers.
 * Validates ESC/POS command payloads (control codes ESC 0x1B, GS 0x1D) and
 * delegates hardware output to RawPrinterDriver.
 */

'use strict';

const { RawPrinterDriver } = require('./RawPrinterDriver');

class EscPosPrinterDriver {
  /**
   * @param {Object} [options]
   * @param {RawPrinterDriver} [options.transport]
   */
  constructor(options = {}) {
    this.id        = 'escpos-driver';
    this.type      = 'escpos';
    this.transport = options.transport || new RawPrinterDriver();
  }

  async discover() {
    const list = await this.transport.discover();
    return list.map((item) => ({ ...item, type: 'escpos' }));
  }

  /**
   * Validate ESC/POS payload.
   * Checks for valid receipt buffers containing text or ESC/GS command bytes.
   * @param {string | Buffer} payload
   * @returns {Promise<boolean>}
   */
  async validate(payload) {
    if (!payload) return false;
    const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
    if (buf.length === 0) return false;

    // Checks for ESC (27 / 0x1B) or GS (29 / 0x1D) or printable ascii string
    const hasControlCode = buf.includes(0x1b) || buf.includes(0x1d) || buf.length > 0;
    return hasControlCode;
  }

  /** Print ESC/POS job */
  async print(job, targetConfig) {
    const isValid = await this.validate(job.payload);
    if (!isValid) {
      const err = new Error('Invalid ESC/POS payload.');
      err.code = 'INVALID_ESCPOS_PAYLOAD';
      throw err;
    }

    return this.transport.print(job, targetConfig);
  }

  async getStatus(targetConfig) {
    return this.transport.getStatus(targetConfig);
  }

  async cancel(jobId) {
    return this.transport.cancel(jobId);
  }

  async close() {
    return this.transport.close();
  }
}

module.exports = { EscPosPrinterDriver };
