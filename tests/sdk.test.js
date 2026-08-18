/**
 * tests/sdk.test.js
 * Test suite for @jp-pos/print-agent-sdk client library.
 */

'use strict';

const assert = require('assert');
const { PrintAgent } = require('../packages/sdk');

async function testSdk() {
  console.log('Testing PrintAgent SDK...');

  const agent = new PrintAgent({
    endpoint: 'http://127.0.0.1:9200',
    token: 'test_token_123',
  });

  assert.strictEqual(agent.endpoint, 'http://127.0.0.1:9200');
  assert.strictEqual(agent.token, 'test_token_123');
  assert.strictEqual(agent.connected, false);

  // Validate parameter checks
  await assert.rejects(
    async () => {
      await agent.print({});
    },
    /printerId is required/
  );

  console.log('✓ PrintAgent SDK tests passed.');
}

testSdk();
