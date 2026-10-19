import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword } from '../server/passwords.js';

// Fixed fixtures produced independently with node-argon2 0.44.0, the module
// shipped in LOOMA 1.0–1.2.1. They cover the exact hashes already in user databases.
const legacy = [
  [
    'Legacy-Test-Password-2026',
    '$argon2id$v=19$m=65536,t=3,p=4$TE9PTUEtZml4dHVyZS12MSE$oryASOd9OuBVaRh+J99k7tklP3NjU+U4N1QKFKDtUSA',
  ],
  [
    'Тестовый-пароль-2026-🌷',
    '$argon2id$v=19$m=65536,t=3,p=4$TE9PTUEtZml4dHVyZS12MSE$ePd6S0y63SWKc7qMQSszxkaq24T9ogQ3gvF3Jbhedg4',
  ],
] as const;
test('Existing native Argon2id hashes accept the original password without migration', async () => {
  for (const [password, hash] of legacy) {
    assert.equal(await verifyPassword(hash, password), true);
    assert.equal(await verifyPassword(hash, password + '!'), false);
  }
});
test('New passwords retain Argon2id parameters and receive independent random salts', async () => {
  const password = 'New-test-only-password-2026';
  const [first, second] = await Promise.all([hashPassword(password), hashPassword(password)]);
  assert.match(first, /^\$argon2id\$v=19\$m=65536,t=3,p=4\$/);
  assert.notEqual(first, second);
  assert.equal(await verifyPassword(first, password), true);
  assert.equal(await verifyPassword(second, password), true);
  assert.equal(await verifyPassword(first, 'wrong'), false);
});
test('Damaged and excessive-cost database hashes fail without allocating excessive memory', async () => {
  for (const hash of [
    '',
    'not a password hash',
    legacy[0][1].replace('m=65536', 'm=99999999999'),
    legacy[0][1].replace('t=3', 't=999'),
  ])
    assert.equal(await verifyPassword(hash, 'irrelevant'), false);
});
test('Concurrent password checks allow the HTTP event loop to keep running', async () => {
  let ticks = 0;
  const timer = setInterval(() => ticks++, 10);
  try {
    const results = await Promise.all(
      Array.from({ length: 5 }, () => verifyPassword(legacy[0][1], legacy[0][0])),
    );
    assert.ok(results.every(Boolean));
    assert.ok(ticks > 0);
  } finally {
    clearInterval(timer);
  }
});
