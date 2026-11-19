import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createServer } from '../src/app.ts';

const VERIFY_TOKEN = 'test-verify-token';
const server = createServer({ verifyToken: VERIFY_TOKEN });
let baseUrl = '';

before(async () => {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  const closed = new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  server.closeAllConnections();
  await closed;
});

function handshakeUrl(params: Record<string, string>): string {
  return `${baseUrl}/webhook?${new URLSearchParams(params).toString()}`;
}

function postWebhook(body: string): Promise<Response> {
  return fetch(`${baseUrl}/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
}

async function assertJson(response: Response, status: number, expected: unknown): Promise<void> {
  assert.equal(response.status, status);
  assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.deepEqual(await response.json(), expected);
}

const textMessagePayload = {
  object: 'whatsapp_business_account',
  entry: [
    {
      id: 'test-business-account-id',
      changes: [
        {
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: {
              display_phone_number: '15550000000',
              phone_number_id: 'test-phone-number-id',
            },
            contacts: [{ profile: { name: 'Example User' }, wa_id: '15550000001' }],
            messages: [
              {
                from: '15550000001',
                id: 'wamid.test-message-1',
                timestamp: '1700000000',
                type: 'text',
                text: { body: 'Hello Midj' },
              },
            ],
          },
        },
      ],
    },
  ],
};

test('a text message POST gets the expected reply', async () => {
  const response = await postWebhook(JSON.stringify(textMessagePayload));
  await assertJson(response, 200, {
    replies: [{ to: '15550000001', text: 'Midj received: Hello Midj' }],
  });
});

test('the handshake returns the challenge', async () => {
  const response = await fetch(
    handshakeUrl({
      'hub.mode': 'subscribe',
      'hub.verify_token': VERIFY_TOKEN,
      'hub.challenge': 'test-challenge-123',
    }),
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.equal(await response.text(), 'test-challenge-123');
});

test('a wrong verify token gets 403', async () => {
  const response = await fetch(
    handshakeUrl({
      'hub.mode': 'subscribe',
      'hub.verify_token': 'wrong-verify-token',
      'hub.challenge': 'test-challenge-123',
    }),
  );
  await assertJson(response, 403, { error: 'forbidden' });
});

test('a missing challenge gets 400', async () => {
  const response = await fetch(
    handshakeUrl({ 'hub.mode': 'subscribe', 'hub.verify_token': VERIFY_TOKEN }),
  );
  await assertJson(response, 400, { error: 'missing_challenge' });
});

test('invalid JSON gets 400 invalid_json', async () => {
  const response = await postWebhook('{"object": ');
  await assertJson(response, 400, { error: 'invalid_json' });
});

test('a wrong object field gets 400 invalid_payload', async () => {
  const response = await postWebhook(JSON.stringify({ object: 'page', entry: [] }));
  await assertJson(response, 400, { error: 'invalid_payload' });
});

test('a status-only payload gets 200 with no replies', async () => {
  const payload = {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'test-business-account-id',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              statuses: [
                {
                  id: 'wamid.test-message-1',
                  status: 'delivered',
                  timestamp: '1700000001',
                  recipient_id: '15550000001',
                },
              ],
            },
          },
        ],
      },
    ],
  };
  const response = await postWebhook(JSON.stringify(payload));
  await assertJson(response, 200, { replies: [] });
});

test('PUT gets 405 with Allow: GET, POST', async () => {
  const response = await fetch(`${baseUrl}/webhook`, { method: 'PUT', body: '{}' });
  assert.equal(response.headers.get('allow'), 'GET, POST');
  await assertJson(response, 405, { error: 'method_not_allowed' });
});

test('an unknown path gets 404', async () => {
  const response = await fetch(`${baseUrl}/unknown`);
  await assertJson(response, 404, { error: 'not_found' });
});

test('/webhook/ with a trailing slash gets 404', async () => {
  const response = await fetch(`${baseUrl}/webhook/`);
  await assertJson(response, 404, { error: 'not_found' });
});
