/**
 * tests/protocol.test.js
 * Test suite for protocol schemas and TSPL command sanitizer.
 */

'use strict';

const assert = require('assert');
const {
  validateTspl,
  validateCreateJobSchema,
  validateRegisterPrinterSchema,
} = require('../packages/protocol');

function testTsplSanitizer() {
  console.log('Testing TSPL Sanitizer...');

  // 1. Valid TSPL string
  const validStr = 'SIZE 4,2\nGAP 0,0\nCLS\nTEXT 10,10,"3",0,1,1,"Label"\nPRINT 1,1';
  const res1 = validateTspl(validStr);
  assert.strictEqual(res1.valid, true);
  assert.strictEqual(res1.errors.length, 0);

  // 2. Forbidden command (FLASH)
  const forbiddenStr = 'SIZE 4,2\nFLASH 0,0\nPRINT 1,1';
  const res2 = validateTspl(forbiddenStr);
  assert.strictEqual(res2.valid, false);
  assert.ok(res2.errors[0].includes('Forbidden TSPL command "FLASH"'));

  // 3. Unrecognized command in strict mode
  const unknownStr = 'SIZE 4,2\nCUSTOMCMD 123\nPRINT 1,1';
  const res3 = validateTspl(unknownStr);
  assert.strictEqual(res3.valid, false);
  assert.ok(res3.errors[0].includes('Unrecognized command "CUSTOMCMD"'));

  console.log('✓ TSPL Sanitizer tests passed.');
}

function testSchemas() {
  console.log('Testing Protocol Schemas...');

  // 1. Create Job Schema Valid
  const jobValid = validateCreateJobSchema({
    printerId: 'counter_label_1',
    format: 'tspl',
    payload: 'SIZE 4,2\nPRINT 1,1',
  });
  assert.strictEqual(jobValid.valid, true);

  // 2. Create Job Schema Invalid (Missing payload)
  const jobInvalid = validateCreateJobSchema({
    printerId: 'counter_label_1',
    format: 'tspl',
  });
  assert.strictEqual(jobInvalid.valid, false);

  // 3. Register Printer Schema Valid
  const regValid = validateRegisterPrinterSchema({
    id: 'receipt_printer',
    transport: 'win32',
    printerName: 'POS-80',
  });
  assert.strictEqual(regValid.valid, true);

  console.log('✓ Protocol Schema tests passed.');
}

function run() {
  try {
    testTsplSanitizer();
    testSchemas();
    console.log('\nAll Phase 4 Protocol Tests Passed Successfully!');
  } catch (err) {
    console.error('Phase 4 Test Execution Failed:', err);
    process.exit(1);
  }
}

run();
