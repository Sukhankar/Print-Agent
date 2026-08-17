/**
 * tests/auth.test.js
 * Test suite for AuthManager authentication and token handling.
 */

'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');
const { AuthManager } = require('../packages/core');

async function testAuthManager() {
  console.log('Testing AuthManager...');
  const tmpVault = path.join(os.tmpdir(), `test_vault_${Date.now()}.json`);
  const auth = new AuthManager({ storagePath: tmpVault });

  // 1. Loopback Token Auto-Provisioning
  assert.ok(auth.loopbackToken.startsWith('lpb_'));

  const validLoopback = auth.validateToken(`Bearer ${auth.loopbackToken}`);
  assert.strictEqual(validLoopback.valid, true);
  assert.strictEqual(validLoopback.payload.sub, 'loopback-local');

  // 2. Issue and Validate Signed Access Token
  const token = auth.issueToken({ sub: 'user_123', scope: 'print' }, 60);
  const validSigned = auth.validateToken(token);
  assert.strictEqual(validSigned.valid, true);
  assert.strictEqual(validSigned.payload.sub, 'user_123');

  // 3. Reject Invalid Token
  const invalidRes = auth.validateToken('Bearer invalid_garbage_token');
  assert.strictEqual(invalidRes.valid, false);

  // 4. Token Revocation
  auth.revokeToken(token);
  const revokedRes = auth.validateToken(token);
  assert.strictEqual(revokedRes.valid, false);
  assert.strictEqual(revokedRes.error, 'Token has been revoked.');

  // Cleanup
  if (fs.existsSync(tmpVault)) fs.unlinkSync(tmpVault);
  console.log('✓ AuthManager tests passed.');
}

testAuthManager();
