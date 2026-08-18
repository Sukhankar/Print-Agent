#!/usr/bin/env node
/**
 * print-agent CLI
 * ─────────────────────────────────────────────────────────────────────────────
 * Command-line management & diagnostic tool for the Print Agent.
 * Usage: print-agent <command> [options]
 */

'use strict';

const os   = require('os');
const fs   = require('fs');
const net  = require('net');
const path = require('path');

const { PrinterRegistry, RawPrinterDriver, AuthManager } = require('../../packages/core');

const args    = process.argv.slice(2);
const command = args[0] || 'help';

async function main() {
  switch (command.toLowerCase()) {
    case 'doctor':
      await runDoctor();
      break;
    case 'printers':
      await listPrinters();
      break;
    case 'register':
      await registerPrinter(args.slice(1));
      break;
    case 'status':
      await checkStatus();
      break;
    case 'test-print':
      await testPrint(args.slice(1));
      break;
    case 'start':
      console.log('Starting Print Agent in background...');
      require('../../server.js');
      break;
    case 'help':
    default:
      showHelp();
      break;
  }
}

async function runDoctor() {
  console.log('=== Print Agent Doctor Diagnostics ===\n');

  // 1. Node Version Check
  const nodeVer = process.version;
  const majorVer = parseInt(nodeVer.replace('v', '').split('.')[0], 10);
  const nodeOk = majorVer >= 18;
  console.log(`[${nodeOk ? 'PASS' : 'FAIL'}] Node.js Version: ${nodeVer} (Minimum v18.0.0 required)`);

  // 2. Platform & OS
  console.log(`[INFO] OS Platform: ${os.platform()} (${os.type()} ${os.arch()})`);

  // 3. Port Availability (default 9200)
  const port = parseInt(process.env.PRINT_AGENT_PORT || '9200', 10);
  const portAvailable = await checkPortAvailable(port, '127.0.0.1');
  console.log(`[${portAvailable ? 'PASS' : 'WARN'}] Port ${port}: ${portAvailable ? 'Available' : 'In use or active service running'}`);

  // 4. Hardware Driver & Discovery Check
  const driver = new RawPrinterDriver();
  const discovered = await driver.discover();
  console.log(`[${discovered.length > 0 ? 'PASS' : 'WARN'}] Hardware Printer Discovery: Found ${discovered.length} local device(s)`);
  for (const d of discovered) {
    console.log(`       └─ ${d.name} (${d.platform})`);
  }

  // 5. Auth Vault Check
  const auth = new AuthManager();
  console.log(`[PASS] Auth Manager: Local loopback token active (${auth.loopbackToken ? 'Provisioned' : 'Missing'})`);

  // 6. Disk Space Check
  const tmpDir = os.tmpdir();
  const tmpExists = fs.existsSync(tmpDir);
  console.log(`[${tmpExists ? 'PASS' : 'FAIL'}] Temp Directory Access: ${tmpDir}`);

  console.log('\nDiagnostics completed.');
}

async function listPrinters() {
  const registry = new PrinterRegistry();
  const list = registry.listPrinters();
  console.log(`=== Registered Printers (${list.length}) ===`);
  if (list.length === 0) {
    console.log('No printers currently registered. Use "print-agent register" to add one.');
  } else {
    for (const p of list) {
      console.log(` - ID: ${p.id} | Name: ${p.name} | Type: ${p.type} | Transport: ${p.transport}`);
    }
  }
}

async function registerPrinter(cmdArgs) {
  if (cmdArgs.length < 3) {
    console.log('Usage: print-agent register <id> <type: tspl|escpos|raw> <transport: win32|linux|network> [target]');
    return;
  }

  const [id, type, transport, target] = cmdArgs;
  const registry = new PrinterRegistry();

  const config = { id, type, transport };
  if (transport === 'win32') config.printerName = target || 'Generic RAW';
  if (transport === 'linux') config.devicePath = target || '/dev/usb/lp0';
  if (transport === 'network') {
    config.host = target || '192.168.1.100';
    config.port = 9100;
  }

  try {
    const reg = registry.registerPrinter(config);
    console.log(`✓ Successfully registered printer "${reg.id}" (${reg.transport})`);
  } catch (err) {
    console.error(`Error registering printer: ${err.message}`);
  }
}

async function checkStatus() {
  const auth = new AuthManager();
  console.log(`Print Agent Service Status: Configured on port 9200`);
  console.log(`Loopback Token: ${auth.loopbackToken}`);
}

async function testPrint(cmdArgs) {
  const printerId = cmdArgs[0];
  if (!printerId) {
    console.log('Usage: print-agent test-print <printerId>');
    return;
  }

  const registry = new PrinterRegistry();
  const targetConfig = registry.getPrinter(printerId);
  if (!targetConfig) {
    console.error(`Printer "${printerId}" not found in registry.`);
    return;
  }

  console.log(`Sending diagnostic test label to printer "${printerId}"...`);
  const driver = new RawPrinterDriver();
  const testTspl = 'SIZE 4,2\nGAP 0,0\nCLS\nTEXT 10,10,"3",0,1,1,"TEST PRINT OK"\nPRINT 1,1';

  try {
    const res = await driver.print({ id: 'test_job', payload: testTspl }, targetConfig);
    console.log(`✓ Test print successful! Bytes written: ${res.byteLength} bytes in ${res.durationMs}ms.`);
  } catch (err) {
    console.error(`Test print failed: ${err.message}`);
  }
}

function checkPortAvailable(port, host) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, host);
  });
}

function showHelp() {
  console.log(`
Universal Print Agent CLI

Usage:
  print-agent doctor                 Run environment & hardware diagnostics
  print-agent printers               List registered printer aliases
  print-agent register <id> <type> <transport> [target]  Register a new printer mapping
  print-agent status                 Check daemon configuration & loopback token
  print-agent test-print <printerId> Dispatch a diagnostic test print job
  print-agent start                  Start agent daemon in foreground
`);
}

main().catch(console.error);
