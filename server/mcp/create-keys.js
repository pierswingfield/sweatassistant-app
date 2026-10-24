#!/usr/bin/env node
// Offline operator setup. Writes no bearer token and prints no key material.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const directory = process.argv[2];
if (!directory || process.argv.length !== 3) {
  console.error('Usage: node server/mcp/create-keys.js PRIVATE_DIRECTORY');
  process.exitCode = 1;
} else {
  const target = path.resolve(directory);
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  const privateFile = path.join(target, 'signing.json');
  const publicFile = path.join(target, 'jwks.json');
  if (fs.existsSync(privateFile) || fs.existsSync(publicFile)) throw new Error('Refusing to replace existing signing keys');
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const kid = crypto.randomUUID();
  fs.writeFileSync(privateFile, JSON.stringify({ ...privateKey.export({ format: 'jwk' }), kid, alg: 'ES256', use: 'sig' }), { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(publicFile, JSON.stringify({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid, alg: 'ES256', use: 'sig' }] }), { flag: 'wx', mode: 0o600 });
  console.log(`Private signing key: ${privateFile}\nPublic verification keys: ${publicFile}`);
}
