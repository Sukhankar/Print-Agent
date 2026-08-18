/**
 * TsplPrinterDriver.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Driver implementation for TSPL (TSC Printer Language) thermal printers.
 * Validates TSPL command streams and delegates transport to RawPrinterDriver.
 */

'use strict';

const { RawPrinterDriver } = require('./RawPrinterDriver');

class TsplPrinterDriver {
  /**
   * @param {Object} [options]
   * @param {RawPrinterDriver} [options.transport]
   */
  constructor(options = {}) {
    this.id        = 'tspl-driver';
    this.type      = 'tspl';
    this.transport = options.transport || new RawPrinterDriver();
  }

  /** Discover hardware targets via transport */
  async discover() {
    const list = await this.transport.discover();
    return list.map((item) => ({ ...item, type: 'tspl' }));
  }

  /**
   * Basic TSPL syntax validation.
   * Checks for essential TSPL keywords (e.g. SIZE, GAP, CLS, PRINT, TEXT, BARCODE).
   * @param {string | Buffer} payload
   * @returns {Promise<boolean>}
   */
  async validate(payload) {
    if (!payload) return false;
    const str = Buffer.isBuffer(payload) ? payload.toString('utf8') : String(payload);
    if (!str.trim()) return false;

    // Checks if string contains at least one standard TSPL command
    const tsplKeywordRegex = /\b(SIZE|GAP|CLS|PRINT|TEXT|BARCODE|QRCODE|BITMAP|DIRECTION|BOX)\b/i;
    return tsplKeywordRegex.test(str);
  }

  /**
   * Print TSPL job.
   * @param {Object} job - PrintJob object
   * @param {Object} targetConfig - Target hardware configuration
   */
  async print(job, targetConfig) {
    const isValid = await this.validate(job.payload);
    if (!isValid) {
      const err = new Error('Invalid TSPL payload. Must contain valid TSPL print commands.');
      err.code = 'INVALID_TSPL_PAYLOAD';
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

module.exports = { TsplPrinterDriver };
