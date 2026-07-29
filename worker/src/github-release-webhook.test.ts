import { createMemoryStore } from '@pegma/storage-core';
import type { Logger } from '@pegma/spine';
import { describe, expect, it, vi } from 'vitest';
import {
  componentReleaseCollection,
  componentReleaseKey,
} from './component-release';
import {
  extractReleaseEventFacts,
  handleGitHubReleaseWebhook,
  MAX_GITHUB_WEBHOOK_BODY_BYTES,
  type GitHubReleaseWebhookConfig,
} from './github-release-webhook';

const SECRET = "It's a Secret to Everybody";
const ORG_ID = '309286193';
const REPO_ID = '1313911960';
const DELIVERY = '11111111-1111-4111-8111-111111111111';
const NOW = '2026-07-28T18:00:00.000Z';

const logger: Logger = { log: vi.fn() };

const config: GitHubReleaseWebhookConfig = {
  webhookSecret: SECRET,
  organizationId: ORG_ID,
  allowedRepositoryIds: new Set([REPO_ID]),
};

async function signatureFor(body: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, body as BufferSource),
  );
  return `sha256=${[...mac].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

function releasePayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    action: 'published',
    organization: { id: Number(ORG_ID) },
    repository: {
      id: Number(REPO_ID),
      name: 'webhooks',
      owner: { id: Number(ORG_ID) },
    },
    release: {
      id: 100,
      tag_name: 'v0.1.0',
      published_at: '2026-07-28T12:00:00.000Z',
      draft: false,
      prerelease: false,
      html_url: 'https://evil.example/ignore',
      body: 'should never be stored',
      author: { login: 'someone' },
    },
    ...overrides,
  };
}

async function signedRequest(
  payload: unknown,
  headers: Record<string, string> = {},
): Promise<Request> {
  const bodyText = JSON.stringify(payload);
  const body = new TextEncoder().encode(bodyText);
  return new Request('https://pegma.dev/api/webhooks/github/releases', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-GitHub-Event': 'release',
      'X-GitHub-Delivery': DELIVERY,
      'X-Hub-Signature-256': await signatureFor(body),
      ...headers,
    },
    body,
  });
}

describe('extractReleaseEventFacts', () => {
  it('extracts only projection fields', () => {
    expect(extractReleaseEventFacts(releasePayload())).toEqual({
      action: 'published',
      repositoryId: REPO_ID,
      repositoryName: 'webhooks',
      releaseId: '100',
      tagName: 'v0.1.0',
      publishedAt: '2026-07-28T12:00:00.000Z',
      draft: false,
      prerelease: false,
    });
  });
});

describe('handleGitHubReleaseWebhook', () => {
  it('rejects wrong method, content type, signature, and oversized bodies', async () => {
    const store = createMemoryStore();

    const wrongMethod = await handleGitHubReleaseWebhook({
      request: new Request('https://pegma.dev/api/webhooks/github/releases', {
        method: 'GET',
      }),
      store,
      logger,
      config,
    });
    expect(wrongMethod.status).toBe(405);

    const wrongType = await handleGitHubReleaseWebhook({
      request: new Request('https://pegma.dev/api/webhooks/github/releases', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: '{}',
      }),
      store,
      logger,
      config,
    });
    expect(wrongType.status).toBe(415);

    const badSig = await handleGitHubReleaseWebhook({
      request: new Request('https://pegma.dev/api/webhooks/github/releases', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Hub-Signature-256': 'sha256=00',
        },
        body: '{}',
      }),
      store,
      logger,
      config,
    });
    expect(badSig.status).toBe(401);

    const oversized = await handleGitHubReleaseWebhook({
      request: new Request('https://pegma.dev/api/webhooks/github/releases', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(MAX_GITHUB_WEBHOOK_BODY_BYTES + 1),
        },
        body: 'x',
      }),
      store,
      logger,
      config,
    });
    expect(oversized.status).toBe(413);

    const releases = store.collection(componentReleaseCollection());
    expect(await releases.get(componentReleaseKey(REPO_ID))).toBeNull();
  });

  it('acknowledges authenticated ping without touching storage', async () => {
    const store = createMemoryStore();
    const body = new TextEncoder().encode('{"zen":"design"}');
    const response = await handleGitHubReleaseWebhook({
      request: new Request('https://pegma.dev/api/webhooks/github/releases', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-GitHub-Event': 'ping',
          'X-GitHub-Delivery': DELIVERY,
          'X-Hub-Signature-256': await signatureFor(body),
        },
        body,
      }),
      store,
      logger,
      config,
    });
    expect(response.status).toBe(204);
    expect(
      await store.collection(componentReleaseCollection()).get(
        componentReleaseKey(REPO_ID),
      ),
    ).toBeNull();
  });

  it('rejects disallowed organization and repository after verification', async () => {
    const store = createMemoryStore();

    const wrongOrg = await handleGitHubReleaseWebhook({
      request: await signedRequest(
        releasePayload({ organization: { id: 1 } }),
      ),
      store,
      logger,
      config,
    });
    expect(wrongOrg.status).toBe(403);

    const wrongRepo = await handleGitHubReleaseWebhook({
      request: await signedRequest(
        releasePayload({
          repository: {
            id: 999,
            name: 'webhooks',
            owner: { id: Number(ORG_ID) },
          },
        }),
      ),
      store,
      logger,
      config,
    });
    expect(wrongRepo.status).toBe(403);
    expect(
      await store.collection(componentReleaseCollection()).get(
        componentReleaseKey(REPO_ID),
      ),
    ).toBeNull();
  });

  it('projects a stable release once and treats duplicates as harmless', async () => {
    const store = createMemoryStore();
    const releases = store.collection(componentReleaseCollection());

    const first = await handleGitHubReleaseWebhook({
      request: await signedRequest(releasePayload()),
      store,
      logger,
      config,
      now: NOW,
    });
    expect(first.status).toBe(204);
    expect(await releases.get(componentReleaseKey(REPO_ID))).toMatchObject({
      tagName: 'v0.1.0',
      releaseId: '100',
      releaseUrl: 'https://github.com/pegma-dev/webhooks/releases/tag/v0.1.0',
    });

    const duplicate = await handleGitHubReleaseWebhook({
      request: await signedRequest(
        releasePayload({
          release: {
            id: 100,
            tag_name: 'v0.1.0-changed',
            published_at: '2026-07-28T12:00:00.000Z',
            draft: false,
            prerelease: false,
          },
        }),
      ),
      store,
      logger,
      config,
      now: NOW,
    });
    expect(duplicate.status).toBe(204);
    expect(await releases.get(componentReleaseKey(REPO_ID))).toMatchObject({
      tagName: 'v0.1.0',
    });
  });

  it('records draft deliveries without projecting them', async () => {
    const store = createMemoryStore();
    const response = await handleGitHubReleaseWebhook({
      request: await signedRequest(
        releasePayload({
          release: {
            id: 101,
            tag_name: 'v0.2.0',
            published_at: '2026-07-28T12:00:00.000Z',
            draft: true,
            prerelease: false,
          },
        }),
      ),
      store,
      logger,
      config,
      now: NOW,
    });
    expect(response.status).toBe(204);
    expect(
      await store.collection(componentReleaseCollection()).get(
        componentReleaseKey(REPO_ID),
      ),
    ).toBeNull();
  });

  it('clears the projection on unpublished with null published_at', async () => {
    const store = createMemoryStore();
    const releases = store.collection(componentReleaseCollection());

    expect(
      (
        await handleGitHubReleaseWebhook({
          request: await signedRequest(releasePayload()),
          store,
          logger,
          config,
          now: NOW,
        })
      ).status,
    ).toBe(204);
    expect(await releases.get(componentReleaseKey(REPO_ID))).not.toBeNull();

    const unpublishDelivery = '22222222-2222-4222-8222-222222222222';
    const payload = releasePayload({
      action: 'unpublished',
      release: {
        id: 100,
        tag_name: 'v0.1.0',
        published_at: null,
        draft: true,
        prerelease: false,
      },
    });
    const body = new TextEncoder().encode(JSON.stringify(payload));
    const response = await handleGitHubReleaseWebhook({
      request: new Request('https://pegma.dev/api/webhooks/github/releases', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-GitHub-Event': 'release',
          'X-GitHub-Delivery': unpublishDelivery,
          'X-Hub-Signature-256': await signatureFor(body),
        },
        body,
      }),
      store,
      logger,
      config,
      now: NOW,
    });
    expect(response.status).toBe(204);
    expect(await releases.get(componentReleaseKey(REPO_ID))).toBeNull();
  });

  it('rejects unsupported event families after authentication', async () => {
    const store = createMemoryStore();
    const body = new TextEncoder().encode('{}');
    const response = await handleGitHubReleaseWebhook({
      request: new Request('https://pegma.dev/api/webhooks/github/releases', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-GitHub-Event': 'push',
          'X-GitHub-Delivery': DELIVERY,
          'X-Hub-Signature-256': await signatureFor(body),
        },
        body,
      }),
      store,
      logger,
      config,
    });
    expect(response.status).toBe(400);
  });
});
