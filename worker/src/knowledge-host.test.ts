import { describe, expect, it, vi } from 'vitest';
import { handleKnowledgeRequest, isKnowledgeRequest } from './knowledge-host';

describe('knowledge activation boundary', () => {
  it('refuses disabled requests before accessing Identity or D1', async () => {
    const database = vi.fn((): D1Database => {
      throw new Error('D1 must not be accessed');
    });
    const logger = { log: vi.fn() };
    const env = {
      PEGMA_KNOWLEDGE_ENABLED: 'false',
      PEGMA_AGENT_CLIENTS_JSON: '[]',
      IDENTITY_EMAIL_CODE_SECRET_BASE64: '',
      IDENTITY_EMAIL_FROM: '',
      IDENTITY_EMAIL_ENABLED: 'false',
      get IDENTITY_DB(): D1Database {
        return database();
      },
    };
    for (const path of [
      '/.well-known/oauth-authorization-server',
      '/.well-known/oauth-protected-resource/api/knowledge/mcp',
      '/api/agent-access/authorize',
      '/api/agent-access/token',
      '/api/knowledge/mcp',
      '/api/knowledge/reports',
      '/api/staff/knowledge/command',
    ]) {
      const response = await handleKnowledgeRequest(
        new Request(`https://pegma.dev${path}`),
        env,
        logger,
      );
      expect(response.status).toBe(503);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(await response.json()).toEqual({ error: 'knowledge_disabled' });
    }
    expect(database).not.toHaveBeenCalled();
    expect(logger.log).not.toHaveBeenCalled();
  });

  it('keeps existing catalog, identity, support and unrelated discovery outside its route boundary', () => {
    for (const path of [
      '/api/mcp',
      '/api/identity/account',
      '/api/support/tickets',
      '/api/admin/roles',
      '/api/releases',
      '/.well-known/security.txt',
    ]) {
      expect(isKnowledgeRequest(path)).toBe(false);
    }
  });
});
