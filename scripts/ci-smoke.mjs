import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

if (process.env.CI !== 'true') throw new Error('This check creates sample data in CI only.');
assert.ok(process.env.SEED_PASSWORD, 'SEED_PASSWORD is required');
const origin = 'http://localhost:3001';
const base = 'http://127.0.0.1:3001';
let cookie = '';

async function request(path, { method = 'GET', body, form } = {}) {
  const r = await fetch(base + path, {
    method,
    headers: {
      origin,
      'x-looma-client': 'web',
      ...(cookie ? { cookie } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : form,
    signal: AbortSignal.timeout(15000),
  });
  assert.ok(r.ok, `${method} ${path}: ${r.status} ${r.ok ? '' : await r.text()}`);
  return r;
}

assert.equal((await (await request('/api/health')).json()).status, 'ok');
const html = await (await request('/')).text();
assert.match(html, /LOOMA\.CRM/);
const script = html.match(/<script\b[^>]*\bsrc="([^"]+)"/);
assert.ok(script, 'Production JavaScript bundle must be served');
assert.match((await request(script[1])).headers.get('content-type'), /javascript/);

const login = await request('/api/auth/login', {
  method: 'POST',
  body: { email: 'owner@looma.local', password: process.env.SEED_PASSWORD },
});
cookie = login.headers.getSetCookie()[0]?.split(';')[0];
assert.ok(cookie);
assert.equal((await (await request('/api/auth/me')).json()).role, 'owner');

const client = await (
  await request('/api/clients', {
    method: 'POST',
    body: { name: 'CI test client', phone: '+7 999 000 00 01' },
  })
).json();
const order = await (
  await request('/api/orders', {
    method: 'POST',
    body: {
      client_id: client.id,
      title: 'CI test order',
      due_date: '2026-12-31',
      idempotency_key: randomUUID(),
      items: [{ kind: 'Диван', model: 'CI', quantity: 1, price: 12000000 }],
    },
  })
).json();
const bytes = Buffer.from('%PDF-1.4\nLOOMA Docker test\n%%EOF');
const form = new FormData();
form.append('file', new Blob([bytes], { type: 'application/pdf' }), 'ci-check.pdf');
const document = await (
  await request(`/api/documents?order_id=${order.id}&category=contract&visibility=commercial`, {
    method: 'POST',
    form,
  })
).json();
const downloaded = Buffer.from(
  await (await request(`/api/documents/${document.id}/download`)).arrayBuffer(),
);
assert.deepEqual(downloaded, bytes);
assert.equal((await (await request(`/api/orders/${order.id}`)).json()).total, 12000000);
const data = await (await request(`/api/orders/${order.id}/document-data`)).json();
const generated = await (
  await request(`/api/orders/${order.id}/generate-documents`, {
    method: 'POST',
    body: {
      idempotency_key: randomUUID(),
      source_token: data.source_token,
      kinds: ['contract', 'appendix', 'proposal', 'invoice'],
      buyer: data.buyer,
      seller: data.seller,
      fields: {
        ...data.fields,
        city: 'Москва',
        delivery_address: 'Тестовый адрес CI',
        delivery_terms: 'Доставка включена',
      },
      item_images: {},
      item_descriptions: data.item_descriptions,
    },
  })
).json();
assert.equal(generated.documents.length, 4);
for (const file of generated.documents) {
  const bytes = Buffer.from(
    await (await request(`/api/documents/${file.id}/download`)).arrayBuffer(),
  );
  assert.equal(bytes.subarray(0, 2).toString(), 'PK');
}
console.log(
  'Application verified: static bundle, owner login, client, order, uploads and all four generated templates.',
);
