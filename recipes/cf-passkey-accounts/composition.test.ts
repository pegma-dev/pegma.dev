import type { PrincipalId } from '@pegma/spine';
import { describe, expect, it } from 'vitest';
import {
  createNorthshelfComposition,
  openNorthshelfSession,
  NORTHSHELF_RP,
} from './composition';

/** Deterministic 32-byte secret, base64 — tests only. */
const TEST_SECRET = btoa(String.fromCharCode(...new Uint8Array(32).fill(11)));

describe('cf-passkey-accounts (Northshelf Branch)', () => {
  it('wires Identity, Sessions, durable rate limits, and claims projection', async () => {
    const composition = createNorthshelfComposition({
      emailCodeSecretBase64: TEST_SECRET,
    });

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
    await openNorthshelfSession(
      composition,
      sessionId,
      user.principalId,
      claims,
    );
    const session = await composition.sessions.get(sessionId);
    expect(session?.principalId).toBe(user.principalId);
    expect(session?.data).toContain('authorizationLink');
  });

  it('starts passkey registration for an existing user (ceremony is host/browser)', async () => {
    const composition = createNorthshelfComposition({
      emailCodeSecretBase64: TEST_SECRET,
    });
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

  it('starts email-code account creation without passwords', async () => {
    const composition = createNorthshelfComposition({
      emailCodeSecretBase64: TEST_SECRET,
    });

    const started = await composition.identity.beginAccountCreation(
      'new.patron@northshelf.example',
      '203.0.113.20',
    );
    expect(typeof started.codeHandle).toBe('string');
    expect(started.codeHandle.length).toBeGreaterThan(8);
    expect(typeof started.expiresAt).toBe('string');
  });

  it('refuses an unconfigured email-code secret', () => {
    expect(() =>
      createNorthshelfComposition({ emailCodeSecretBase64: 'short' }),
    ).toThrow(/email-code secret/);
  });
});
