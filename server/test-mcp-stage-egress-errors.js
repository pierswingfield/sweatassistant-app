'use strict';

const assert = require('node:assert/strict');

process.env.DB_PATH = ':memory:';
process.env.ENCRYPTION_KEY = 'fixture-encryption-key-for-egress-test';
process.env.MCP_STAGE_JAB_PROFILE_ONLY = 'true';
process.env.MCP_STAGE_JAB_GATEWAY_URL = 'http://gateway.fixture';
process.env.MCP_STAGE_JAB_GATEWAY_KEY = 'fixture-gateway-key-at-least-32-bytes';

const realFetch = global.fetch;
const { credentialProviderFetch } = require('./logger');

(async () => {
  try {
    // A deny-by-default broker refusal is not a serialized upstream response
    // envelope and must remain an explicit provider-work denial.
    global.fetch = async () => new Response('{"error":"request denied"}', {
      status: 403,
      headers: { 'content-type': 'application/json' },
    });
    await assert.rejects(credentialProviderFetch(
      'jab-boxing',
      'https://jabboxingclub.marianatek.com/api/customer/v1/me/account',
      { headers: { authorization: 'Bearer fixture-only' } },
    ), err => err.code === 'PROVIDER_WORK_DISABLED' && err.status === 403 && /before contacting JAB/.test(err.message));

    // An HTTP 200 with no upstream status/body is still a malformed broker
    // envelope, not a successful empty provider response.
    global.fetch = async () => new Response('{"error":"malformed envelope"}', { status: 200 });
    await assert.rejects(credentialProviderFetch(
      'jab-boxing',
      'https://jabboxingclub.marianatek.com/api/customer/v1/me/account',
      { headers: { authorization: 'Bearer fixture-only' } },
    ), err => err.code === 'PROVIDER_WORK_DISABLED' && err.status === 502 && /invalid response/.test(err.message));

    // Broker transport and JSON decoding failures must not escape as generic
    // errors that the link route would mislabel as invalid gym credentials.
    global.fetch = async () => { throw new TypeError('fixture transport failure'); };
    await assert.rejects(credentialProviderFetch(
      'jab-boxing',
      'https://jabboxingclub.marianatek.com/api/customer/v1/me/account',
      { headers: { authorization: 'Bearer fixture-only' } },
    ), err => err.code === 'PROVIDER_WORK_DISABLED' && err.status === 503 && /gateway is unavailable/.test(err.message));

    global.fetch = async () => new Response('not-json', { status: 200 });
    await assert.rejects(credentialProviderFetch(
      'jab-boxing',
      'https://jabboxingclub.marianatek.com/api/customer/v1/me/account',
      { headers: { authorization: 'Bearer fixture-only' } },
    ), err => err.code === 'PROVIDER_WORK_DISABLED' && err.status === 502 && /invalid response/.test(err.message));
    process.stdout.write('gateway refusals and malformed envelopes remain non-success through the provider adapter\n');
  } finally {
    global.fetch = realFetch;
  }
})().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
