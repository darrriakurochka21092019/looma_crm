import { parentPort, workerData } from 'node:worker_threads';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { argon2id } from 'hash-wasm';
import type { PasswordJob } from './passwords.js';

const job = workerData as PasswordJob;
const defaults = { memorySize: 65536, iterations: 3, parallelism: 4, hashLength: 32 };
async function verify(hash: string, password: string) {
  // Existing LOOMA hashes are Argon2id v1.3 PHC strings. Bound parameters before
  // allocating memory; a damaged database value must not exhaust the server.
  const match =
    /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/.exec(hash);
  if (!match || hash.length > 512) return false;
  const [memorySize, iterations, parallelism] = match.slice(1, 4).map(Number);
  const salt = Buffer.from(match[4], 'base64');
  const expected = Buffer.from(match[5], 'base64');
  if (
    parallelism < 1 ||
    parallelism > 16 ||
    memorySize < 8 * parallelism ||
    memorySize > 262144 ||
    iterations < 1 ||
    iterations > 10 ||
    salt.length < 8 ||
    salt.length > 64 ||
    expected.length < 16 ||
    expected.length > 64 ||
    salt.toString('base64').replace(/=+$/, '') !== match[4] ||
    expected.toString('base64').replace(/=+$/, '') !== match[5]
  )
    return false;
  const actual = await argon2id({
    password,
    salt,
    memorySize,
    iterations,
    parallelism,
    hashLength: expected.length,
    outputType: 'binary',
  });
  return timingSafeEqual(actual, expected);
}
const result =
  job.kind === 'hash'
    ? await argon2id({
        ...defaults,
        password: job.password,
        salt: randomBytes(16),
        outputType: 'encoded',
      })
    : await verify(job.hash, job.password);
parentPort!.postMessage(result);
