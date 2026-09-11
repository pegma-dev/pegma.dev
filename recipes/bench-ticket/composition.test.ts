import { fixedClock, type PrincipalId } from '@pegma/spine';
import { createMemoryStore } from '@pegma/storage-core';
import { describe, expect, it } from 'vitest';
import {
  BENCH_TICKET,
  createBenchTicketComposition,
  createBenchTicketMailRenderer,
  openBenchTicketSession,
  type BenchTicketMailDelivery,
} from './composition';

/** Deterministic 32-byte secret, base64 — tests only. */
const TEST_SECRET = btoa(String.fromCharCode(...new Uint8Array(32).fill(11)));

function recordingMailDelivery(): BenchTicketMailDelivery & {
  readonly sent: { readonly recipient: string; readonly subject: string; readonly text: string }[];
} {
  const sent: { recipient: string; subject: string; text: string }[] = [];
  return {
    sent,
    provider: {
      async send(request) {
        sent.push({
          recipient: request.mail.recipient,
          subject: request.mail.subject,
          text: request.mail.text,
        });
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

function makeComposition(mail = recordingMailDelivery()) {
  return {
    composition: createBenchTicketComposition({
      store: createMemoryStore(),
      origin: BENCH_TICKET.defaultOrigin,
      emailCodeSecretBase64: TEST_SECRET,
      mailDelivery: mail,
      clock: fixedClock('2026-09-11T12:00:00.000Z'),
    }),
    mail,
  };
}

describe('support-queue-slice (Bench Ticket)', () => {
  it('wires Identity, Sessions, Support Desk, Health, and a mail worker', async () => {
    const { composition } = makeComposition();
    const health = await composition.health();
    expect(health.status).toBe(200);
    expect(health.body.ok).toBe(true);
    expect(health.body.service).toBe(BENCH_TICKET.service);
    expect(health.body.checks.process?.status).toBe('ok');
    expect(health.body.checks.storage?.status).toBe('ok');

    const user = await composition.identity.provisionVerifiedUser({
      principalId: 'prn_bench_member' as PrincipalId,
      email: 'member@bench.example',
    });
    const claims = await composition.identity.claimsFor(user.principalId);
    expect(claims).toMatchObject({
      issuer: BENCH_TICKET.defaultOrigin,
      subject: user.principalId,
      emailVerified: true,
    });

    const sessionId = 'b'.repeat(43);
    await openBenchTicketSession(composition, sessionId, claims);
    const session = await composition.sessions.get(sessionId);
    expect(session?.principalId).toBe(user.principalId);
  });

  it('starts email-code account creation and drains the code through the mail worker', async () => {
    const { composition, mail } = makeComposition();
    const started = await composition.identity.beginAccountCreation(
      'new.member@bench.example',
      '203.0.113.20',
    );
    expect(typeof started.codeHandle).toBe('string');
    expect(started.codeHandle.length).toBeGreaterThan(8);

    const page = await composition.mailWorker.runSendPage({ limit: 20 });
    expect(page.examined).toBeGreaterThan(0);
    expect(mail.sent.length).toBeGreaterThan(0);
    expect(mail.sent[0]?.subject).toMatch(/Your Bench Ticket code is /);
    expect(mail.sent[0]?.text).toMatch(/Your Bench Ticket code is /);
  });

  it('creates, lists, and replies to a customer ticket for a signed-in principal', async () => {
    const { composition } = makeComposition();
    const user = await composition.identity.provisionVerifiedUser({
      principalId: 'prn_bench_filer' as PrincipalId,
      email: 'filer@bench.example',
    });
    const access = composition.customerAccess(user.principalId);
    const ticketId = 'ticket-bench-1';
    const created = await composition.support.createCustomerTicket(access, {
      commandId: 'cmd-create-1',
      correlationId: 'corr-create-1',
      ticketId,
      messageId: 'msg-1',
      subject: 'Laser cutter jammed',
      body: 'The bed will not home.',
      category: 'tools',
    });
    expect(created.ticket.id).toBe(ticketId);
    expect(created.ticket.subject).toMatch(/Laser cutter/);

    const listed = await composition.support.listCustomerTickets(access);
    expect(listed.some((row) => row.id === ticketId)).toBe(true);

    const replied = await composition.support.replyToCustomerTicket(access, {
      commandId: 'cmd-reply-1',
      correlationId: 'corr-reply-1',
      ticketId,
      messageId: 'msg-2',
      body: 'I cleared the gantry. Still stuck.',
    });
    expect(replied.messages.length).toBeGreaterThan(1);
  });

  it('refuses a missing or invalid email-code secret', () => {
    expect(() =>
      createBenchTicketComposition({
        store: createMemoryStore(),
        origin: BENCH_TICKET.defaultOrigin,
        emailCodeSecretBase64: 'short',
        mailDelivery: recordingMailDelivery(),
      }),
    ).toThrow(/missing or invalid/);
  });
});
