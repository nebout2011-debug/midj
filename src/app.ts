import { createServer as createHttpServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';
import type { Agent } from './agent.ts';

export type ServerOptions = {
  verifyToken: string;
  /** When provided, all incoming messages are routed through the agent. */
  agent?: Agent;
};

export type Reply = {
  to: string;
  text: string;
};

const WEBHOOK_PATH = '/webhook';
const MAX_BODY_BYTES = 1048576;
const ALLOW = 'GET, POST';

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sendJson(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  payload: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  if (res.headersSent || res.writableEnded) return;
  const body = JSON.stringify(payload);
  const headers: Record<string, string | number> = {
    'Content-Type': 'application/json; charset=utf-8',
    ...extraHeaders,
  };
  if (req.method === 'HEAD') {
    res.writeHead(status, headers);
    res.end();
    return;
  }
  headers['Content-Length'] = Buffer.byteLength(body, 'utf8');
  res.writeHead(status, headers);
  res.end(body);
}

function tokensEqual(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function handleHandshake(
  req: IncomingMessage,
  res: ServerResponse,
  query: URLSearchParams,
  verifyToken: string,
): void {
  const mode = query.get('hub.mode');
  const token = query.get('hub.verify_token');
  if (mode !== 'subscribe' || token === null || !tokensEqual(token, verifyToken)) {
    sendJson(req, res, 403, { error: 'forbidden' });
    return;
  }
  const challenge = query.get('hub.challenge');
  if (challenge === null || challenge === '') {
    sendJson(req, res, 400, { error: 'missing_challenge' });
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(challenge, 'utf8'),
  });
  res.end(challenge);
}

/**
 * Extract raw messages from a WhatsApp webhook payload.
 * Returns an array of { from, type, body?, mediaId? } objects.
 */
type RawMessage =
  | { from: string; type: 'text'; body: string }
  | { from: string; type: 'audio'; mediaId: string };

function extractMessages(payload: JsonObject): RawMessage[] {
  const out: RawMessage[] = [];
  const entries = payload.entry;
  if (!Array.isArray(entries)) return out;
  for (const entry of entries) {
    if (!isObject(entry) || !Array.isArray(entry.changes)) continue;
    for (const change of entry.changes) {
      if (!isObject(change) || !isObject(change.value)) continue;
      const messages = change.value.messages;
      if (!Array.isArray(messages)) continue;
      for (const message of messages) {
        if (!isObject(message)) continue;
        const from = message.from;
        if (typeof from !== 'string' || from === '') continue;

        if (message.type === 'text') {
          const text = message.text;
          if (!isObject(text) || typeof text.body !== 'string') continue;
          out.push({ from, type: 'text', body: text.body });
        } else if (message.type === 'audio') {
          const audio = message.audio;
          if (!isObject(audio) || typeof audio.id !== 'string') continue;
          out.push({ from, type: 'audio', mediaId: audio.id });
        }
      }
    }
  }
  return out;
}

/**
 * Legacy synchronous path (no agent): echo text messages.
 * Kept so the original webhook tests continue to pass unchanged.
 */
export function collectReplies(payload: JsonObject): Reply[] {
  return extractMessages(payload)
    .filter((m): m is Extract<RawMessage, { type: 'text' }> => m.type === 'text')
    .map((m) => ({ to: m.from, text: 'Midj received: ' + m.body }));
}

/**
 * Agent path: route every message through the agent and collect replies.
 */
async function collectAgentReplies(payload: JsonObject, agent: Agent): Promise<Reply[]> {
  const messages = extractMessages(payload);
  const replies: Reply[] = [];
  for (const m of messages) {
    const reply =
      m.type === 'audio'
        ? await agent.handle({ type: 'audio', from: m.from, mediaId: m.mediaId })
        : await agent.handle({ type: 'text', from: m.from, body: m.body });
    replies.push(reply);
  }
  return replies;
}

function handleBody(req: IncomingMessage, res: ServerResponse, raw: string, agent: Agent | undefined): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    sendJson(req, res, 400, { error: 'invalid_json' });
    return;
  }
  if (
    !isObject(parsed) ||
    parsed.object !== 'whatsapp_business_account' ||
    !Array.isArray(parsed.entry)
  ) {
    sendJson(req, res, 400, { error: 'invalid_payload' });
    return;
  }
  if (agent !== undefined) {
    collectAgentReplies(parsed, agent).then((replies) => {
      sendJson(req, res, 200, { replies });
    }).catch(() => {
      sendJson(req, res, 500, { error: 'internal_error' });
    });
    return;
  }
  sendJson(req, res, 200, { replies: collectReplies(parsed) });
}

function handleMessages(req: IncomingMessage, res: ServerResponse, agent: Agent | undefined): void {
  const chunks: Buffer[] = [];
  let received = 0;
  let done = false;

  const onData = (chunk: Buffer): void => {
    if (done) return;
    received += chunk.length;
    if (received > MAX_BODY_BYTES) {
      done = true;
      chunks.length = 0;
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.pause();
      sendJson(req, res, 413, { error: 'payload_too_large' }, { Connection: 'close' });
      return;
    }
    chunks.push(chunk);
  };

  const onEnd = (): void => {
    if (done) return;
    done = true;
    let raw: string;
    try {
      raw = Buffer.concat(chunks).toString('utf8');
    } catch {
      sendJson(req, res, 400, { error: 'invalid_json' });
      return;
    }
    handleBody(req, res, raw, agent);
  };

  req.on('data', onData);
  req.on('end', onEnd);
}

export function createServer(options: { verifyToken: string; agent?: Agent }): Server {
  const verifyToken = options.verifyToken;
  const agent = options.agent;

  return createHttpServer((req, res) => {
    // A broken client connection must never crash the process.
    req.on('error', () => {
      if (!res.writableEnded) res.destroy();
    });

    const url = req.url ?? '';
    const queryStart = url.indexOf('?');
    const path = queryStart === -1 ? url : url.slice(0, queryStart);

    if (path !== WEBHOOK_PATH) {
      sendJson(req, res, 404, { error: 'not_found' });
      return;
    }

    const method = req.method;
    if (method === 'GET') {
      const query = new URLSearchParams(queryStart === -1 ? '' : url.slice(queryStart + 1));
      handleHandshake(req, res, query, verifyToken);
      return;
    }
    if (method === 'POST') {
      handleMessages(req, res, agent);
      return;
    }
    sendJson(req, res, 405, { error: 'method_not_allowed' }, { Allow: ALLOW });
  });
}
