// One-command proof: runs the test suite, then one scripted fake sale.
// Fakes only: no network, no keys, no real money, no real WhatsApp number.
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import assert from 'node:assert/strict';

import { Agent } from './src/agent.ts';
import { ListingStore } from './src/listings.ts';
import { EscrowStore, FakePaymentGateway } from './src/payments.ts';
import { FakeTranscriber } from './src/transcription.ts';

function failed(step) {
  process.stdout.write(`PROVE FAILED — ${step}\n`);
  process.exit(1);
}

// a) Full test suite.
const testFiles = readdirSync('test')
  .filter((name) => name.endsWith('.test.ts'))
  .map((name) => `test/${name}`);
const run = spawnSync(process.execPath, ['--test', ...testFiles], { encoding: 'utf8' });
const output = (run.stdout ?? '') + (run.stderr ?? '');
const passMatch = /ℹ pass (\d+)/.exec(output);
const failMatch = /ℹ fail (\d+)/.exec(output);
const passCount = passMatch === null ? 0 : Number(passMatch[1]);
const failCount = failMatch === null ? -1 : Number(failMatch[1]);
if (run.status !== 0 || failCount !== 0 || passCount === 0) {
  process.stdout.write(output + '\n');
  failed(`test suite (${passCount} passed, ${failCount} failed)`);
}
process.stdout.write(`PASS  test suite: ${passCount}/${passCount} tests passing\n`);

// b) One scripted fake sale.
const SELLER = '2250700000001';
const BUYER = '2250700000002';

const transcriber = new FakeTranscriber({ 'voice-note-1': 'tilapia frais 2500 francs' });
const listings = new ListingStore();
const gateway = new FakePaymentGateway();
const escrow = new EscrowStore(gateway);
const agent = new Agent(transcriber, listings, escrow);

const say = (body) => agent.handle({ type: 'text', from: BUYER, body });

let listingId = '';

const steps = [
  [
    'seller voice note -> listing created',
    async () => {
      const start = performance.now();
      await agent.handle({ type: 'audio', from: SELLER, mediaId: 'voice-note-1' });
      const seconds = (performance.now() - start) / 1000;
      const found = listings.all();
      assert.equal(found.length, 1);
      assert.equal(found[0].product, 'tilapia frais');
      assert.equal(found[0].priceFcfa, 2500);
      assert.equal(found[0].sellerPhone, SELLER);
      listingId = found[0].id;
      return `(${found[0].product}, ${found[0].priceFcfa} FCFA) voice-note-to-listing: ${seconds.toFixed(3)} s`;
    },
  ],
  [
    'buyer search "cherche tilapia" -> listing found',
    async () => {
      const reply = await say('cherche tilapia');
      assert.ok(reply.text.includes('tilapia frais'), reply.text);
      assert.ok(reply.text.includes(`[${listingId}]`), reply.text);
    },
  ],
  [
    'buyer order -> order summary and payment options',
    async () => {
      const reply = await say(`commande ${listingId}`);
      assert.ok(reply.text.includes('tilapia frais'), reply.text);
      assert.ok(reply.text.includes(`wave ${listingId}`), reply.text);
      assert.ok(reply.text.includes(`orange ${listingId}`), reply.text);
      assert.equal(gateway.charges.length, 0, 'no money should move on order');
    },
  ],
  [
    'buyer pays with Wave -> money HELD',
    async () => {
      await say(`wave ${listingId}`);
      const held = escrow.findHeld(listingId, BUYER);
      assert.ok(held !== undefined, 'no held escrow');
      assert.equal(held.state, 'held');
      assert.equal(held.amountFcfa, 2500);
      assert.equal(held.provider, 'wave');
      assert.equal(gateway.charges.length, 1);
      assert.equal(gateway.transfers.length, 0, 'seller must not be paid yet');
    },
  ],
  [
    'buyer pays again on same order -> BLOCKED',
    async () => {
      const reply = await say(`wave ${listingId}`);
      assert.match(reply.text, /déjà une commande/i);
      assert.equal(gateway.charges.length, 1, 'second charge went through');
    },
  ],
  [
    'buyer confirms "reçu" -> money RELEASED to seller',
    async () => {
      const heldId = escrow.findHeld(listingId, BUYER)?.id;
      assert.ok(heldId !== undefined, 'no held escrow to release');
      await say(`reçu ${listingId}`);
      assert.equal(escrow.get(heldId)?.state, 'released');
      assert.equal(gateway.transfers.length, 1);
      assert.equal(gateway.transfers[0].sellerPhone, SELLER);
      assert.equal(gateway.transfers[0].amountFcfa, 2500);
    },
  ],
  [
    'second order: pay -> HELD',
    async () => {
      await say(`orange ${listingId}`);
      const held = escrow.findHeld(listingId, BUYER);
      assert.ok(held !== undefined, 'no held escrow');
      assert.equal(held.state, 'held');
      assert.equal(held.provider, 'orange_money');
      assert.equal(gateway.charges.length, 2);
    },
  ],
  [
    'second order: "annuler" -> REFUNDED to buyer',
    async () => {
      const heldId = escrow.findHeld(listingId, BUYER)?.id;
      assert.ok(heldId !== undefined, 'no held escrow to refund');
      await say(`annuler ${listingId}`);
      assert.equal(escrow.get(heldId)?.state, 'refunded');
      assert.equal(gateway.refunds.length, 1);
      assert.equal(gateway.refunds[0].buyerPhone, BUYER);
      assert.equal(gateway.transfers.length, 1, 'seller must not be paid on refund');
    },
  ],
];

for (const [name, fn] of steps) {
  let detail;
  try {
    detail = await fn();
  } catch {
    failed(name);
  }
  process.stdout.write(`PASS  ${name}${detail ? ' ' + detail : ''}\n`);
}

process.stdout.write('PROVE OK — tests + full sale passed (fakes only, no real money)\n');
