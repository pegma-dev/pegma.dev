import { describe, expect, it } from 'vitest';
import {
  GITHUB_SIGNATURE_FIXTURE,
  verifyGitHubWebhookSignature,
} from './github-webhook-signature';

async function sign(secret: string, body: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, body as BufferSource),
  );
  return `sha256=${[...mac].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

describe('verifyGitHubWebhookSignature', () => {
  it('accepts GitHub published fixture', async () => {
    const body = new TextEncoder().encode(GITHUB_SIGNATURE_FIXTURE.payload);
    await expect(
      verifyGitHubWebhookSignature(
        GITHUB_SIGNATURE_FIXTURE.secret,
        GITHUB_SIGNATURE_FIXTURE.signatureHeader,
        body,
      ),
    ).resolves.toBe(true);
  });

  it('rejects missing, malformed, and incorrect signatures', async () => {
    const body = new TextEncoder().encode('Hello, World!');
    const secret = GITHUB_SIGNATURE_FIXTURE.secret;
    const good = await sign(secret, body);

    await expect(
      verifyGitHubWebhookSignature(secret, null, body),
    ).resolves.toBe(false);
    await expect(
      verifyGitHubWebhookSignature(secret, 'sha1=abc', body),
    ).resolves.toBe(false);
    await expect(
      verifyGitHubWebhookSignature(secret, 'sha256=zz', body),
    ).resolves.toBe(false);
    await expect(
      verifyGitHubWebhookSignature(secret, good.replace(/.$/, '0'), body),
    ).resolves.toBe(false);
    await expect(
      verifyGitHubWebhookSignature('wrong-secret', good, body),
    ).resolves.toBe(false);
  });
});
