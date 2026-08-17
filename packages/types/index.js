/**
 * @jp-pos/print-agent-types
 * Type definitions and contracts for the JP-POS Print Agent architecture.
 */

'use strict';

/**
 * @typedef {'tspl' | 'escpos' | 'raw'} PrinterFormat
 */

/**
 * @typedef {'online' | 'offline' | 'busy' | 'error'} PrinterState
 */

/**
 * @typedef {'queued' | 'processing' | 'completed' | 'failed' | 'cancelled' | 'retrying'} JobStatus
 */

/**
 * @typedef {Object} PrinterInfo
 * @property {string} id - Unique server-side identifier (alias)
 * @property {string} name - Human-readable printer label
 * @property {PrinterFormat} type - Supported format (tspl, escpos, raw)
 * @property {PrinterState} status - Current hardware status
 * @property {string} platform - OS platform (win32, linux, darwin, network)
 */

/**
 * @typedef {Object} PrinterStatus
 * @property {string} id - Printer ID
 * @property {PrinterState} state - State indicator
 * @property {string} [detail] - Additional error or status information
 */

/**
 * @typedef {Object} PrintJob
 * @property {string} id - Unique job UUID
 * @property {string} printerId - Target printer alias
 * @property {PrinterFormat} format - Payload format
 * @property {string | Buffer} payload - Print payload data
 * @property {string} [idempotencyKey] - Unique key to prevent duplicate prints
 * @property {JobStatus} status - Current queue status
 * @property {number} createdAt - Epoch timestamp (ms)
 * @property {number} [attempts] - Execution attempt count
 */

/**
 * @typedef {Object} PrintResult
 * @property {boolean} success - Operation success flag
 * @property {string} jobId - Associated Job ID
 * @property {number} byteLength - Bytes written to printer
 * @property {number} durationMs - Execution time in milliseconds
 */

module.exports = {};
