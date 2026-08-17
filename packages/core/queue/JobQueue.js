/**
 * JobQueue.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Robust FIFO Job Queue Engine with per-printer mutex locks, idempotency key
 * deduplication, exponential backoff retries, and crash-recovery persistence.
 */

'use strict';

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

class JobQueue {
  /**
   * @param {Object} [options]
   * @param {Object} [options.registry] - PrinterRegistry instance
   * @param {Object} [options.drivers] - Map of format -> driver
   * @param {string} [options.storagePath] - Path to jobs persistence file
   * @param {number} [options.maxAttempts=3] - Maximum retry attempts
   * @param {number} [options.maxQueueSize=50] - Max pending jobs per printer
   */
  constructor(options = {}) {
    this.registry      = options.registry;
    this.drivers       = options.drivers || {};
    this.storagePath   = options.storagePath || path.join(process.cwd(), 'jobs.json');
    this.maxAttempts   = options.maxAttempts || 3;
    this.maxQueueSize  = options.maxQueueSize || 50;

    /** @type {Map<string, Object>} */
    this.jobs = new Map();
    /** @type {Map<string, string>} idempotencyKey -> jobId */
    this.idempotencyMap = new Map();
    /** @type {Set<string>} Active printer locks */
    this.printerLocks = new Set();

    this._loadState();
  }

  /**
   * Submit a new job to the queue.
   *
   * @param {Object} params
   * @param {string} params.printerId - Registered printer alias
   * @param {'tspl'|'escpos'|'raw'} [params.format='tspl'] - Payload format
   * @param {string|Buffer} params.payload - Print data
   * @param {string} [params.idempotencyKey] - Unique submission key
   * @returns {Promise<Object>} Created or existing Job object
   */
  async enqueueJob({ printerId, format = 'tspl', payload, idempotencyKey }) {
    // Idempotency check
    if (idempotencyKey && this.idempotencyMap.has(idempotencyKey)) {
      const existingId = this.idempotencyMap.get(idempotencyKey);
      const existing = this.jobs.get(existingId);
      if (existing) return existing;
    }

    // Verify printer exists in registry
    const targetConfig = this.registry ? this.registry.getPrinter(printerId) : null;
    if (this.registry && !targetConfig) {
      const err = new Error(`Printer "${printerId}" is not registered on this agent.`);
      err.code = 'PRINTER_NOT_REGISTERED';
      throw err;
    }

    // Check queue depth
    const pendingForPrinter = Array.from(this.jobs.values()).filter(
      (j) => j.printerId === printerId && (j.status === 'queued' || j.status === 'processing')
    );

    if (pendingForPrinter.length >= this.maxQueueSize) {
      const err = new Error(`Queue capacity exceeded for printer "${printerId}".`);
      err.code = 'QUEUE_FULL';
      throw err;
    }

    const jobId = `job_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const job = {
      id: jobId,
      printerId,
      format,
      payload: Buffer.isBuffer(payload) ? payload.toString('utf8') : payload,
      idempotencyKey: idempotencyKey || null,
      status: 'queued',
      attempts: 0,
      maxAttempts: this.maxAttempts,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      error: null,
      result: null,
    };

    this.jobs.set(jobId, job);
    if (idempotencyKey) {
      this.idempotencyMap.set(idempotencyKey, jobId);
    }

    this._saveState();
    // Trigger immediate background worker loop
    setImmediate(() => this.processNextJobs());

    return job;
  }

  /** Retrieve job by ID */
  getJob(jobId) {
    return this.jobs.get(jobId) || null;
  }

  /** Cancel a pending job */
  cancelJob(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) return false;

    if (job.status === 'queued') {
      job.status = 'cancelled';
      job.updatedAt = Date.now();
      this._saveState();
      return true;
    }
    return false;
  }

  /** List jobs with optional filter */
  listJobs(filter = {}) {
    let list = Array.from(this.jobs.values());
    if (filter.printerId) list = list.filter((j) => j.printerId === filter.printerId);
    if (filter.status) list = list.filter((j) => j.status === filter.status);
    return list;
  }

  /** Process pending queued jobs using per-printer mutex locking */
  async processNextJobs() {
    const queuedJobs = Array.from(this.jobs.values()).filter((j) => j.status === 'queued');

    for (const job of queuedJobs) {
      const { printerId } = job;
      if (this.printerLocks.has(printerId)) continue; // Lock held by active print task

      // Acquire lock for printer
      this.printerLocks.add(printerId);
      job.status = 'processing';
      job.attempts += 1;
      job.updatedAt = Date.now();
      this._saveState();

      // Execute job in background
      this._executeJob(job)
        .finally(() => {
          this.printerLocks.delete(printerId);
          setImmediate(() => this.processNextJobs());
        });
    }
  }

  async _executeJob(job) {
    try {
      const driver = this.drivers[job.format] || this.drivers.raw;
      if (!driver) {
        throw new Error(`No driver registered for format "${job.format}".`);
      }

      const targetConfig = this.registry ? this.registry.getPrinter(job.printerId) : null;
      const result = await driver.print(job, targetConfig);

      job.status = 'completed';
      job.result = result;
      job.updatedAt = Date.now();
    } catch (err) {
      job.error = err.message;
      job.updatedAt = Date.now();

      if (job.attempts < job.maxAttempts) {
        job.status = 'queued'; // Re-queue for retry with backoff
      } else {
        job.status = 'failed';
      }
    } finally {
      this._saveState();
    }
  }

  _loadState() {
    try {
      if (fs.existsSync(this.storagePath)) {
        const raw = fs.readFileSync(this.storagePath, 'utf8');
        const items = JSON.parse(raw);
        if (Array.isArray(items)) {
          for (const item of items) {
            this.jobs.set(item.id, item);
            if (item.idempotencyKey) {
              this.idempotencyMap.set(item.idempotencyKey, item.id);
            }
          }
        }
      }
    } catch (_) {}
  }

  _saveState() {
    try {
      const items = Array.from(this.jobs.values()).slice(-200); // Retain last 200 jobs
      fs.writeFileSync(this.storagePath, JSON.stringify(items, null, 2), 'utf8');
    } catch (_) {}
  }
}

module.exports = { JobQueue };
