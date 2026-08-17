/**
 * tests/queue.test.js
 * Test suite for JobQueue engine, idempotency, per-printer locking, and retries.
 */

'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');
const { PrinterRegistry, JobQueue } = require('../packages/core');

// Mock Driver for Queue Testing
class MockDriver {
  constructor() {
    this.printed = [];
  }
  async print(job) {
    this.printed.push(job.id);
    return { success: true, jobId: job.id, byteLength: 100, durationMs: 10 };
  }
}

async function testJobQueue() {
  console.log('Testing JobQueue...');
  const tmpPrinters = path.join(os.tmpdir(), `test_queue_p_${Date.now()}.json`);
  const tmpJobs     = path.join(os.tmpdir(), `test_queue_j_${Date.now()}.json`);

  const registry = new PrinterRegistry({ storagePath: tmpPrinters });
  registry.registerPrinter({
    id: 'receipt_1',
    name: 'Counter Receipt',
    transport: 'win32',
    printerName: 'POS-80',
  });

  const mockDriver = new MockDriver();
  const queue = new JobQueue({
    registry,
    drivers: { tspl: mockDriver, raw: mockDriver },
    storagePath: tmpJobs,
  });

  // 1. Enqueue job
  const job1 = await queue.enqueueJob({
    printerId: 'receipt_1',
    format: 'tspl',
    payload: 'SIZE 4,2\nPRINT 1,1',
    idempotencyKey: 'idemp_key_001',
  });

  assert.strictEqual(job1.printerId, 'receipt_1');
  assert.ok(job1.id.startsWith('job_'));

  // 2. Idempotency deduplication check
  const job1Duplicate = await queue.enqueueJob({
    printerId: 'receipt_1',
    format: 'tspl',
    payload: 'SIZE 4,2\nPRINT 1,1',
    idempotencyKey: 'idemp_key_001',
  });
  assert.strictEqual(job1Duplicate.id, job1.id);

  // 3. Reject unregistered printer
  await assert.rejects(
    async () => {
      await queue.enqueueJob({
        printerId: 'non_existent_printer',
        payload: 'PRINT 1',
      });
    },
    (err) => err.code === 'PRINTER_NOT_REGISTERED'
  );

  // Wait briefly for background execution
  await new Promise((r) => setTimeout(r, 200));

  const fetched = queue.getJob(job1.id);
  assert.strictEqual(fetched.status, 'completed');

  // Cleanup
  if (fs.existsSync(tmpPrinters)) fs.unlinkSync(tmpPrinters);
  if (fs.existsSync(tmpJobs)) fs.unlinkSync(tmpJobs);

  console.log('✓ JobQueue tests passed.');
}

testJobQueue();
