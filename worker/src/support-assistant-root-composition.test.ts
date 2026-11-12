import { afterEach, describe, expect, it, vi } from 'vitest';
import * as d1 from '@pegma/storage-cloudflare-d1';
import { createWorker } from './index';
import { createProductionSupportAnswering } from './support-assistant-production';
import { productionAnsweringFixture } from './support-assistant-production-fixtures';
import { humanSecret } from './support-human-control-fixtures';
import type { SupportAnsweringComposition } from './support-assistant-composition';
import type { SupportEngineeringHumanComposition } from './support-engineering-composition';
import { RATE_LIMIT_CRON } from './maintenance-schedule';
import { supportAssistantRoutePolicySha256 } from './support-assistant-config';
import { publishAnsweringGuide } from './support-answering-fixtures';
import { customerAccessContext } from './support-access';
import { supportAssistantReadyTargets } from './support-assistant';

vi.mock('@pegma/storage-cloudflare-d1', async (original) => ({
  ...(await original<typeof import('@pegma/storage-cloudflare-d1')>()),
  createCloudflareD1Store: vi.fn(),
}));

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** The platform binding selects a genuine Memory Store. Every host factory,
 * published Identity/session/role/Support API and HTTP guard stays real.
 * This does not substitute for Native D1 query-budget qualification. */
async function fixture() {
  const f = await productionAnsweringFixture();
  vi.mocked(d1.createCloudflareD1Store).mockReturnValue(f.store);
  const unavailable = (): never => {
    throw new Error('This Memory binding fixture cannot execute D1.');
  };
  const database: D1Database = {
    prepare: unavailable,
    batch: unavailable,
    exec: unavailable,
    dump: unavailable,
    withSession: unavailable,
  };
  const environment = {
    ...f.environment,
    IDENTITY_DB: database,
    IDENTITY_EMAIL_CODE_SECRET_BASE64: humanSecret,
    IDENTITY_EMAIL_FROM: 'Pegma <identity@pegma.dev>',
    IDENTITY_EMAIL_ENABLED: 'true',
    PEGMA_KNOWLEDGE_ENABLED: 'true',
    PEGMA_SUPPORT_LEARNING_REVIEWS_ENABLED: 'false',
    PEGMA_KNOWLEDGE_BROWSER_LIMIT: '120',
    PEGMA_AGENT_RESOURCE_LIMIT: '300',
    get SUPPORT_LEARNING_REVIEWS(): Queue {
      return unavailable();
    },
    get PEGMA_AGENT_CLIENTS_JSON(): Env['PEGMA_AGENT_CLIENTS_JSON'] {
      return unavailable();
    },
    get GITHUB_ORGANIZATION_ID(): Env['GITHUB_ORGANIZATION_ID'] {
      return unavailable();
    },
    get GITHUB_ALLOWED_REPOSITORY_IDS(): Env['GITHUB_ALLOWED_REPOSITORY_IDS'] {
      return unavailable();
    },
  } satisfies Parameters<ReturnType<typeof createWorker>['fetch']>[1];
  const network = vi.fn(async () => {
    throw new Error('No external transport in root composition tests.');
  });
  vi.stubGlobal('fetch', network);
  const pending: Promise<unknown>[] = [];
  const context: ExecutionContext = {
    waitUntil(promise) {
      pending.push(promise);
    },
    passThroughOnException: unavailable,
    get exports(): Cloudflare.Exports {
      return unavailable();
    },
    props: {},
    get tracing(): Tracing {
      return unavailable();
    },
    abort: unavailable,
  };
  async function call(request: Request, options: Parameters<typeof createWorker>[0] = {}) {
    const result = await createWorker(options).fetch(request, environment, context);
    await Promise.all(pending.splice(0));
    return result;
  }
  async function tick(scheduledTime: number) {
    await createWorker().scheduled(
      { cron: RATE_LIMIT_CRON, scheduledTime, noRetry() {} },
      environment,
      context,
    );
    await Promise.all(pending.splice(0));
  }
  function ordinary() {
    const headers = new Headers(f.request(f.packet()).headers);
    headers.delete('X-Pegma-Support-Command');
    return new Request('https://pegma.dev/api/support/tickets', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        subject: 'Fictional ordinary support',
        body: 'A person can help with this product question.',
        category: 'question',
      }),
    });
  }
  return {
    ...f,
    environment,
    network,
    call,
    ordinary,
    tick,
    bundle: () => createProductionSupportAnswering(environment, f.f.runtime.clock),
    async hints() {
      const targets = await Promise.all(
        ['ready:0', 'ready:1'].map((id) =>
          f.store.collection(supportAssistantReadyTargets).get({ partition: 'support-answering', id }),
        ),
      );
      return targets.filter((target) => target !== null);
    },
  };
}

describe('normal Worker optional answering composition', () => {
  it.each(['2026-11-12T12:10:00.001Z', '2026-11-12T23:58:00.001Z'])(
    'finishes two admitted turns through actual minute cadence within 300s from %s',
    async (instant) => {
      // Date controls only the documented schedule chronology. Real SDKs and
      // asynchronous Store operations remain unchanged; no session-race claim.
      vi.useFakeTimers({ toFake: ['Date'] });
      const started = Date.parse(instant);
      vi.setSystemTime(started);
      const f = await fixture();
      const until = new Date(started + 10 * 60_000).toISOString();
      const settings = structuredClone(f.settings);
      settings.route.configuration.dataControls = {
        ...settings.route.configuration.dataControls,
        validUntil: until,
      };
      settings.route.approval.validUntil = until;
      settings.tokenizer.validUntil = until;
      settings.usagePolicy.validUntil = until;
      settings.route.approval.requestPolicySha256 =
        await supportAssistantRoutePolicySha256(settings.route);
      f.environment.PEGMA_SUPPORT_ASSISTANT_CONFIGURATION_JSON =
        JSON.stringify(settings);
      f.environment.PEGMA_SUPPORT_ASSISTANT_CUSTOMER_ADMISSION_ENABLED = 'true';
      await publishAnsweringGuide(f.f);
      const packets = [f.packet(), f.packet()];
      for (const packet of packets)
        expect((await f.call(f.request(packet))).status).toBe(201);
      vi.stubGlobal('fetch', f.provider);
      const wires: number[] = [];
      const first = Math.floor(started / 60_000) * 60_000 + 60_000;
      for (let phase = 0; phase < 4; ++phase) {
        const at = first + phase * 60_000;
        vi.setSystemTime(at);
        f.f.advance(60_000);
        await f.tick(at);
        wires.push(f.wires.length);
      }
      expect(wires).toEqual([0, 1, 1, 2]);
      expect(Date.now() - started).toBeLessThan(300_000);
      for (const packet of packets) {
        const view = await f.f.runtime.application.readCustomerTicket(
          customerAccessContext(f.principalId),
          packet.command.ticketId,
        );
        expect(
          view.messages.filter((message) => message.authorKind === 'assistant'),
        ).toHaveLength(1);
      }
    },
  );

  it('keeps OFF configuration and provider credentials unread', async () => {
    const configuration = vi.fn(() => {
      throw new Error('OFF configuration read.');
    });
    const credential = vi.fn(() => {
      throw new Error('OFF credential read.');
    });
    const configured = await createProductionSupportAnswering({
      PEGMA_SUPPORT_ASSISTANT_ENABLED: 'false',
      get PEGMA_SUPPORT_ASSISTANT_CONFIGURATION_JSON() {
        return configuration();
      },
      get SUPPORT_ASSISTANT_OPENROUTER_API_KEY() {
        return credential();
      },
    });
    expect(configured.configuration).toBeUndefined();
    expect(configuration).not.toHaveBeenCalled();
    expect(credential).not.toHaveBeenCalled();
  });

  it('preserves healthy answering and ordinary support when engineering options are invalid', async () => {
    const f = await fixture();
    f.environment.PEGMA_SUPPORT_ASSISTANT_CUSTOMER_ADMISSION_ENABLED = 'true';
    const engineering: SupportEngineeringHumanComposition = {
      enabled: () => true,
      configuration: {
        application: { enabled: true, maxModelAttempts: 0 },
        repositories: [],
      },
    };
    const options = { engineering };
    const capability = await f.call(f.request(), options);
    expect(capability.status).toBe(200);
    expect(await capability.json()).toMatchObject({ enabled: true });
    const created = await f.call(f.request(f.packet()), options);
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ initialMode: 'assistant' });
    expect((await f.call(f.ordinary(), options)).status).toBe(201);
    expect(f.network).not.toHaveBeenCalled();
  });

  it.each([0, 5])(
    'keeps ordinary human support with malformed injected answering attempts %i',
    async (maxAttempts) => {
      const f = await fixture();
      const supplied = await f.bundle();
      if (supplied.configuration === undefined)
        throw new Error('Expected fictional configuration.');
      const answering: SupportAnsweringComposition = {
        ...supplied,
        configuration: { ...supplied.configuration, turns: { maxAttempts } },
      };
      const response = await f.call(f.ordinary(), { answering });
      expect(response.status).toBe(201);
      expect(await response.json()).not.toHaveProperty('ticket.handling');
      expect(f.network).not.toHaveBeenCalled();
    },
  );

  it.each(['policy', 'audience', 'allowlist'] as const)(
    'disables incomplete injected %s before optional route work',
    async (missing) => {
      const f = await fixture();
      f.environment.PEGMA_SUPPORT_ASSISTANT_CUSTOMER_ADMISSION_ENABLED = 'true';
      const supplied = await f.bundle();
      if (supplied.configuration === undefined)
        throw new Error('Expected fictional configuration.');
      const route = vi.fn(supplied.configuration.route.readRoute);
      const configuration = {
        ...supplied.configuration,
        route: { ...supplied.configuration.route, readRoute: route },
      };
      // Deliberately malformed JavaScript host input, never an accepted DTO.
      Reflect.deleteProperty(
        missing === 'allowlist' ? configuration.route : configuration,
        missing === 'policy'
          ? 'customerPolicy'
          : missing === 'audience'
            ? 'selectAudience'
            : 'allowlist',
      );
      const response = await f.call(f.request(), {
        answering: { ...supplied, configuration },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ enabled: false });
      expect(route).not.toHaveBeenCalled();
      expect(
        (
          await f.call(f.ordinary(), {
            answering: { ...supplied, configuration },
          })
        ).status,
      ).toBe(201);
      expect(f.network).not.toHaveBeenCalled();
    },
  );

  it('retains explicit admission OFF when the injected callback is omitted', async () => {
    const f = await fixture();
    const supplied = await f.bundle();
    const answering = { ...supplied };
    delete answering.customerAdmissionEnabled;
    const capability = await f.call(f.request(), { answering });
    expect(await capability.json()).toMatchObject({ enabled: false });
    const packet = f.packet();
    expect((await f.call(f.request(packet), { answering })).status).toBe(409);
    expect(await f.f.human.rows(packet.command.ticketId)).toEqual([]);
    expect((await f.call(f.ordinary(), { answering })).status).toBe(201);
    expect(f.network).not.toHaveBeenCalled();
  });

  it('protects the actual Worker route with browser authority, immutable actors and receipt-first recovery', async () => {
    const f = await fixture();
    f.environment.PEGMA_SUPPORT_ASSISTANT_CUSTOMER_ADMISSION_ENABLED = 'true';
    const alter = (request: Request, change: (headers: Headers) => void) => {
      const headers = new Headers(request.headers);
      change(headers);
      return new Request(request, { headers });
    };
    const absent = alter(f.request(), (headers) => {
      headers.delete('Cookie');
      headers.set('x-ms-client-principal', 'fictional-platform-header');
    });
    expect((await f.call(absent)).status).toBe(401);
    expect(
      (
        await f.call(
          alter(f.request(), (headers) =>
            headers.set('Authorization', 'Bearer fictional-agent'),
          ),
        )
      ).status,
    ).toBe(403);
    for (const fault of ['cookie', 'origin', 'csrf'] as const) {
      const packet = f.packet();
      const response = await f.call(
        alter(f.request(packet), (headers) => {
          if (fault === 'cookie') headers.delete('Cookie');
          else if (fault === 'origin')
            headers.set('Origin', 'https://foreign.example.test');
          else headers.delete('X-Pegma-CSRF');
        }),
      );
      expect(response.status).toBe(fault === 'cookie' ? 401 : 403);
      expect(await f.f.human.rows(packet.command.ticketId)).toEqual([]);
    }
    const forged = f.packet();
    forged.command.expectedAccountId = 'fictional-other';
    forged.command.commandId = 'fictional-other~' + crypto.randomUUID();
    forged.command.messageId = 'fictional-other~' + crypto.randomUUID();
    expect((await f.call(f.request(forged))).status).toBe(403);
    expect(await f.f.human.rows(forged.command.ticketId)).toEqual([]);
    const packet = f.packet();
    const created = await f.call(f.request(packet));
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ initialMode: 'assistant' });
    const rows = await f.f.human.rows(packet.command.ticketId);
    f.environment.PEGMA_SUPPORT_ASSISTANT_ENABLED = 'false';
    f.environment.PEGMA_SUPPORT_ASSISTANT_CONFIGURATION_JSON = '';
    const replay = await f.call(f.request(packet));
    expect(replay.status).toBe(201);
    expect(await replay.json()).toMatchObject({ initialMode: 'assistant' });
    expect(await f.f.human.rows(packet.command.ticketId)).toEqual(rows);
    expect(f.network).not.toHaveBeenCalled();
  });

  it('contains an actual scheduled factory throw in the timer with a finite diagnostic', async () => {
    const f = await fixture();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(d1.createCloudflareD1Store).mockImplementation(() => {
      throw new Error('FICTIONAL_PRIVATE_FACTORY_CONTEXT');
    });
    await expect(f.tick(Date.now())).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith({
      level: 'error',
      message: 'support.answering.failed',
      fields: { stage: 'worker', reason: 'unavailable' },
    });
    expect(JSON.stringify(error.mock.calls)).not.toContain(
      'FICTIONAL_PRIVATE_FACTORY_CONTEXT',
    );
    expect(f.network).not.toHaveBeenCalled();
  });

  it('diagnoses actual engineering construction fallback without disabling healthy answering', async () => {
    const f = await fixture();
    f.environment.PEGMA_SUPPORT_ASSISTANT_CUSTOMER_ADMISSION_ENABLED = 'true';
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const configuration = { application: { enabled: true }, repositories: [] };
    Object.defineProperty(configuration, 'application', {
      get() {
        throw new Error('FICTIONAL_PRIVATE_ENGINEERING_CONFIGURATION');
      },
    });
    const response = await f.call(f.request(), {
      engineering: { enabled: () => true, configuration },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ enabled: true });
    expect(error).toHaveBeenCalledWith({
      level: 'error',
      message: 'support.composition_unavailable',
      fields: { stage: 'support_runtime', engineering: true, answering: true },
    });
    expect(JSON.stringify(error.mock.calls)).not.toContain(
      'FICTIONAL_PRIVATE_ENGINEERING_CONFIGURATION',
    );
    expect(f.network).not.toHaveBeenCalled();
  });

  it('diagnoses actual answering runtime fallback while ordinary human support remains healthy', async () => {
    const f = await fixture();
    const supplied = await f.bundle();
    if (supplied.configuration === undefined)
      throw new Error('Expected fictional configuration.');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const answering = {
      ...supplied,
      configuration: {
        ...supplied.configuration,
        usagePolicy: {
          ...supplied.configuration.usagePolicy,
          maxCostMicros: 0,
        },
      },
    };
    const response = await f.call(f.ordinary(), { answering });
    expect(response.status).toBe(201);
    expect(error).toHaveBeenCalledWith({
      level: 'error',
      message: 'support.composition_unavailable',
      fields: { stage: 'answering_runtime' },
    });
    expect(f.network).not.toHaveBeenCalled();
  });

  it.each(['enabled', 'configuration', 'route'] as const)(
    'diagnoses a throwing injected %s observation without exposing its exception',
    async (fault) => {
      const f = await fixture();
      const supplied = await f.bundle();
      if (supplied.configuration === undefined)
        throw new Error('Expected fictional configuration.');
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const answering = {
        ...supplied,
        configuration: { ...supplied.configuration },
      };
      const fail = () => {
        throw new Error('FICTIONAL_PRIVATE_ANSWERING_CONFIGURATION');
      };
      if (fault === 'enabled') answering.enabled = fail;
      else
        Object.defineProperty(
          fault === 'configuration' ? answering : answering.configuration,
          fault,
          { get: fail },
        );
      const response = await f.call(f.request(), { answering });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ enabled: false });
      expect(error).toHaveBeenCalledWith({
        level: 'error',
        message: 'support.composition_unavailable',
        fields: { stage: 'answering_validation' },
      });
      expect(JSON.stringify(error.mock.calls)).not.toContain(
        'FICTIONAL_PRIVATE_ANSWERING_CONFIGURATION',
      );
      expect(f.network).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, 1, '', ' padded ', 'v'.repeat(257)])(
    'refuses malformed injected usage version %s before optional Store or route work',
    async (version) => {
      const f = await fixture();
      const supplied = await f.bundle();
      if (supplied.configuration === undefined)
        throw new Error('Expected fictional configuration.');
      const route = vi.fn(supplied.configuration.route.readRoute);
      const configuration = {
        ...supplied.configuration,
        usagePolicy: { ...supplied.configuration.usagePolicy },
        route: { ...supplied.configuration.route, readRoute: route },
      };
      Reflect.set(configuration.usagePolicy, 'version', version);
      f.environment.PEGMA_SUPPORT_ASSISTANT_CUSTOMER_ADMISSION_ENABLED = 'true';
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.mocked(d1.createCloudflareD1Store).mockClear();
      const response = await f.call(f.request(), {
        answering: { ...supplied, configuration },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ enabled: false });
      expect(d1.createCloudflareD1Store).not.toHaveBeenCalled();
      expect(route).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledWith({
        level: 'error',
        message: 'support.composition_unavailable',
        fields: { stage: 'answering_validation' },
      });
      expect(f.network).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    'keeps ordinary human traffic healthy with optional configuration throwing while enabled=%s',
    async (enabled) => {
      const f = await fixture();
      f.environment.PEGMA_SUPPORT_ASSISTANT_ENABLED = String(enabled);
      const configuration = vi.fn(() => {
        throw new Error('FICTIONAL_PRIVATE_OPTIONAL_CONFIGURATION');
      });
      const credential = vi.fn(() => {
        throw new Error('FICTIONAL_PRIVATE_OPTIONAL_CREDENTIAL');
      });
      Object.defineProperty(
        f.environment,
        'PEGMA_SUPPORT_ASSISTANT_CONFIGURATION_JSON',
        { get: configuration },
      );
      Object.defineProperty(
        f.environment,
        'SUPPORT_ASSISTANT_OPENROUTER_API_KEY',
        { get: credential },
      );
      const response = await f.call(f.ordinary());
      expect(response.status).toBe(201);
      expect(configuration).toHaveBeenCalledTimes(enabled ? 1 : 0);
      expect(credential).not.toHaveBeenCalled();
      expect(f.network).not.toHaveBeenCalled();
      expect(await f.hints()).toEqual([]);
    },
  );

  it('retains a causal assistant turn when an ordinary customer reply follows explicit assistant admission', async () => {
    const f = await fixture();
    f.environment.PEGMA_SUPPORT_ASSISTANT_CUSTOMER_ADMISSION_ENABLED = 'true';
    const packet = f.packet();
    expect((await f.call(f.request(packet))).status).toBe(201);
    const headers = new Headers(f.request(packet).headers);
    headers.delete('X-Pegma-Support-Command');
    const reply = new Request(
      'https://pegma.dev/api/support/tickets/' +
        packet.command.ticketId +
        '/replies',
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          body: 'A fictional causal follow-up question.',
        }),
      },
    );
    expect((await f.call(reply)).status).toBe(201);
    const rows = await f.f.human.rows(packet.command.ticketId);
    expect(rows.filter((row) => row.kind === 'assistant_turn')).toHaveLength(2);
    const message = rows.find(
      (row) => row.kind === 'message' && row.message.id !== packet.command.messageId,
    );
    if (message?.kind !== 'message')
      throw new Error('Expected the actual accepted customer reply.');
    expect(await f.hints()).toContainEqual({
      partition: 'support-answering',
      id: expect.stringMatching(/^ready:[01]$/u),
      ticketId: packet.command.ticketId,
      triggerMessageId: message.message.id,
      createdAt: expect.any(String),
    });
    expect(f.network).not.toHaveBeenCalled();
  });
});
