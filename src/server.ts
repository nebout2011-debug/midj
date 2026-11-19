import process from 'node:process';
import { createServer } from './app.ts';

const DEFAULT_PORT = 3000;

// Error lines are fixed strings so raw environment values are never echoed.
function fail(message: string): never {
  process.stderr.write(message + '\n');
  process.exit(1);
}

function readPort(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_PORT;
  if (!/^[0-9]+$/.test(raw)) {
    fail('Invalid PORT: it must contain only digits 0-9 and be between 1 and 65535');
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    fail('Invalid PORT: it must contain only digits 0-9 and be between 1 and 65535');
  }
  return port;
}

const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN;
if (verifyToken === undefined || verifyToken === '') {
  fail('WHATSAPP_VERIFY_TOKEN is missing or empty');
}
const port = readPort(process.env.PORT);

const server = createServer({ verifyToken });

server.on('error', (error: NodeJS.ErrnoException) => {
  const code = typeof error.code === 'string' ? error.code : 'unknown error';
  fail(`midj could not listen on port ${port}: ${code}`);
});

server.listen(port, () => {
  process.stdout.write(`midj listening on port ${port}\n`);
});
