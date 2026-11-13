import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorker } from './index';
import { clearCatalogCache, DEFAULT_CATALOG_URL } from './mcp-catalog-fetch';

const catalog = JSON.parse(
  readFileSync(
    new URL('../../docs/catalog/example-catalog.json', import.meta.url),
    'utf8',
  ),
);

beforeEach(() => clearCatalogCache());
afterEach(() => vi.unstubAllGlobals());

function fixture() {
  const catalogFetch = vi.fn(async (input: RequestInfo | URL) => {
    expect(String(input)).toBe(DEFAULT_CATALOG_URL);
    return Response.json(catalog);
  });
  vi.stubGlobal('fetch', catalogFetch);
  const worker = createWorker();
  const pending: Promise<unknown>[] = [];
  const context = {
    waitUntil(promise: Promise<unknown>) {
      pending.push(promise);
    },
    passThroughOnException() {},
  } as ExecutionContext;

  async function request(
    method: string,
    params?: unknown,
    options: { readonly hostname?: string; readonly raw?: string } = {},
  ) {
    const hostname = options.hostname ?? 'pegma.dev';
    const response = await worker.fetch(
      new Request('https://' + hostname + '/api/mcp', {
        method: 'POST',
        headers: {
          Host: hostname,
          Accept: 'application/json, text/event-stream',
          'Content-Type': 'application/json',
          'MCP-Protocol-Version': '2025-03-26',
        },
        body:
          options.raw ??
          JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      }),
      {} as Parameters<typeof worker.fetch>[1],
      context,
    );
    const text = await response.text();
    await Promise.all(pending.splice(0));
    const dataLine = text.split('\n').find((line) => line.startsWith('data: '));
    return {
      response,
      body: text === '' ? null : JSON.parse(dataLine?.slice(6) ?? text),
    };
  }
  return { request, catalogFetch };
}

describe('registered public catalog MCP route with patched transports', () => {
  it('initializes an origin-less client and lists the existing five tools', async () => {
    const f = fixture();
    const initialized = await f.request('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'fictional-catalog-client', version: '1.0.0' },
    });
    expect(initialized.response.status).toBe(200);
    expect(initialized.body.result.serverInfo.name).toBe('pegma-catalog');
    const listed = await f.request('tools/list');
    expect(listed.response.status).toBe(200);
    expect(
      listed.body.result.tools.map((tool: { name: string }) => tool.name),
    ).toEqual([
      'list_components',
      'get_component',
      'list_recipes',
      'get_recipe',
      'plan_composition',
    ]);
    expect(f.catalogFetch).not.toHaveBeenCalled();
  });

  it('invokes the real catalog tool through the normal Worker entrypoint', async () => {
    const f = fixture();
    const result = await f.request('tools/call', {
      name: 'get_component',
      arguments: { id: 'example-store' },
    });
    expect(result.response.status).toBe(200);
    expect(result.body.result.isError).not.toBe(true);
    expect(JSON.parse(result.body.result.content[0].text).component.id).toBe(
      'example-store',
    );
    expect(f.catalogFetch).toHaveBeenCalledOnce();
  });

  it('rejects invalid tool input before loading catalog data', async () => {
    const f = fixture();
    const result = await f.request('tools/call', {
      name: 'get_component',
      arguments: { id: ['example-store'] },
    });
    expect(result.response.status).toBe(200);
    expect(result.body.error?.code ?? result.body.result?.isError).toSatisfy(
      (value: unknown) => value === -32602 || value === true,
    );
    expect(f.catalogFetch).not.toHaveBeenCalled();
  });

  it('retains the configured hostname guard before any catalog request', async () => {
    const f = fixture();
    const result = await f.request('tools/list', undefined, {
      hostname: 'unapproved.example',
    });
    expect(result.response.status).toBe(403);
    expect(f.catalogFetch).not.toHaveBeenCalled();
  });

  it('rejects a request over the patched transport body limit', async () => {
    const f = fixture();
    const result = await f.request('tools/list', undefined, {
      raw: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'get_component',
          arguments: { id: 'x'.repeat(4 * 1024 * 1024) },
        },
      }),
    });
    expect(result.response.status).toBe(413);
    expect(f.catalogFetch).not.toHaveBeenCalled();
  });
});
