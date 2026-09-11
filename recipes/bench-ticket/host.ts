/**
 * Node entrypoint for the Bench Ticket demo (Local Docker / Azure Container
 * Apps / AWS App Runner). Cloudflare uses `cloudflare/worker.ts` instead.
 *
 * Store: in-memory (default). Cloud runbooks replace `createMemoryStore()`
 * with the matching adapter factory — same `createBenchTicketComposition`.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { pathToFileURL } from 'node:url';
import { createMemoryStore } from '@pegma/storage-core';
import {
  BENCH_TICKET,
  createBenchTicketComposition,
  createBenchTicketMailRenderer,
} from './composition';
import { handleBenchTicketRequest } from './handler';
import {
  createCatcherReconciliation,
  createConsoleMailProvider,
} from './mail-catcher';
import { createMailpitSmtpProvider } from './mail-smtp';

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function mailDelivery() {
  const renderer = createBenchTicketMailRenderer();
  const reconciliation = createCatcherReconciliation();
  const catcher = process.env.BENCH_TICKET_MAIL_CATCHER ?? 'mailpit';
  if (catcher === 'console') {
    return {
      provider: createConsoleMailProvider(),
      reconciliation,
      renderer,
    };
  }
  return {
    provider: createMailpitSmtpProvider({
      host: process.env.MAILPIT_SMTP_HOST ?? '127.0.0.1',
      port: Number.parseInt(process.env.MAILPIT_SMTP_PORT ?? '1025', 10),
      from: process.env.BENCH_TICKET_EMAIL_FROM ?? 'bench-ticket@localhost',
    }),
    reconciliation,
    renderer,
  };
}

export function createBenchTicketNodeHandler() {
  const origin = process.env.BENCH_TICKET_ORIGIN ?? BENCH_TICKET.defaultOrigin;
  const composition = createBenchTicketComposition({
    store: createMemoryStore(),
    origin,
    emailCodeSecretBase64: requiredEnv('BENCH_TICKET_EMAIL_CODE_SECRET_BASE64'),
    mailDelivery: mailDelivery(),
  });

  return {
    composition,
    async handle(request: Request): Promise<Response> {
      return handleBenchTicketRequest(request, composition);
    },
  };
}

async function requestFromNode(
  req: IncomingMessage,
  origin: string,
): Promise<Request> {
  const url = new URL(req.url ?? '/', origin);
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) headers.set(name, value.join(', '));
    else headers.set(name, value);
  }
  const method = req.method ?? 'GET';
  if (method === 'GET' || method === 'HEAD') {
    return new Request(url, { method, headers });
  }
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const body = new Uint8Array(Buffer.concat(chunks));
  return new Request(url, {
    method,
    headers,
    body,
    duplex: 'half',
  });
}

async function writeNodeResponse(
  res: ServerResponse,
  response: Response,
): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  res.writeHead(response.status, headers);
  const body = Buffer.from(await response.arrayBuffer());
  res.end(body);
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (typeof entry !== 'string' || entry.length === 0) return false;
  return import.meta.url === pathToFileURL(entry).href;
}

if (isMainModule()) {
  const port = Number.parseInt(process.env.PORT ?? '8787', 10);
  const origin = process.env.BENCH_TICKET_ORIGIN ?? BENCH_TICKET.defaultOrigin;
  const runtime = createBenchTicketNodeHandler();
  const server = createServer((req, res) => {
    void requestFromNode(req, origin)
      .then((request) => runtime.handle(request))
      .then((response) => writeNodeResponse(res, response))
      .catch((error: unknown) => {
        console.error(error);
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'internal_error' }));
      });
  });

  server.listen(port, '0.0.0.0', () => {
    console.log(`Bench Ticket listening on ${origin} (bound 0.0.0.0:${port})`);
  });
}
