import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveAccess } from '@pegma/authorization-core';
import {
  createProductionSupportAnswering,
  SUPPORT_ASSISTANT_SYNTHETIC_ROLE,
} from './support-assistant-production';
import { composeSupportAnswering, supportAnsweringEnabled } from './support-assistant-composition';
import { createSupportAnsweringIngress } from './support-assistant-ingress';
import { productionAnsweringFixture } from './support-assistant-production-fixtures';
import { supportAssistantRoutePolicySha256 } from './support-assistant-config';

afterEach(() => vi.unstubAllGlobals());
function runtime(
  f: Awaited<ReturnType<typeof productionAnsweringFixture>>,
  bundle: Awaited<ReturnType<typeof f.bundle>>,
) {
  return composeSupportAnswering(
    { ...f.f.runtime, application: f.f.application },
    f.f.logger,
    bundle,
    () => f.environment.PEGMA_SUPPORT_ASSISTANT_ENABLED === 'true',
  );
}
async function ingress(f: Awaited<ReturnType<typeof productionAnsweringFixture>>) {
  return createSupportAnsweringIngress(
    { ...f.f.runtime, application: f.f.application },
    f.f.logger,
    runtime(f, await f.bundle()),
  );
}

describe('source-owned normal production answering bundle', () => {
  it.each([undefined, '', '{', '{}'])(
    'keeps missing or malformed operator configuration receipt-only: %s',
    async (value) => {
      const configured = await createProductionSupportAnswering({
        PEGMA_SUPPORT_ASSISTANT_ENABLED: 'true',
        PEGMA_SUPPORT_ASSISTANT_CONFIGURATION_JSON: value,
      });
      expect(configured.recoveryOnly).toBe(true);
      expect(configured.configuration).toBeUndefined();
      expect(supportAnsweringEnabled(configured)).toBe(false);
    },
  );

  it.each([
    'endpoint',
    'credential',
    'hash',
    'extra',
    'expiry',
    'audience',
    'pool',
    'tokenizer',
  ] as const)('refuses an unqualified operator %s without reading a credential', async (change) => {
    const f = await productionAnsweringFixture();
    const settings = structuredClone(f.settings);
    if (change === 'endpoint') settings.route.endpointTag = 'azure/unreviewed';
    if (change === 'credential') settings.route.credentialRef = 'some-other-secret';
    if (change === 'hash') settings.route.approval.requestPolicySha256 = '0'.repeat(64);
    if (change === 'extra') Object.assign(settings, { extra: true });
    if (change === 'expiry') settings.route.approval.validUntil = '2020-01-01T00:00:00.000Z';
    if (change === 'audience') settings.audience.principalId = 'ordinary-real-account';
    if (change === 'pool') settings.usagePolicy.maxCostMicros = 1_000_001;
    if (change === 'tokenizer') settings.tokenizer.framingTokens = 0;
    f.environment.PEGMA_SUPPORT_ASSISTANT_CONFIGURATION_JSON = JSON.stringify(settings);
    Object.defineProperty(f.environment, 'SUPPORT_ASSISTANT_OPENROUTER_API_KEY', {
      get() {
        throw new Error('Credential must stay unread.');
      },
    });
    const configured = await f.bundle();
    expect(configured.configuration).toBeUndefined();
    expect(supportAnsweringEnabled(configured)).toBe(false);
  });

  it('binds only the reserved fictional principal with its actual current synthetic role', async () => {
    const f = await productionAnsweringFixture();
    const configured = (await f.bundle()).configuration!;
    expect(configured).toBeDefined();
    const selected = configured.selectAudience(await f.access());
    expect(selected?.collectionIds).toEqual(['fictional-guides']);
    expect(
      configured.selectAudience(
        resolveAccess({ principalId: f.principalId }, configured.customerPolicy),
      ),
    ).toBeNull();
    expect(
      configured.selectAudience(
        resolveAccess(
          { principalId: 'fictional-other', roles: [SUPPORT_ASSISTANT_SYNTHETIC_ROLE] },
          configured.customerPolicy,
        ),
      ),
    ).toBeNull();
    expect(configured.readApiKey('unknown')).toBeUndefined();
  });

  it('keeps new human and assistant customer admission OFF while real scheduled work can prepare and complete', async () => {
    const f = await productionAnsweringFixture();
    const response = await (await ingress(f))(f.request());
    expect(await response.json()).toMatchObject({ enabled: false });
    const { command } = await f.seed();
    vi.stubGlobal('fetch', vi.fn(f.provider));
    const outcomes: string[] = [];
    for (let physical = 0; physical < 12; ++physical) {
      const result = await runtime(f, await f.bundle()).runTick();
      outcomes.push(result.outcome === 'scanned' ? result.turn : result.outcome);
      if (result.outcome === 'prepared') expect(f.wires).toHaveLength(0);
      if (result.outcome === 'deferred')
        f.f.advance(
          Math.max(0, Date.parse(result.nextAttemptAt) - Date.parse(f.f.runtime.clock.now())),
        );
      if (result.outcome === 'scanned' && result.turn === 'completed') break;
    }
    expect(outcomes).toContain('prepared');
    expect(outcomes.at(-1)).toBe('completed');
    expect(f.wires).toHaveLength(1);
    expect(JSON.parse(f.wires[0]!).provider).toEqual({
      only: ['azure/swedencentral'],
      allow_fallbacks: false,
      data_collection: 'deny',
      zdr: true,
      require_parameters: true,
    });
    const view = await f.f.runtime.application.readCustomerTicket(
      await f.access(),
      command.command.ticketId,
    );
    expect(view.messages.filter((message) => message.authorKind === 'assistant')).toHaveLength(1);
  });

  it.each(['human', 'assistant_if_available'] as const)(
    'refuses a fresh %s packet with processing ON and admission OFF',
    async (preference) => {
      const f = await productionAnsweringFixture();
      const packet = f.packet(preference);
      expect(supportAnsweringEnabled(await f.bundle())).toBe(true);
      expect((await (await ingress(f))(f.request(packet))).status).toBe(409);
      expect(await f.f.human.rows(packet.command.ticketId)).toEqual([]);
      expect(f.wires).toHaveLength(0);
    },
  );

  it.each(['human', 'assistant_if_available'] as const)(
    'recovers the accepted %s packet after configuration removal and blocks fresh intake',
    async (preference) => {
      const f = await productionAnsweringFixture();
      f.environment.PEGMA_SUPPORT_ASSISTANT_CUSTOMER_ADMISSION_ENABLED = 'true';
      const packet = f.packet(preference);
      f.f.state.loseAck = true;
      expect((await (await ingress(f))(f.request(packet))).status).toBe(503);
      f.environment.PEGMA_SUPPORT_ASSISTANT_ENABLED = 'false';
      f.environment.PEGMA_SUPPORT_ASSISTANT_CONFIGURATION_JSON = '';
      Object.defineProperty(f.environment, 'SUPPORT_ASSISTANT_OPENROUTER_API_KEY', {
        get() {
          throw new Error('Recovery does not read keys.');
        },
      });
      const recovered = await (await ingress(f))(f.request(packet));
      expect(recovered.status).toBe(201);
      expect(await recovered.json()).toMatchObject({
        initialMode: preference === 'human' ? 'human' : 'assistant',
      });
      expect((await (await ingress(f))(f.request(f.packet(preference)))).status).toBe(409);
      expect(f.wires).toHaveLength(0);
    },
  );

  it.each(['configuration-time', 'usage-scope', 'role'] as const)(
    'never pays from an obsolete prepared %s snapshot',
    async (change) => {
      const f = await productionAnsweringFixture();
      await f.seed();
      vi.stubGlobal('fetch', vi.fn(f.provider));
      const prepared = await runtime(f, await f.bundle()).runTick();
      expect(prepared.outcome).toBe('prepared');
      if (change === 'role') {
        const current = await f.f.runtime.roleStore.getRoleAssignment('fictional-answering-role');
        if (current === null) throw new Error('Missing real synthetic assignment.');
        await f.f.runtime.roleStore.revokeRoleAssignmentWithAudit({
          assignmentId: 'fictional-answering-role',
          expectedConcurrencyToken: current.concurrencyToken,
          revokedBy: { kind: 'principal', principalId: f.f.human.principals.administrator },
          revokedAtEpochMs: Date.now(),
          auditEventId: crypto.randomUUID(),
        });
      } else {
        if (change === 'configuration-time')
          f.settings.route.configuration.dataControls = {
            ...f.settings.route.configuration.dataControls,
            verifiedAt: new Date(
              Date.parse(f.settings.route.configuration.dataControls.verifiedAt) - 1,
            ).toISOString(),
          };
        else {
          f.settings.route.usageScopeRef = 'fictional-changed-pool';
          f.settings.usagePolicy.scopeRef = 'fictional-changed-pool';
        }
        f.settings.route.approval.requestPolicySha256 = await supportAssistantRoutePolicySha256(
          f.settings.route,
        );
        f.environment.PEGMA_SUPPORT_ASSISTANT_CONFIGURATION_JSON = JSON.stringify(f.settings);
      }
      for (let physical = 0; physical < 3; ++physical) await runtime(f, await f.bundle()).runTick();
      expect(f.wires).toHaveLength(0);
    },
  );

  it('retains unknown provider accounting across new root bundles without another paid attempt', async () => {
    const f = await productionAnsweringFixture();
    const { command } = await f.seed();
    const transport = vi.fn(async () => {
      throw new Error('Fictional lost transport acknowledgement.');
    });
    vi.stubGlobal('fetch', transport);
    expect((await runtime(f, await f.bundle()).runTick()).outcome).toBe('prepared');
    const outcomes: string[] = [];
    for (let physical = 0; physical < 5; ++physical) {
      const result = await runtime(f, await f.bundle()).runTick();
      outcomes.push(result.outcome === 'scanned' ? result.turn : result.outcome);
      if (result.outcome === 'deferred') {
        f.f.advance(
          Math.max(0, Date.parse(result.nextAttemptAt) - Date.parse(f.f.runtime.clock.now())),
        );
      }
      f.f.advance(1000);
    }
    expect(transport).toHaveBeenCalledTimes(1);
    const view = await f.f.runtime.application.readCustomerTicket(
      await f.access(),
      command.command.ticketId,
    );
    expect(outcomes).toEqual(['finished', 'none', 'none', 'none', 'none']);
    expect(view.ticket.handling).toBe('human-pending');
    expect(view.messages.filter((message) => message.authorKind === 'assistant')).toHaveLength(0);
  });

  it('never uses receipt-only recovery to bypass original-session revocation', async () => {
    const f = await productionAnsweringFixture();
    f.environment.PEGMA_SUPPORT_ASSISTANT_CUSTOMER_ADMISSION_ENABLED = 'true';
    const packet = f.packet('human');
    expect((await (await ingress(f))(f.request(packet))).status).toBe(201);
    f.environment.PEGMA_SUPPORT_ASSISTANT_CONFIGURATION_JSON = '';
    await f.f.runtime.sessions.destroy('s'.repeat(43));
    expect((await (await ingress(f))(f.request(packet))).status).toBe(401);
    expect(f.wires).toHaveLength(0);
  });
});
