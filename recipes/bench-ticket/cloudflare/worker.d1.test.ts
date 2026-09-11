import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import worker, { compositionFor, type BenchTicketEnv } from './worker';

declare global {
  namespace Cloudflare {
    interface Env {
      BENCH_TICKET_DB: D1Database;
      BENCH_TICKET_EMAIL_CODE_SECRET_BASE64: string;
      BENCH_TICKET_ORIGIN: string;
    }
  }
}

function benchEnv(): BenchTicketEnv {
  return env as BenchTicketEnv;
}

describe('Bench Ticket Cloudflare Worker', () => {
  it('creates D1 schema on first health and reuses composition until the secret rotates', async () => {
    const origin = env.BENCH_TICKET_ORIGIN;
    const health = await worker.fetch(new Request(`${origin}/health`), benchEnv());
    expect(health.status).toBe(200);
    const body = (await health.json()) as { ok: boolean; service: string };
    expect(body.ok).toBe(true);
    expect(body.service).toBe('bench-ticket');

    const first = compositionFor(benchEnv());
    expect(compositionFor(benchEnv())).toBe(first);

    const rotated = compositionFor({
      ...benchEnv(),
      BENCH_TICKET_EMAIL_CODE_SECRET_BASE64: btoa(
        String.fromCharCode(...new Uint8Array(32).fill(12)),
      ),
    });
    expect(rotated).not.toBe(first);
  });

  it('accepts email-code begin on the Worker entry', async () => {
    const origin = env.BENCH_TICKET_ORIGIN;
    const begin = await worker.fetch(
      new Request(`${origin}/api/auth/begin`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'member@bench.example', flow: 'create' }),
      }),
      benchEnv(),
    );
    expect(begin.status).toBe(200);
    const started = (await begin.json()) as { codeHandle: string };
    expect(started.codeHandle.length).toBeGreaterThan(0);
  });
});
