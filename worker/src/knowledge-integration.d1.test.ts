import { env } from 'cloudflare:workers';
import { createCloudflareD1Store } from '@pegma/storage-cloudflare-d1';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleKnowledgeRequest } from './knowledge-host';
import { registerKnowledgeIntegrationScenarios } from './knowledge-integration-scenarios';

declare global {
  namespace Cloudflare {
    interface Env {
      IDENTITY_DB: D1Database;
    }
  }
}

// The existing host migration, executed against the real Workers D1 binding.
const schemaStatements = [
  'CREATE TABLE IF NOT EXISTS RECORDS (partition_key TEXT NOT NULL, row_key TEXT NOT NULL, record_json TEXT, version INTEGER NOT NULL, deleted INTEGER NOT NULL CHECK (deleted IN (0, 1)), PRIMARY KEY (partition_key, row_key)) STRICT',
  'CREATE TABLE IF NOT EXISTS PEGMA_STORAGE_D1_TX_GUARD (reason TEXT NOT NULL) STRICT',
  "CREATE TRIGGER IF NOT EXISTS PEGMA_STORAGE_D1_TX_ABORT_EXISTS BEFORE INSERT ON PEGMA_STORAGE_D1_TX_GUARD WHEN NEW.reason = 'exists' BEGIN SELECT RAISE(ABORT, 'PEGMA_STORAGE_D1_TX_EXISTS'); END",
  "CREATE TRIGGER IF NOT EXISTS PEGMA_STORAGE_D1_TX_ABORT_MISSING BEFORE INSERT ON PEGMA_STORAGE_D1_TX_GUARD WHEN NEW.reason = 'missing' BEGIN SELECT RAISE(ABORT, 'PEGMA_STORAGE_D1_TX_MISSING'); END",
  "CREATE TRIGGER IF NOT EXISTS PEGMA_STORAGE_D1_TX_ABORT_CHANGED BEFORE INSERT ON PEGMA_STORAGE_D1_TX_GUARD WHEN NEW.reason = 'changed' BEGIN SELECT RAISE(ABORT, 'PEGMA_STORAGE_D1_TX_CHANGED'); END",
] as const;

beforeAll(async () => {
  for (const statement of schemaStatements)
    await env.IDENTITY_DB.prepare(statement).run();
});
beforeEach(async () => {
  await env.IDENTITY_DB.prepare('DELETE FROM RECORDS').run();
  await env.IDENTITY_DB.prepare('DELETE FROM PEGMA_STORAGE_D1_TX_GUARD').run();
});
registerKnowledgeIntegrationScenarios({
  name: 'released Agent Access and KB host integration over actual D1',
  createStore: () =>
    createCloudflareD1Store({
      database: env.IDENTITY_DB,
      createSchemaIfMissing: false,
    }),
});

describe('production knowledge activation over actual D1', () => {
  it('keeps browser authentication live when optional agent registrations are malformed', async () => {
    const registrationCanary = 'synthetic-agent-registration-canary';
    const configuration = {
      IDENTITY_DB: env.IDENTITY_DB,
      IDENTITY_EMAIL_CODE_SECRET_BASE64: btoa(
        String.fromCharCode(...new Uint8Array(32).fill(7)),
      ),
      IDENTITY_EMAIL_FROM: 'identity@example.test',
      IDENTITY_EMAIL_ENABLED: 'false',
      PEGMA_KNOWLEDGE_ENABLED: 'true',
      PEGMA_AGENT_CLIENTS_JSON: `{"clientId":"${registrationCanary}"`,
    };
    const logger = { log: vi.fn() };
    const browser = await handleKnowledgeRequest(
      new Request('https://pegma.dev/api/staff/knowledge/state'),
      configuration,
      logger,
    );
    expect(browser.status).toBe(401);
    expect(browser.headers.get('Cache-Control')).toBe('no-store');
    expect(await browser.json()).toEqual({ error: 'authentication_required' });

    const agentRequests = [
      new Request('https://pegma.dev/.well-known/oauth-authorization-server'),
      new Request(
        'https://pegma.dev/.well-known/oauth-protected-resource/api/knowledge/mcp',
      ),
      new Request('https://pegma.dev/api/agent-access/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'grant_type=urn:ietf:params:oauth:grant-type:device_code',
      }),
      new Request('https://pegma.dev/api/knowledge/v1'),
      new Request('https://pegma.dev/api/knowledge/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      }),
      new Request('https://pegma.dev/api/knowledge/reports?articleId=guide'),
    ];
    for (const request of agentRequests) {
      const response = await handleKnowledgeRequest(
        request,
        configuration,
        logger,
      );
      expect(response.status).toBe(503);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(await response.json()).toEqual({
        error: 'agent_access_not_configured',
      });
    }
    expect(logger.log.mock.calls).toEqual([
      ...Array.from({ length: agentRequests.length + 1 }, () => [
        'error',
        'agent_access.configuration_unavailable',
        { error: 'SyntaxError' },
      ]),
      // The manual report route classifies its null-agent 503 through the
      // API failure boundary after the host records unavailable configuration.
      ['error', 'knowledge.api_unavailable', { error: 'Error', stage: 'api' }],
    ]);
    expect(JSON.stringify(logger.log.mock.calls)).not.toContain(
      registrationCanary,
    );
    expect(JSON.stringify(logger.log.mock.calls)).not.toContain(
      configuration.IDENTITY_EMAIL_CODE_SECRET_BASE64,
    );
  });
});
