import { describe, expect, it } from 'vitest';
import { JSON_LIMIT, readJson } from './api-auth';

function request(body: string, declaredLength?: number): Request {
  return new Request('https://pegma.dev/api/support/admin/engineering/policy', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(declaredLength === undefined
        ? {}
        : { 'Content-Length': String(declaredLength) }),
    },
    body,
  });
}

describe('explicit JSON byte limits', () => {
  it('keeps the existing default while allowing a bounded larger policy snapshot', async () => {
    const text = '界'.repeat(24_000);
    const body = JSON.stringify(text);
    expect(body.length).toBeLessThan(JSON_LIMIT);
    expect(new TextEncoder().encode(body).byteLength).toBeGreaterThan(JSON_LIMIT);
    await expect(readJson(request(body), { timeoutMs: 1_000 })).rejects.toMatchObject({
      status: 413,
      code: 'request_too_large',
    });
    await expect(
      readJson(request(body), { timeoutMs: 1_000, maxBytes: 128 * 1024 }),
    ).resolves.toBe(text);
  });

  it('checks streamed bytes even when Content-Length declares a smaller body', async () => {
    const body = JSON.stringify('x'.repeat(128 * 1024 - 1));
    await expect(
      readJson(request(body, 2), { timeoutMs: 1_000, maxBytes: 128 * 1024 }),
    ).rejects.toMatchObject({ status: 413, code: 'request_too_large' });
  });

  it('accepts the exact explicit boundary and rejects a larger declared length', async () => {
    const limit = 128 * 1024;
    const text = 'x'.repeat(limit - 2);
    await expect(
      readJson(request(JSON.stringify(text), limit), {
        timeoutMs: 1_000,
        maxBytes: limit,
      }),
    ).resolves.toBe(text);
    await expect(
      readJson(request('{}', limit + 1), { timeoutMs: 1_000, maxBytes: limit }),
    ).rejects.toMatchObject({ status: 413, code: 'request_too_large' });
  });

  it.each([0, -1, 1.5, NaN, Infinity, 128 * 1024 + 1])(
    'refuses an invalid or unbounded configured limit: %s',
    async (maxBytes) => {
      await expect(readJson(request('{}'), { maxBytes })).rejects.toBeInstanceOf(
        RangeError,
      );
    },
  );
});
