/**
 * Tests for:
 *   - parseTranscript (listings.ts)
 *   - ListingStore (listings.ts)
 *   - FakePaymentGateway + EscrowStore (payments.ts)
 *   - Agent core loop (agent.ts)
 *   - HTTP integration with agent wired in (app.ts)
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';

import { parseTranscript, ListingStore } from '../src/listings.ts';
import { FakePaymentGateway, EscrowStore } from '../src/payments.ts';
import { FakeTranscriber } from '../src/transcription.ts';
import { Agent } from '../src/agent.ts';
import { createServer } from '../src/app.ts';

// ── parseTranscript ──────────────────────────────────────────────────────────

describe('parseTranscript', () => {
  test('parses "Tomates fraîches 500 FCFA"', () => {
    const r = parseTranscript('Tomates fraîches 500 FCFA');
    assert.ok(r.ok);
    assert.equal(r.product, 'Tomates fraîches');
    assert.equal(r.priceFcfa, 500);
  });

  test('parses with lowercase suffix "cfa"', () => {
    const r = parseTranscript('Poulet braisé 2500cfa');
    assert.ok(r.ok);
    assert.equal(r.product, 'Poulet braisé');
    assert.equal(r.priceFcfa, 2500);
  });

  test('parses with suffix "f"', () => {
    const r = parseTranscript('Attiéké poisson 3000f');
    assert.ok(r.ok);
    assert.equal(r.product, 'Attiéké poisson');
    assert.equal(r.priceFcfa, 3000);
  });

  test('parses bare number at end (no suffix)', () => {
    const r = parseTranscript('Mangues du verger 800');
    assert.ok(r.ok);
    assert.equal(r.product, 'Mangues du verger');
    assert.equal(r.priceFcfa, 800);
  });

  test('returns empty_transcript for blank input', () => {
    const r = parseTranscript('   ');
    assert.ok(!r.ok);
    assert.equal(r.reason, 'empty_transcript');
  });

  test('returns no_price when only a name is given', () => {
    const r = parseTranscript('Tomates fraîches');
    assert.ok(!r.ok);
    assert.equal(r.reason, 'no_price');
  });

  test('returns no_product_name when only a price is given', () => {
    // A bare number with no preceding text
    const r = parseTranscript('500');
    assert.ok(!r.ok);
    assert.equal(r.reason, 'no_product_name');
  });
});

// ── ListingStore ─────────────────────────────────────────────────────────────

describe('ListingStore', () => {
  test('create and get round-trip', () => {
    const store = new ListingStore();
    const l = store.create('Bananes plantain', 1000, '2250700000001');
    assert.equal(l.product, 'Bananes plantain');
    assert.equal(l.priceFcfa, 1000);
    assert.equal(l.sellerPhone, '2250700000001');
    assert.ok(l.id !== '');
    assert.deepEqual(store.get(l.id), l);
  });

  test('search finds exact word match', () => {
    const store = new ListingStore();
    store.create('Tomates cerises', 600, '2250700000002');
    store.create('Poulet braisé', 3500, '2250700000003');
    const results = store.search('tomates');
    assert.equal(results.length, 1);
    assert.equal(results[0].product, 'Tomates cerises');
  });

  test('search is case-insensitive and accent-folded', () => {
    const store = new ListingStore();
    store.create('Attiéké poisson', 2000, '2250700000004');
    const results = store.search('attieke');
    assert.equal(results.length, 1);
  });

  test('search returns nothing for unmatched query', () => {
    const store = new ListingStore();
    store.create('Bananes', 500, '2250700000005');
    assert.equal(store.search('mangue').length, 0);
  });

  test('search returns empty for blank query', () => {
    const store = new ListingStore();
    store.create('Bananes', 500, '2250700000006');
    assert.equal(store.search('   ').length, 0);
  });

  test('search matches multi-word query', () => {
    const store = new ListingStore();
    store.create('Tomates cerises bio', 900, '2250700000007');
    store.create('Tomates ordinaires', 400, '2250700000008');
    const results = store.search('tomates cerises');
    assert.equal(results.length, 1);
    assert.equal(results[0].product, 'Tomates cerises bio');
  });
});

// ── EscrowStore ───────────────────────────────────────────────────────────────

describe('EscrowStore', () => {
  test('hold charges the buyer and records state=held', async () => {
    const gw = new FakePaymentGateway();
    const escrow = new EscrowStore(gw);
    const r = await escrow.hold('listing-1', 'buyer-1', 'seller-1', 2000, 'wave');
    assert.equal(r.state, 'held');
    assert.equal(r.listingId, 'listing-1');
    assert.equal(r.buyerPhone, 'buyer-1');
    assert.equal(gw.charges.length, 1);
    assert.equal(gw.charges[0].amountFcfa, 2000);
    assert.equal(gw.charges[0].provider, 'wave');
  });

  test('release transfers to seller and sets state=released', async () => {
    const gw = new FakePaymentGateway();
    const escrow = new EscrowStore(gw);
    const r = await escrow.hold('listing-2', 'buyer-2', 'seller-2', 3000, 'orange_money');
    await escrow.release(r.id);
    const updated = escrow.get(r.id)!;
    assert.equal(updated.state, 'released');
    assert.equal(gw.transfers.length, 1);
    assert.equal(gw.transfers[0].sellerPhone, 'seller-2');
    assert.equal(gw.transfers[0].amountFcfa, 3000);
  });

  test('refund sends money back to buyer and sets state=refunded', async () => {
    const gw = new FakePaymentGateway();
    const escrow = new EscrowStore(gw);
    const r = await escrow.hold('listing-3', 'buyer-3', 'seller-3', 1500, 'wave');
    await escrow.refund(r.id);
    const updated = escrow.get(r.id)!;
    assert.equal(updated.state, 'refunded');
    assert.equal(gw.refunds.length, 1);
    assert.equal(gw.refunds[0].buyerPhone, 'buyer-3');
  });

  test('releasing an already-released escrow throws', async () => {
    const gw = new FakePaymentGateway();
    const escrow = new EscrowStore(gw);
    const r = await escrow.hold('listing-4', 'buyer-4', 'seller-4', 500, 'wave');
    await escrow.release(r.id);
    await assert.rejects(() => escrow.release(r.id), /escrow_not_held/);
  });

  test('findHeld locates active escrow by listingId + buyerPhone', async () => {
    const gw = new FakePaymentGateway();
    const escrow = new EscrowStore(gw);
    const r = await escrow.hold('listing-5', 'buyer-5', 'seller-5', 700, 'orange_money');
    const found = escrow.findHeld('listing-5', 'buyer-5');
    assert.ok(found !== undefined);
    assert.equal(found.id, r.id);
  });

  test('findHeld returns undefined after release', async () => {
    const gw = new FakePaymentGateway();
    const escrow = new EscrowStore(gw);
    const r = await escrow.hold('listing-6', 'buyer-6', 'seller-6', 1200, 'wave');
    await escrow.release(r.id);
    assert.equal(escrow.findHeld('listing-6', 'buyer-6'), undefined);
  });
});

// ── Agent ────────────────────────────────────────────────────────────────────

function makeAgent(): { agent: Agent; transcriber: FakeTranscriber; gw: FakePaymentGateway } {
  const transcriber = new FakeTranscriber();
  const listings = new ListingStore();
  const gw = new FakePaymentGateway();
  const escrow = new EscrowStore(gw);
  const agent = new Agent(transcriber, listings, escrow);
  return { agent, transcriber, gw };
}

describe('Agent – seller creates a listing via voice note', () => {
  test('valid transcript creates listing and replies with its id', async () => {
    const { agent, transcriber } = makeAgent();
    transcriber.set('media-1', 'Mangues Kent 1500 FCFA');
    const reply = await agent.handle({ type: 'audio', from: '2250700000010', mediaId: 'media-1' });
    assert.match(reply.text, /Annonce créée/);
    assert.match(reply.text, /Mangues Kent/);
    assert.match(reply.text, /1\s*500/); // locale-formatted price
  });

  test('empty transcript replies with an error message', async () => {
    const { agent, transcriber } = makeAgent();
    transcriber.set('media-silent', '');
    const reply = await agent.handle({ type: 'audio', from: '2250700000011', mediaId: 'media-silent' });
    assert.match(reply.text, /entendu/i);
  });

  test('transcript with no price replies with guidance', async () => {
    const { agent, transcriber } = makeAgent();
    transcriber.set('media-noprice', 'Tomates seulement');
    const reply = await agent.handle({ type: 'audio', from: '2250700000012', mediaId: 'media-noprice' });
    assert.match(reply.text, /prix/i);
  });
});

describe('Agent – buyer searches for listings', () => {
  test('cherche returns matching listings', async () => {
    const { agent, transcriber } = makeAgent();
    transcriber.set('media-2', 'Poulet yassa 4500 FCFA');
    await agent.handle({ type: 'audio', from: '2250700000020', mediaId: 'media-2' });

    const reply = await agent.handle({ type: 'text', from: '2250700000021', body: 'cherche poulet' });
    assert.match(reply.text, /Poulet yassa/);
    assert.match(reply.text, /4\s*500/);
  });

  test('cherche with no results says so', async () => {
    const { agent } = makeAgent();
    const reply = await agent.handle({ type: 'text', from: '2250700000022', body: 'cherche mangue' });
    assert.match(reply.text, /Aucun résultat/);
  });

  test('unknown command returns help text', async () => {
    const { agent } = makeAgent();
    const reply = await agent.handle({ type: 'text', from: '2250700000023', body: 'bonjour' });
    assert.match(reply.text, /cherche/);
  });
});

describe('Agent – buyer orders and pays', () => {
  async function setupListing(agent: Agent, transcriber: FakeTranscriber) {
    transcriber.set('media-order', 'Tilapia grillé 3000 FCFA');
    const sellerReply = await agent.handle({ type: 'audio', from: '2250700000030', mediaId: 'media-order' });
    // Extract listing id from reply text
    const match = /réf\. (\d+)/.exec(sellerReply.text);
    assert.ok(match !== null, `could not find listing id in: ${sellerReply.text}`);
    return match[1];
  }

  test('commande shows price and payment options', async () => {
    const { agent, transcriber } = makeAgent();
    const listingId = await setupListing(agent, transcriber);
    const reply = await agent.handle({ type: 'text', from: '2250700000031', body: `commande ${listingId}` });
    assert.match(reply.text, /Tilapia grillé/);
    assert.match(reply.text, /wave/i);
    assert.match(reply.text, /orange/i);
  });

  test('wave <id> charges buyer and holds escrow', async () => {
    const { agent, transcriber, gw } = makeAgent();
    const listingId = await setupListing(agent, transcriber);
    const reply = await agent.handle({ type: 'text', from: '2250700000032', body: `wave ${listingId}` });
    assert.match(reply.text, /retenu/i);
    assert.match(reply.text, /Wave/);
    assert.equal(gw.charges.length, 1);
    assert.equal(gw.charges[0].provider, 'wave');
  });

  test('orange <id> charges buyer via Orange Money', async () => {
    const { agent, transcriber, gw } = makeAgent();
    const listingId = await setupListing(agent, transcriber);
    const reply = await agent.handle({ type: 'text', from: '2250700000033', body: `orange ${listingId}` });
    assert.match(reply.text, /Orange Money/);
    assert.equal(gw.charges[0].provider, 'orange_money');
  });

  test('second wave on same listing by same buyer is blocked', async () => {
    const { agent, transcriber } = makeAgent();
    const listingId = await setupListing(agent, transcriber);
    await agent.handle({ type: 'text', from: '2250700000034', body: `wave ${listingId}` });
    const reply = await agent.handle({ type: 'text', from: '2250700000034', body: `wave ${listingId}` });
    assert.match(reply.text, /déjà une commande/i);
  });

  test('commande for unknown id replies with error', async () => {
    const { agent } = makeAgent();
    const reply = await agent.handle({ type: 'text', from: '2250700000035', body: 'commande 9999' });
    assert.match(reply.text, /introuvable/i);
  });
});

describe('Agent – buyer confirms receipt → payment released', () => {
  test('reçu releases escrow and notifies buyer', async () => {
    const { agent, transcriber, gw } = makeAgent();
    const transcriber2 = transcriber;
    transcriber2.set('media-confirm', 'Foutou 1200 FCFA');
    const sellerReply = await agent.handle({ type: 'audio', from: '2250700000040', mediaId: 'media-confirm' });
    const listingId = /réf\. (\d+)/.exec(sellerReply.text)![1];

    await agent.handle({ type: 'text', from: '2250700000041', body: `wave ${listingId}` });
    const reply = await agent.handle({ type: 'text', from: '2250700000041', body: `reçu ${listingId}` });
    assert.match(reply.text, /paiement.*vendeur|vendeur.*paiement/i);
    assert.equal(gw.transfers.length, 1);
    assert.equal(gw.transfers[0].sellerPhone, '2250700000040');
    assert.equal(gw.transfers[0].amountFcfa, 1200);
  });

  test('reçu without an active order replies with error', async () => {
    const { agent } = makeAgent();
    const reply = await agent.handle({ type: 'text', from: '2250700000042', body: 'reçu 1' });
    assert.match(reply.text, /Aucune commande/i);
  });
});

describe('Agent – buyer cancels → payment refunded', () => {
  test('annuler refunds the buyer', async () => {
    const { agent, transcriber, gw } = makeAgent();
    transcriber.set('media-cancel', 'Gombo 800 FCFA');
    const sellerReply = await agent.handle({ type: 'audio', from: '2250700000050', mediaId: 'media-cancel' });
    const listingId = /réf\. (\d+)/.exec(sellerReply.text)![1];

    await agent.handle({ type: 'text', from: '2250700000051', body: `orange ${listingId}` });
    const reply = await agent.handle({ type: 'text', from: '2250700000051', body: `annuler ${listingId}` });
    assert.match(reply.text, /remboursé/i);
    assert.equal(gw.refunds.length, 1);
    assert.equal(gw.refunds[0].buyerPhone, '2250700000051');
  });
});

// ── HTTP integration with agent ───────────────────────────────────────────────

describe('HTTP – agent wired into server', () => {
  const transcriber = new FakeTranscriber();
  const listings = new ListingStore();
  const gw = new FakePaymentGateway();
  const escrow = new EscrowStore(gw);
  const agent = new Agent(transcriber, listings, escrow);

  const server = createServer({ verifyToken: 'test-token', agent });
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
      server.close((err) => (err ? reject(err) : resolve()));
    });
    server.closeAllConnections();
    await closed;
  });

  function post(body: unknown): Promise<Response> {
    return fetch(`${baseUrl}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  function waPayload(messages: unknown[]): unknown {
    return {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'biz-account',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                messages,
              },
            },
          ],
        },
      ],
    };
  }

  test('audio message → listing created, reply contains product name', async () => {
    transcriber.set('media-http-1', 'Aloco 600 FCFA');
    const payload = waPayload([
      {
        from: '2250700000060',
        id: 'wamid.1',
        timestamp: '1700000100',
        type: 'audio',
        audio: { id: 'media-http-1', mime_type: 'audio/ogg; codecs=opus' },
      },
    ]);
    const res = await post(payload);
    assert.equal(res.status, 200);
    const body = await res.json() as { replies: Array<{ to: string; text: string }> };
    assert.equal(body.replies.length, 1);
    assert.match(body.replies[0].text, /Aloco/);
  });

  test('text "cherche" → search results returned', async () => {
    // listing created in the previous test lives in the same store
    const payload = waPayload([
      {
        from: '2250700000061',
        id: 'wamid.2',
        timestamp: '1700000200',
        type: 'text',
        text: { body: 'cherche aloco' },
      },
    ]);
    const res = await post(payload);
    assert.equal(res.status, 200);
    const body = await res.json() as { replies: Array<{ to: string; text: string }> };
    assert.match(body.replies[0].text, /Aloco/);
  });
});
