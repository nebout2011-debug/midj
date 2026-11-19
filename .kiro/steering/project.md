# Midj – project steering

## What this is
Midj is a WhatsApp marketplace agent for Abidjan. Sellers record voice notes to list products; buyers search, order, and pay via mobile money (Wave or Orange Money). Payments are held in escrow and released to the seller only after the buyer confirms receipt.

## Stack
- **Runtime**: Node.js ≥ 22.18, ESM (`"type": "module"`)
- **Language**: TypeScript 5 — `noEmit`, `NodeNext` module resolution, strict mode, `.ts` extensions in imports
- **HTTP**: raw `node:http` — no Express or other framework
- **Tests**: `node:test` + `node:assert/strict` — no Jest, Vitest, or other test library
- **Dependencies**: zero runtime npm dependencies (Node built-ins only)

## Repository layout
```
src/
  server.ts        – process entry point (reads env vars, calls createServer)
  app.ts           – HTTP server factory; webhook handshake + message routing
  agent.ts         – core loop: routes WhatsApp messages to listings/payments
  listings.ts      – parseTranscript, ListingStore (in-memory)
  payments.ts      – PaymentGateway interface, FakePaymentGateway, EscrowStore
  transcription.ts – Transcriber interface, FakeTranscriber
test/
  webhook.test.ts  – original 10 webhook/HTTP tests
  agent.test.ts    – 35 tests covering listings, payments, agent, HTTP integration
```

## Key conventions
- `createServer(options)` in `app.ts` accepts an optional `agent` field. Without it the server echoes text messages (legacy path, keeps existing webhook tests passing). With it, every message is routed through `Agent.handle()`.
- Transcription and payment sit behind interfaces with fake implementations so all tests run without network calls, real credentials, or real money.
- Escrow lifecycle: `held → released` (buyer confirms receipt) or `held → refunded` (buyer cancels).
- French is the user-facing language for all agent replies.
- Parser (`parseTranscript`) extracts product name and price from a voice transcript using two regexes: one for explicit currency suffixes (fcfa/cfa/f/fr) and one for a bare trailing integer.

## Running
```sh
# Tests (45 total)
npm test

# Dev server (requires WHATSAPP_VERIFY_TOKEN env var)
WHATSAPP_VERIFY_TOKEN=secret npm start
```

## What comes next (not yet built)
- Persistent storage (listings and escrow survive restarts)
- Real transcription adapter (Whisper / AssemblyAI)
- Real payment adapters (Wave API, Orange Money API)
- Sending replies back to WhatsApp (outbound Messages API calls)
- Seller deduplication (prevent relisting the same product within a short window)
- Multi-language support (French + Dioula + Nouchi)
