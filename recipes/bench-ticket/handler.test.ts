import { fixedClock } from '@pegma/spine';
import { createMemoryStore } from '@pegma/storage-core';
import { SupportDeskQueueCapacityError } from '@pegma/support-desk-application';
import { describe, expect, it } from 'vitest';
import {
  BENCH_TICKET,
  createBenchTicketComposition,
  createBenchTicketMailRenderer,
  type BenchTicketMailDelivery,
} from './composition';
import { handleBenchTicketRequest, SESSION_COOKIE } from './handler';

const TEST_SECRET = btoa(String.fromCharCode(...new Uint8Array(32).fill(11)));
const ORIGIN = BENCH_TICKET.defaultOrigin;

function recordingMail(): BenchTicketMailDelivery & {
  readonly sent: { readonly subject: string; readonly text: string }[];
} {
  const sent: { subject: string; text: string }[] = [];
  return {
    sent,
    provider: {
      async send(request) {
        sent.push({ subject: request.mail.subject, text: request.mail.text });
        return { providerMessageRef: `stub-${sent.length}` };
      },
    },
    reconciliation: {
      async reconcile() {
        return { status: 'delivered' as const };
      },
    },
    renderer: createBenchTicketMailRenderer(),
  };
}

function cookieFrom(response: Response): string {
  const header = response.headers.get('set-cookie') ?? '';
  const match = new RegExp(`${SESSION_COOKIE}=([^;]+)`).exec(header);
  if (!match?.[1]) throw new Error('missing session cookie');
  return `${SESSION_COOKIE}=${match[1]}`;
}

describe('Bench Ticket HTTP host', () => {
  it('serves health, email-code sign-up, and a ticket round-trip', async () => {
    const mail = recordingMail();
    const composition = createBenchTicketComposition({
      store: createMemoryStore(),
      origin: ORIGIN,
      emailCodeSecretBase64: TEST_SECRET,
      mailDelivery: mail,
      clock: fixedClock('2026-09-11T12:00:00.000Z'),
    });

    const health = await handleBenchTicketRequest(
      new Request(`${ORIGIN}/health`),
      composition,
    );
    expect(health.status).toBe(200);
    const healthBody = (await health.json()) as { ok: boolean; service: string };
    expect(healthBody.ok).toBe(true);
    expect(healthBody.service).toBe(BENCH_TICKET.service);

    const home = await handleBenchTicketRequest(
      new Request(`${ORIGIN}/`),
      composition,
    );
    expect(home.status).toBe(200);
    expect(await home.text()).toMatch(/Bench Ticket/);

    const begin = await handleBenchTicketRequest(
      new Request(`${ORIGIN}/api/auth/begin`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'member@bench.example', flow: 'create' }),
      }),
      composition,
    );
    expect(begin.status).toBe(200);
    const started = (await begin.json()) as { codeHandle: string };
    expect(mail.sent.length).toBeGreaterThan(0);
    const codeMatch = /Your Bench Ticket code is (\d{8})/.exec(mail.sent[0]?.subject ?? '');
    expect(codeMatch?.[1]).toMatch(/^\d{8}$/);

    const finish = await handleBenchTicketRequest(
      new Request(`${ORIGIN}/api/auth/finish`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          flow: 'create',
          codeHandle: started.codeHandle,
          code: codeMatch?.[1],
        }),
      }),
      composition,
    );
    expect(finish.status).toBe(200);
    const cookie = cookieFrom(finish);

    const filed = await handleBenchTicketRequest(
      new Request(`${ORIGIN}/api/tickets`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie,
        },
        body: JSON.stringify({
          subject: 'Laser cutter jammed',
          body: 'The bed will not home.',
          category: 'tools',
        }),
      }),
      composition,
    );
    expect(filed.status).toBe(201);
    const created = (await filed.json()) as {
      ticket: { id: string; subject: string };
    };
    expect(created.ticket.subject).toMatch(/Laser cutter/);

    const listed = await handleBenchTicketRequest(
      new Request(`${ORIGIN}/api/tickets`, { headers: { cookie } }),
      composition,
    );
    expect(listed.status).toBe(200);
    const queue = (await listed.json()) as { tickets: { id: string }[] };
    expect(queue.tickets.some((row) => row.id === created.ticket.id)).toBe(true);

    const replied = await handleBenchTicketRequest(
      new Request(`${ORIGIN}/api/tickets/${created.ticket.id}/replies`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie,
        },
        body: JSON.stringify({ body: 'Cleared the gantry. Still stuck.' }),
      }),
      composition,
    );
    expect(replied.status).toBe(200);
    const view = (await replied.json()) as { messages: unknown[] };
    expect(view.messages.length).toBeGreaterThan(1);
  });

  it('renders ticket subjects with textContent, not innerHTML', async () => {
    const composition = createBenchTicketComposition({
      store: createMemoryStore(),
      origin: ORIGIN,
      emailCodeSecretBase64: TEST_SECRET,
      mailDelivery: recordingMail(),
      clock: fixedClock('2026-09-11T12:00:00.000Z'),
    });
    const home = await handleBenchTicketRequest(
      new Request(`${ORIGIN}/`),
      composition,
    );
    const html = await home.text();
    expect(html).not.toMatch(/innerHTML/);
    expect(html).toContain('title.textContent');
    expect(html).toContain('status.textContent');
    expect(html).toContain('dataset.reply');
  });

  it('treats a malformed session cookie as unauthenticated, not 500', async () => {
    const composition = createBenchTicketComposition({
      store: createMemoryStore(),
      origin: ORIGIN,
      emailCodeSecretBase64: TEST_SECRET,
      mailDelivery: recordingMail(),
      clock: fixedClock('2026-09-11T12:00:00.000Z'),
    });
    const me = await handleBenchTicketRequest(
      new Request(`${ORIGIN}/api/me`, {
        headers: { cookie: `${SESSION_COOKIE}=%ZZ` },
      }),
      composition,
    );
    expect(me.status).toBe(401);
    expect(await me.json()).toEqual({ error: 'unauthenticated' });
  });

  it('refuses a malformed ticket id with 400, not 500', async () => {
    const mail = recordingMail();
    const composition = createBenchTicketComposition({
      store: createMemoryStore(),
      origin: ORIGIN,
      emailCodeSecretBase64: TEST_SECRET,
      mailDelivery: mail,
      clock: fixedClock('2026-09-11T12:00:00.000Z'),
    });
    const begin = await handleBenchTicketRequest(
      new Request(`${ORIGIN}/api/auth/begin`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'member@bench.example', flow: 'create' }),
      }),
      composition,
    );
    const started = (await begin.json()) as { codeHandle: string };
    const codeMatch = /Your Bench Ticket code is (\d{8})/.exec(mail.sent[0]?.subject ?? '');
    const finish = await handleBenchTicketRequest(
      new Request(`${ORIGIN}/api/auth/finish`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          flow: 'create',
          codeHandle: started.codeHandle,
          code: codeMatch?.[1],
        }),
      }),
      composition,
    );
    const cookie = cookieFrom(finish);
    const view = await handleBenchTicketRequest(
      new Request(`${ORIGIN}/api/tickets/%ZZ`, { headers: { cookie } }),
      composition,
    );
    expect(view.status).toBe(400);
    expect(await view.json()).toEqual({ error: 'invalid_ticket_id' });
  });

  it('maps SupportDeskQueueCapacityError to 503, not 500', async () => {
    const mail = recordingMail();
    const composition = createBenchTicketComposition({
      store: createMemoryStore(),
      origin: ORIGIN,
      emailCodeSecretBase64: TEST_SECRET,
      mailDelivery: mail,
      clock: fixedClock('2026-09-11T12:00:00.000Z'),
    });
    const begin = await handleBenchTicketRequest(
      new Request(`${ORIGIN}/api/auth/begin`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'member@bench.example', flow: 'create' }),
      }),
      composition,
    );
    const started = (await begin.json()) as { codeHandle: string };
    const codeMatch = /Your Bench Ticket code is (\d{8})/.exec(mail.sent[0]?.subject ?? '');
    const finish = await handleBenchTicketRequest(
      new Request(`${ORIGIN}/api/auth/finish`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          flow: 'create',
          codeHandle: started.codeHandle,
          code: codeMatch?.[1],
        }),
      }),
      composition,
    );
    const cookie = cookieFrom(finish);
    const support = composition.support as unknown as {
      listCustomerTickets: () => Promise<never>;
    };
    support.listCustomerTickets = async () => {
      throw new SupportDeskQueueCapacityError('physical_rows', 1);
    };
    const listed = await handleBenchTicketRequest(
      new Request(`${ORIGIN}/api/tickets`, { headers: { cookie } }),
      composition,
    );
    expect(listed.status).toBe(503);
    expect(await listed.json()).toEqual({ error: 'queue_unavailable' });
  });
});
