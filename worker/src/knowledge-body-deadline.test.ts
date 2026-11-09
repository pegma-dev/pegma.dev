import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, readJson } from './api-auth';

const timeoutMs = 10_000;
const byteLimit = 64 * 1024;
const encoder = new TextEncoder();

function jsonRequest(
  body: ReadableStream<Uint8Array>,
  headers: HeadersInit = { 'Content-Type': 'application/json' },
): Request {
  const init: RequestInit & { duplex: 'half' } = {
    method: 'POST',
    headers,
    body,
    duplex: 'half',
  };
  return new Request('https://pegma.dev/api/staff/knowledge/command', init);
}

function chunksRequest(chunks: Uint8Array[]): Request {
  let index = 0;
  return jsonRequest(
    new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          const chunk = chunks[index++];
          if (chunk === undefined) controller.close();
          else controller.enqueue(chunk);
        },
      },
      { highWaterMark: 0 },
    ),
  );
}

function fakeClock(): void {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('staff knowledge JSON body deadline', () => {
  it('bounds a hung read even when the actual stream cancellation never settles', async () => {
    fakeClock();
    const pull = vi.fn(() => new Promise<void>(() => {}));
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const request = jsonRequest(
      new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 }),
    );
    let settled = false;
    const pending = readJson(request, { timeoutMs }).finally(() => {
      settled = true;
    });
    const rejection = expect(pending).rejects.toMatchObject({
      status: 408,
      code: 'request_timeout',
    });
    await vi.advanceTimersByTimeAsync(timeoutMs - 1);
    expect(settled).toBe(false);
    expect(pull).toHaveBeenCalledTimes(1);
    expect(cancel).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await rejection;
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledWith(expect.any(ApiError));
    expect(request.body?.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retains the timeout failure when actual cancellation rejects', async () => {
    fakeClock();
    const cancel = vi.fn(() =>
      Promise.reject(new Error('synthetic cancel failure')),
    );
    const request = jsonRequest(
      new ReadableStream<Uint8Array>({ cancel }, { highWaterMark: 0 }),
    );
    const rejection = expect(
      readJson(request, { timeoutMs }),
    ).rejects.toMatchObject({
      status: 408,
      code: 'request_timeout',
    });
    await vi.advanceTimersByTimeAsync(timeoutMs);
    await rejection;
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(request.body?.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses one total deadline instead of renewing it after each chunk', async () => {
    fakeClock();
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const cancel = vi.fn();
    const request = jsonRequest(
      new ReadableStream<Uint8Array>(
        {
          start(controller) {
            source = controller;
          },
          cancel,
        },
        { highWaterMark: 0 },
      ),
    );
    const rejection = expect(
      readJson(request, { timeoutMs }),
    ).rejects.toMatchObject({
      status: 408,
      code: 'request_timeout',
    });
    await vi.advanceTimersByTimeAsync(9_000);
    source.enqueue(encoder.encode('{"partial":'));
    await vi.advanceTimersByTimeAsync(1_000);
    await rejection;
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(request.body?.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('accepts a delayed complete body before the deadline and clears its timer', async () => {
    fakeClock();
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const cancel = vi.fn();
    const request = jsonRequest(
      new ReadableStream<Uint8Array>(
        {
          start(controller) {
            source = controller;
          },
          cancel,
        },
        { highWaterMark: 0 },
      ),
    );
    const pending = readJson(request, { timeoutMs });
    await vi.advanceTimersByTimeAsync(timeoutMs - 1);
    source.enqueue(encoder.encode('{"ok":true}'));
    source.close();
    await expect(pending).resolves.toEqual({ ok: true });
    expect(cancel).not.toHaveBeenCalled();
    expect(request.body?.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not wait for a hung cancellation after the actual byte cap is exceeded', async () => {
    fakeClock();
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    let index = 0;
    const request = jsonRequest(
      new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            controller.enqueue(new Uint8Array(index++ === 0 ? byteLimit : 1));
          },
          cancel,
        },
        { highWaterMark: 0 },
      ),
    );
    await expect(readJson(request, { timeoutMs })).rejects.toMatchObject({
      status: 413,
      code: 'request_too_large',
    });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(request.body?.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('propagates the original stream read failure and clears the deadline', async () => {
    fakeClock();
    const failure = new Error('synthetic body read failure');
    const request = jsonRequest(
      new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            controller.error(failure);
          },
        },
        { highWaterMark: 0 },
      ),
    );
    await expect(readJson(request, { timeoutMs })).rejects.toBe(failure);
    expect(request.body?.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([undefined, { timeoutMs }])(
    'preserves the exact 64KiB byte boundary (%j)',
    async (options) => {
      fakeClock();
      const text = 'a'.repeat(byteLimit - 2);
      const bytes = encoder.encode(JSON.stringify(text));
      expect(bytes.byteLength).toBe(byteLimit);
      const request = chunksRequest([
        bytes.subarray(0, 31_111),
        bytes.subarray(31_111),
      ]);
      await expect(readJson(request, options)).resolves.toBe(text);
      expect(request.body?.locked).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each([undefined, { timeoutMs }])(
    'decodes UTF-8 split across real stream chunks (%j)',
    async (options) => {
      fakeClock();
      const bytes = encoder.encode('{"text":"\u20ac"}');
      const request = chunksRequest([
        bytes.subarray(0, 10),
        bytes.subarray(10, 11),
        bytes.subarray(11),
      ]);
      await expect(readJson(request, options)).resolves.toEqual({
        text: '\u20ac',
      });
      expect(request.body?.locked).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each([encoder.encode('{'), new Uint8Array([0x22, 0xff, 0x22])])(
    'retains invalid JSON and fatal UTF-8 rejection',
    async (bytes) => {
      fakeClock();
      const request = chunksRequest([bytes]);
      await expect(readJson(request, { timeoutMs })).rejects.toMatchObject({
        status: 400,
        code: 'invalid_json',
      });
      expect(request.body?.locked).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each([
    {
      headers: new Headers({ 'Content-Type': 'text/plain' }),
      status: 415,
      code: 'json_required',
    },
    {
      headers: new Headers({
        'Content-Type': 'application/json',
        'Content-Length': '65537',
      }),
      status: 413,
      code: 'request_too_large',
    },
    {
      headers: new Headers({
        'Content-Type': 'application/json',
        'Content-Length': 'invalid',
      }),
      status: 413,
      code: 'request_too_large',
    },
  ])(
    'retains header rejection before reading the body ($code)',
    async ({ headers, status, code }) => {
      fakeClock();
      const pull = vi.fn();
      const cancel = vi.fn();
      const request = jsonRequest(
        new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 }),
        headers,
      );
      await expect(readJson(request, { timeoutMs })).rejects.toMatchObject({
        status,
        code,
      });
      expect(pull).not.toHaveBeenCalled();
      expect(cancel).not.toHaveBeenCalled();
      expect(request.body?.locked).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('does not add a deadline to callers that omit options', async () => {
    fakeClock();
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const cancel = vi.fn();
    const request = jsonRequest(
      new ReadableStream<Uint8Array>(
        {
          start(controller) {
            source = controller;
          },
          cancel,
        },
        { highWaterMark: 0 },
      ),
    );
    let settled = false;
    const pending = readJson(request).finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(2 * timeoutMs);
    expect(settled).toBe(false);
    expect(cancel).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    source.enqueue(encoder.encode('{"legacy":true}'));
    source.close();
    await expect(pending).resolves.toEqual({ legacy: true });
    expect(request.body?.locked).toBe(false);
  });
});
