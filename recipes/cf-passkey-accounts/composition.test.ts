import { fixedClock, type PrincipalId } from '@pegma/spine';
import { createMemoryStore } from '@pegma/storage-core';
import { describe, expect, it } from 'vitest';
import {
  createNorthshelfComposition,
  openNorthshelfSession,
  NORTHSHELF_RP,
  type NorthshelfMailDelivery,
} from './composition';

/** Deterministic 32-byte secret, base64 — tests only. */
const TEST_SECRET = btoa(String.fromCharCode(...new Uint8Array(32).fill(11)));

function recordingMailDelivery(): NorthshelfMailDelivery & {
  readonly sent: { readonly recipient: string; readonly subject: string }[];
} {
  const sent: { recipient: string; subject: string }[] = [];
  return {
    sent,
    provider: {
      async send(request) {
        sent.push({
          recipient: request.mail.recipient,
          subject: request.mail.subject,
        });
        return { providerMessageRef: `stub-${sent.length}` };
      },
    },
    reconciliation: {
      async reconcile() {
        return { status: 'delivered' as const };
      },
    },
    renderer: {
      async render(content) {
        if (content.expired) {
          throw new Error('code expired');
        }
        if (content.purpose === 'email_changed') {
          return {
            subject: 'Northshelf email changed',
            text: `Changed to ${content.newEmail ?? ''}`,
          };
        }
        return {
          subject: 'Northshelf sign-in code',
          text: `Your code is ${content.code ?? 'unknown'}`,
        };
      },
    },
  };
}

/** Explicit memory store + fixed clock + recording mail — never silent defaults. */
function makeComposition(mail = recordingMailDelivery()) {
  return {
    composition: createNorthshelfComposition({
      store: createMemoryStore(),
      emailCodeSecretBase64: TEST_SECRET,
      mailDelivery: mail,
      clock: fixedClock('2026-07-29T12:00:00.000Z'),
    }),
    mail,
  };
}

describe('cf-passkey-accounts (Northshelf Branch)', () => {
  it('wires Identity, Sessions, durable rate limits, claims projection, and mail worker', async () => {
    const { composition } = makeComposition();

    const user = await composition.identity.provisionVerifiedUser({
      principalId: 'prn_northshelf_patron' as PrincipalId,
      email: 'patron@northshelf.example',
    });

    const claims = await composition.identity.claimsFor(user.principalId);
    expect(claims).toMatchObject({
      issuer: NORTHSHELF_RP.issuer,
      subject: user.principalId,
      emailVerified: true,
    });

    const link = composition.identityLinkFromClaims(claims);
    expect(link.issuer).toBe(NORTHSHELF_RP.issuer);
    expect(link.subject).toBe(user.principalId);

    const sessionId = 'n'.repeat(43);
    await openNorthshelfSession(composition, sessionId, claims);
    const session = await composition.sessions.get(sessionId);
    expect(session?.principalId).toBe(user.principalId);
    expect(session?.data).toContain('authorizationLink');
    expect(composition.mailWorker).toBeDefined();
  });

  it('starts passkey registration for an existing user (ceremony is host/browser)', async () => {
    const { composition } = makeComposition();
    const user = await composition.identity.provisionVerifiedUser({
      principalId: 'prn_northshelf_staff' as PrincipalId,
      email: 'staff@northshelf.example',
    });

    const start = await composition.identity.beginPasskeyRegistration(
      user.principalId,
      '203.0.113.10',
    );
    expect(start.options.rp.id).toBe(NORTHSHELF_RP.rpID);
    expect(start.options.rp.name).toBe(NORTHSHELF_RP.rpName);
    expect(typeof start.challengeHandle).toBe('string');
  });

  it('starts email-code account creation and drains delivery through the mail worker', async () => {
    const { composition, mail } = makeComposition();

    const started = await composition.identity.beginAccountCreation(
      'new.patron@northshelf.example',
      '203.0.113.20',
    );
    expect(typeof started.codeHandle).toBe('string');
    expect(started.codeHandle.length).toBeGreaterThan(8);
    expect(typeof started.expiresAt).toBe('string');

    // Host schedule: drain Identity mail outbox after begin* commits a job.
    const page = await composition.mailWorker.runSendPage({ limit: 20 });
    expect(page.examined).toBeGreaterThan(0);
    expect(mail.sent.length).toBeGreaterThan(0);
    expect(mail.sent[0]?.subject).toMatch(/code/i);
  });

  it('refuses a missing or invalid email-code secret', () => {
    expect(() =>
      createNorthshelfComposition({
        store: createMemoryStore(),
        emailCodeSecretBase64: 'short',
        mailDelivery: recordingMailDelivery(),
      }),
    ).toThrow(/missing or invalid/);
  });
});
