/**
 * tests/core.test.js
 * Unit and integration tests for PrinterRegistry and PrinterDrivers.
 */

'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');

const {
  PrinterRegistry,
  RawPrinterDriver,
  TsplPrinterDriver,
  EscPosPrinterDriver,
} = require('../packages/core');

async function testPrinterRegistry() {
  console.log('Testing PrinterRegistry...');
  const tmpStorage = path.join(os.tmpdir(), `test_printers_${Date.now()}.json`);
  const registry = new PrinterRegistry({ storagePath: tmpStorage });

  // 1. Register valid win32 printer
  const winPrinter = registry.registerPrinter({
    id: 'counter_label_1',
    name: 'Counter Label Printer',
    type: 'tspl',
    transport: 'win32',
    printerName: 'TSC TTP-244 Pro',
  });
  assert.strictEqual(winPrinter.id, 'counter_label_1');
  assert.strictEqual(winPrinter.transport, 'win32');

  // 2. Resolve registered printer
  const fetched = registry.getPrinter('counter_label_1');
  assert.strictEqual(fetched.printerName, 'TSC TTP-244 Pro');

  // 3. Security Check: Invalid printer ID characters
  assert.throws(
    () => { registry.registerPrinter({ id: '../../etc/passwd', transport: 'win32', printerName: 'X' }); },
    (err) => err.code === 'INVALID_PRINTER_ID'
  );

  // 4. Security Check: Path traversal in devicePath
  assert.throws(
    () => {
      registry.registerPrinter({
        id: 'hacked_device',
        transport: 'linux',
        devicePath: '/etc/shadow',
      });
    },
    (err) => err.code === 'SECURITY_VIOLATION'
  );

  // 5. Security Check: SSRF loopback in network host
  assert.throws(
    () => {
      registry.registerPrinter({
        id: 'ssrf_target',
        transport: 'network',
        host: '127.0.0.1',
      });
    },
    (err) => err.code === 'SECURITY_VIOLATION'
  );

  // 6. Unregister printer
  assert.strictEqual(registry.unregisterPrinter('counter_label_1'), true);
  assert.strictEqual(registry.getPrinter('counter_label_1'), null);

  // Cleanup
  if (fs.existsSync(tmpStorage)) fs.unlinkSync(tmpStorage);
  console.log('✓ PrinterRegistry tests passed.');
}

async function testDrivers() {
  console.log('Testing Printer Drivers...');

  const rawDriver = new RawPrinterDriver();
  const tsplDriver = new TsplPrinterDriver({ transport: rawDriver });
  const escposDriver = new EscPosPrinterDriver({ transport: rawDriver });

  // 1. TSPL Validation
  const validTspl = 'SIZE 4,2\nGAP 0,0\nCLS\nTEXT 10,10,"3",0,1,1,"Test"\nPRINT 1,1';
  assert.strictEqual(await tsplDriver.validate(validTspl), true);
  assert.strictEqual(await tsplDriver.validate('HELLO WORLD NO TSPL'), false);

  // 2. ESC/POS Validation
  const validEscPos = Buffer.from([0x1b, 0x40, 0x48, 0x65, 0x6c, 0x6c, 0x6f]);
  assert.strictEqual(await escposDriver.validate(validEscPos), true);

  // 3. Discovery
  const printers = await rawDriver.discover();
  assert.ok(Array.isArray(printers));

  console.log('✓ Driver validation tests passed.');
}

async function run() {
  try {
    await testPrinterRegistry();
    await testDrivers();
    console.log('\nAll Phase 3 Core Tests Passed Successfully!');
  } catch (err) {
    console.error('Test execution failed:', err);
    process.exit(1);
  }
}

run();
