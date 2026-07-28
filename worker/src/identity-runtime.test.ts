import { createMemoryStore } from '@pegma/storage-core';
import type { Logger, PrincipalId } from '@pegma/spine';
import { describe, expect, it, vi } from 'vitest';
import {
  classifyCloudflareEmailFailure,
  createCloudflareEmailMailPorts,
} from './cloudflare-email-mail';
import {
  createIdentityRuntime,
  type IdentityCompositionOptions,
} from './identity-runtime';

const logger: Logger = { log: vi.fn() };
const secret = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));

function options(
  overrides: Partial<IdentityCompositionOptions> = {},
): IdentityCompositionOptions {
  return {
    store: createMemoryStore(),
    emailCodeSecretBase64: secret,
    emailFrom: 'Pegma <identity@pegma.dev>',
    emailEnabled: false,
    ...overrides,
  };
}

function mutation(path: string, body: unknown): Request {
  return new Request(`https://pegma.dev${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'https://pegma.dev',
      'Sec-Fetch-Site': 'same-origin',
      'CF-Connecting-IP': '192.0.2.1',
    },
    body: JSON.stringify(body),
  });
}

describe('published Identity composition', () => {
  it('composes Identity, the claims adapter, Sessions, and the account API', async () => {
    const runtime = createIdentityRuntime(options(), logger);
    const user = await runtime.identity.provisionVerifiedUser({
      principalId: 'principal-runtime' as PrincipalId,
      email: 'person@example.test',
    });
    const sessionId = 'a'.repeat(43);
    const csrfToken = 'b'.repeat(43);
    await runtime.sessions.create(sessionId, {
      principalId: user.principalId,
      data: JSON.stringify({
        version: 1,
        csrfToken,
        issuer: 'https://pegma.dev',
        subject: user.principalId,
      }),
    });

    const capabilities = await runtime.api(
      new Request('https://pegma.dev/api/identity/capabilities'),
    );
    const account = await runtime.api(
      new Request('https://pegma.dev/api/identity/account', {
        headers: { Cookie: `__Host-pegma_session=${sessionId}` },
      }),
    );

    expect(await capabilities.json()).toMatchObject({
      passkeys: true,
      emailCode: false,
    });
    expect(account.status).toBe(200);
    expect(await account.json()).toMatchObject({
      account: {
        subject: user.principalId,
        email: 'person@example.test',
      },
      csrfToken,
    });
  });

  it('commits account-creation Mail before the scheduled provider call', async () => {
    const provider = vi.fn<typeof fetch>(async () =>
      Response.json({ id: '49a3999c-0ce1-4ea6-ab68-afcd6dc2e794' }),
    );
    const runtime = createIdentityRuntime(
      options({
        emailEnabled: true,
        resendApiKey: 're_test_secret',
        fetch: provider,
      }),
      logger,
    );

    const started = await runtime.api(
      mutation('/api/identity/email-code/account/options', {
        email: 'new@example.test',
      }),
    );

    expect(started.status).toBe(200);
    expect(await started.json()).toMatchObject({
      codeHandle: expect.any(String),
      delivery: 'email',
    });
    expect(provider).not.toHaveBeenCalled();
    expect(runtime.mailWorker).not.toBeNull();

    const page = await runtime.mailWorker!.runSendPage({ limit: 100 });
    expect(page.results).toHaveLength(1);
    expect(page.results[0]).toMatchObject({ status: 'accepted' });
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it('accepts a host-selected provider adapter without changing Identity', async () => {
    const send = vi.fn(async () => ({ messageId: 'cf-message-runtime' }));
    const ports = createCloudflareEmailMailPorts({
      binding: { send } as unknown as SendEmail,
      from: 'identity@pegma.dev',
      acceptDoubleSendRisk: true,
    });
    const runtime = createIdentityRuntime(
      options({
        emailEnabled: true,
        mailDelivery: {
          ...ports,
          classifyFailure: classifyCloudflareEmailFailure,
        },
      }),
      logger,
    );

    const started = await runtime.api(
      mutation('/api/identity/email-code/account/options', {
        email: 'cloudflare@example.test',
      }),
    );
    expect(started.status).toBe(200);
    expect(send).not.toHaveBeenCalled();

    const page = await runtime.mailWorker!.runSendPage({ limit: 100 });
    expect(page.results[0]).toMatchObject({ status: 'accepted' });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('rejects noncanonical or undersized HMAC secrets', () => {
    expect(() =>
      createIdentityRuntime(
        options({ emailCodeSecretBase64: btoa('too short') }),
        logger,
      ),
    ).toThrow(/secret/u);
    expect(() =>
      createIdentityRuntime(
        options({ emailCodeSecretBase64: `${secret.slice(0, -1)}\n` }),
        logger,
      ),
    ).toThrow(/secret/u);
  });
});
