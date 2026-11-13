import { describe, expect, it, vi } from 'vitest';
import { createSupportFollowupHostFixture } from './support-release-followup-host-fixtures';
import {
  supportFollowupRetestReceipts,
  createSupportFollowupRetests,
  cleanupSupportFollowupRetests,
  SUPPORT_FOLLOWUP_RETEST_CAPACITY,
  SUPPORT_FOLLOWUP_RETEST_RETENTION_MS,
  SUPPORT_FOLLOWUP_RETEST_INTENT_MS,
  type SupportFollowupRetestOptions,
} from './support-release-followup-retests';
import { defineCollection, type Store, type StoredRecord } from '@pegma/storage-core';
import { serializeAccessContext } from '@pegma/authorization-core';
import {
  engineeringFollowupRetestProductBinding,
  engineeringFollowupRetestRequestHash,
} from '@pegma/support-desk-application';
import {
  engineeringHttpObject,
  engineeringHttpResult,
} from './support-engineering-http-fixtures';

async function prepared(
  result: 'passed' | 'failed' = 'passed',
  confirmed = true,
  runnerId?: string,
) {
  const f = await createSupportFollowupHostFixture();
  const work = await f.prepared();
  const report = await f.report(result, confirmed, runnerId);
  const request = work.preparedBundle!.bundle.retestRequests[0]!;
  const packet = {
    commandId: crypto.randomUUID(),
    expectedPrincipalId: f.staff.principalId,
    workId: work.workId,
    expectedWorkGeneration: work.workGeneration,
    expectedTicketRevision: work.acceptedTicketRevision,
    retestRequestId: request.requestId,
    report: {
      articleId: report.articleId,
      ledgerEpoch: report.ledgerEpoch,
      reportId: report.reportId,
      expectedReportGeneration: report.reportGeneration,
      reviewBindingHash: report.reviewBindingHash,
      receipt: report.receipt,
    },
  };
  return { f, work, report, packet };
}

async function retainedRetest() {
  const result = await prepared();
  const { f, work, packet } = result;
  const preparedResponse = await f.api(f.request('retest-receipt', packet));
  const ack = engineeringHttpResult(
    await engineeringHttpObject(preparedResponse),
  );
  const request = work.preparedBundle!.bundle.retestRequests[0]!;
  const binding = {
    ticketId: work.ticketId,
    workId: work.workId,
    workBindingHash: work.workBindingHash,
    requestId: request.requestId,
    requestHash: await engineeringFollowupRetestRequestHash(request),
    bundleHash: work.preparedBundle!.bundleHash,
    productBinding: await engineeringFollowupRetestProductBinding(
      work.context!,
    ),
  };
  return { ...result, ack, binding };
}
async function observedRetest() {
  const result = await retainedRetest();
  const { f, ack, binding } = result;
  const observe = f.source.retests!.verifier.observe;
  if (!observe) throw new Error('Actual paired retest port required');
  const observation = await observe(
    String(ack.receipt),
    binding,
    new AbortController().signal,
  );
  if (!observation)
    throw new Error('Actual confirmed report observation required');
  return { ...result, observation };
}
async function currentGovernance(f: Awaited<ReturnType<typeof createSupportFollowupHostFixture>>, collectionId: string): Promise<NonNullable<Awaited<ReturnType<SupportFollowupRetestOptions['readGovernance']>>>> {
  const current = await f.access('admin');
  const source = Reflect.get(f.environment, 'SUPPORT_LEARNING_SOURCE_CONFIGURATION_JSON');
  const value = await f.knowledge.application.getGovernanceConfiguration(current, { collectionId });
  const validationPolicy = await f.knowledge.application.getValidationPolicy(current, { policyId: value.configuration.validationPolicy.id });
  return { ...value, validationPolicy,
    async confirmAuthority(signal: AbortSignal) {
      const fresh = await f.access('admin');
      if (signal.aborted || serializeAccessContext(fresh) !== serializeAccessContext(current)) return false;
      return (): true => {
        if (signal.aborted || f.environment.PEGMA_SUPPORT_RELEASE_FOLLOWUP_ENABLED !== 'true' || Reflect.get(f.environment, 'SUPPORT_LEARNING_SOURCE_CONFIGURATION_JSON') !== source) throw new Error('Current governance authority unavailable');
        return true;
      };
    },
  };
}
function retests(f: Awaited<ReturnType<typeof createSupportFollowupHostFixture>>, override: Partial<SupportFollowupRetestOptions> = {}) {
  return createSupportFollowupRetests({
    store: f.store, clock: f.f.clock, enabled: () => true,
    application: () => f.host.application,
    knowledge: () => f.knowledge.application, reports: () => f.knowledge.evidence,
    resolvePrincipal: (id) => f.f.f.resolve(id),
    readGovernance: (collectionId) => currentGovernance(f, collectionId),
    ...override,
  });
}
// Capacity-only migration fixture, not report or Work evidence.
const rawRetests = defineCollection<StoredRecord>({ name: supportFollowupRetestReceipts.name,
  key: (value) => ({ partition: String(value.ticketId), id: String(value.id) }),
  codec: { encode: (value) => ({ ...value }), decode: (value) => ({ ...value }) },
});
function countedReports(f: Awaited<ReturnType<typeof createSupportFollowupHostFixture>>) {
  const actual = f.knowledge.evidence.observations!;
  const observe = vi.fn(actual.observe.bind(actual));
  return { observe, reports: { ...f.knowledge.evidence, observations: { ...actual, observe } } };
}
async function changeTrust(f: Awaited<ReturnType<typeof createSupportFollowupHostFixture>>, kind: 'governance' | 'staging' | 'collection' | 'policy') {
  const governance = await f.knowledge.application.getGovernanceConfiguration(f.admin, { collectionId: f.collectionId });
  if (kind === 'collection') {
    const current = await f.knowledge.application.getCollection(f.admin, { collectionId: f.collectionId });
    const preview = await f.knowledge.application.previewCollectionPolicy(f.admin, {
      collectionId: f.collectionId,
      uses: { portal: { enabled: true, audience: { kind: 'permission', permission: 'knowledge.article.read' } }, bot: current.collection.policy.bot },
    });
    await f.knowledge.application.updateCollectionPolicy(f.admin, {
      ...f.command('change-collection-use', current.generation), collectionId: f.collectionId, preview: preview.preview,
    });
  } else if (kind === 'governance' || kind === 'staging') {
    await f.knowledge.application.putGovernanceConfiguration(f.admin, {
      ...f.command('change-governance-trust', governance.generation),
      collectionId: f.collectionId,
      configuration: kind === 'governance'
        ? { ...governance.configuration, trustedAttesterIds: [f.peer.principalId] }
        : { ...governance.configuration, expectedStagingBuildId: 'changed-staging-build' },
    });
  } else {
    const current = await f.knowledge.application.getValidationPolicy(f.admin, { policyId: governance.configuration.validationPolicy.id });
    await f.knowledge.application.putValidationPolicy(f.admin, {
      ...f.command('change-runner-trust', current.generation),
      policy: { ...current.policy, version: current.policy.version + 1,
        requirements: current.policy.requirements.map((value) => ({ ...value, trustedRunnerIds: ['fictional-other-runner'] })),
      },
    });
  }
}
describe('actual KB report association for exact release follow-up retests', () => {
  it('stores only actual resource coordinates and starts fresh governance while the actual report observation is pending', async () => {
    const { f, ack, binding } = await retainedRetest();
    const saved = (await f.store.collection(supportFollowupRetestReceipts).list(f.f.identity.ticketId)).find((value) => value.kind === 'receipt');
    if (saved?.kind !== 'receipt') throw new Error('Actual saved receipt required');
    expect(saved.readHint).toMatchObject({ collectionId: f.collectionId });
    expect(Object.keys(saved.readHint!).sort()).toEqual(['collectionId', 'validationPolicy']);
    const actual = f.knowledge.evidence.observations!;
    const events: string[] = [];
    let paused!: () => void;
    const reportPaused = new Promise<void>((resolve) => { paused = resolve; });
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const reports = { ...f.knowledge.evidence, observations: { ...actual, async observe(...args: Parameters<typeof actual.observe>) {
      const value = await actual.observe(...args); events.push('report-paused'); paused(); await barrier; return value;
    } } };
    const capability = retests(f, { reports: () => reports, readGovernance(collectionId) { events.push('gov-started'); return currentGovernance(f, collectionId); } });
    const pending = capability.verifier.observe!(String(ack.receipt), binding, new AbortController().signal);
    try { await reportPaused; expect(events.indexOf('gov-started')).toBeLessThan(events.indexOf('report-paused')); }
    finally { release(); }
    const observed = await pending;
    expect(observed).not.toBeNull();
    expect(await observed!.confirm(new AbortController().signal)).toBeTypeOf('function');
  });

  it.each(['governance', 'staging', 'collection', 'policy'] as const)('refuses %s changes after fresh governance capture but before the actual report opens', async (kind) => {
    const { f, ack, binding } = await retainedRetest();
    let captured!: () => void;
    const capturedGov = new Promise<void>((resolve) => { captured = resolve; });
    const actual = f.knowledge.evidence.observations!;
    const reports = { ...f.knowledge.evidence, observations: { ...actual, async observe(...args: Parameters<typeof actual.observe>) {
      await capturedGov; await changeTrust(f, kind); return actual.observe(...args);
    } } };
    const capability = retests(f, { reports: () => reports, async readGovernance(collectionId) { const value = await currentGovernance(f, collectionId); captured(); return value; } });
    expect(await capability.verifier.observe!(String(ack.receipt), binding, new AbortController().signal)).toBeNull();
  });

  it.each(['governance', 'staging', 'collection', 'policy'] as const)('refuses %s changes after the actual report opens but before fresh governance capture', async (kind) => {
    const { f, ack, binding } = await retainedRetest();
    let captured!: () => void;
    const capturedReport = new Promise<void>((resolve) => { captured = resolve; });
    const actual = f.knowledge.evidence.observations!;
    const reports = { ...f.knowledge.evidence, observations: { ...actual, async observe(...args: Parameters<typeof actual.observe>) {
      const value = await actual.observe(...args); captured(); return value;
    } } };
    const capability = retests(f, { reports: () => reports, async readGovernance(collectionId) { await capturedReport; await changeTrust(f, kind); return currentGovernance(f, collectionId); } });
    expect(await capability.verifier.observe!(String(ack.receipt), binding, new AbortController().signal)).toBeNull();
  });

  it.each(['collection', 'policy-id', 'policy-version'] as const)('refuses a stale or wrong %s scheduling coordinate without treating it as authority', async (change) => {
    const { f, ack, binding } = await retainedRetest();
    const records = f.store.collection(supportFollowupRetestReceipts);
    const saved = (await records.list(f.f.identity.ticketId)).find((value) => value.kind === 'receipt');
    if (saved?.kind !== 'receipt' || !saved.readHint) throw new Error('Actual coordinate hint required');
    const hint = structuredClone(saved.readHint);
    if (change === 'collection') hint.collectionId = 'wrong-collection';
    else if (change === 'policy-id') hint.validationPolicy.id = 'wrong-policy';
    else hint.validationPolicy.version += 1;
    await records.put({ ...saved, readHint: hint });
    expect(await f.source.retests!.verifier.observe!(String(ack.receipt), binding, new AbortController().signal)).toBeNull();
  });

  it('retains a complete fresh sequential fallback for legacy receipts without scheduling coordinates', async () => {
    const { f, ack, binding } = await retainedRetest();
    const records = f.store.collection(supportFollowupRetestReceipts);
    const saved = (await records.list(f.f.identity.ticketId)).find((value) => value.kind === 'receipt');
    if (saved?.kind !== 'receipt') throw new Error('Actual saved receipt required');
    const { readHint: _hint, ...legacy } = saved;
    await records.put(legacy);
    const events: string[] = [];
    const actual = f.knowledge.evidence.observations!;
    const reports = { ...f.knowledge.evidence, observations: { ...actual, async observe(...args: Parameters<typeof actual.observe>) {
      const value = await actual.observe(...args); events.push('report-ready'); return value;
    } } };
    const capability = retests(f, { reports: () => reports, readGovernance(collectionId) { events.push('gov-started'); return currentGovernance(f, collectionId); } });
    const observed = await capability.verifier.observe!(String(ack.receipt), binding, new AbortController().signal);
    expect(observed).not.toBeNull();
    expect(events.indexOf('gov-started')).toBeGreaterThan(events.indexOf('report-ready'));
    expect(await observed!.confirm(new AbortController().signal)).toBeTypeOf('function');
  });

  it.each(['flag', 'raw-scope'] as const)('refuses current %s withdrawal during overlapping opening awaits', async (change) => {
    const { f, ack, binding } = await retainedRetest();
    let captured!: () => void;
    const capturedGov = new Promise<void>((resolve) => { captured = resolve; });
    const actual = f.knowledge.evidence.observations!;
    const reports = { ...f.knowledge.evidence, observations: { ...actual, async observe(...args: Parameters<typeof actual.observe>) {
      await capturedGov;
      const value = await actual.observe(...args);
      if (change === 'flag') Reflect.set(f.environment, 'PEGMA_SUPPORT_RELEASE_FOLLOWUP_ENABLED', 'false');
      else Reflect.set(f.environment, 'SUPPORT_LEARNING_SOURCE_CONFIGURATION_JSON', 'changed-current-scope');
      return value;
    } } };
    const capability = retests(f, { reports: () => reports, async readGovernance(collectionId) { const value = await currentGovernance(f, collectionId); captured(); return value; } });
    const observed = await capability.verifier.observe!(String(ack.receipt), binding, new AbortController().signal);
    expect(observed).not.toBeNull();
    await expect(observed!.confirm(new AbortController().signal)).rejects.toThrow('Current governance authority unavailable');
  });
  it('keeps full current private data rereads for a legacy reader without a paired authority capability', async () => {
    const { f, packet } = await prepared();
    let reads = 0;
    const capability = retests(f, { async readGovernance(collectionId) {
      reads++;
      const current = await f.access('admin');
      const value = await f.knowledge.application.getGovernanceConfiguration(current, { collectionId });
      const validationPolicy = await f.knowledge.application.getValidationPolicy(current, { policyId: value.configuration.validationPolicy.id });
      return { ...value, validationPolicy };
    } });
    expect(await capability.prepare(f.context, f.f.identity.ticketId, packet)).toHaveProperty('receipt');
    expect(reads).toBe(2);
  });

  it('refuses unavailable current privileged authority before consuming the actual KB pair', async () => {
    const { f, packet } = await prepared();
    const actual = f.knowledge.evidence.observations!;
    const confirm = vi.fn(actual.confirm.bind(actual));
    const reports = { ...f.knowledge.evidence, observations: { ...actual, confirm } };
    const capability = retests(f, { reports: () => reports, async readGovernance(collectionId) {
      const value = await f.knowledge.application.getGovernanceConfiguration(f.admin, { collectionId });
      const validationPolicy = await f.knowledge.application.getValidationPolicy(f.admin, { policyId: value.configuration.validationPolicy.id });
      return { ...value, validationPolicy, confirmAuthority: async () => false as const };
    } });
    await expect(capability.prepare(f.context, f.f.identity.ticketId, packet)).rejects.toMatchObject({ status: 503, code: 'followup_retest_unavailable' });
    expect(confirm).not.toHaveBeenCalled();
    expect(await f.store.collection(supportFollowupRetestReceipts).list(f.f.identity.ticketId)).toEqual([]);
  });

  it('refuses a Source configuration change during the final actual KB confirmation using its synchronous authority tail', async () => {
    const { f, packet } = await prepared();
    const actual = f.knowledge.evidence.observations!;
    let confirmed = false;
    const reports = { ...f.knowledge.evidence, observations: { ...actual,
      async confirm(...args: Parameters<typeof actual.confirm>) {
        const value = await actual.confirm(...args);
        confirmed = true;
        Reflect.set(f.environment, 'PEGMA_SUPPORT_RELEASE_FOLLOWUP_ENABLED', 'false');
        return value;
      },
    } };
    const capability = retests(f, { reports: () => reports });
    await expect(capability.prepare(f.context, f.f.identity.ticketId, packet)).rejects.toThrow('Current governance authority unavailable');
    expect(confirmed).toBe(true);
    expect(await f.store.collection(supportFollowupRetestReceipts).list(f.f.identity.ticketId)).toEqual([]);
  });
  it.each(['governance', 'policy'] as const)('refuses current %s trust changed between receipt preparation and SDK consumption', async (kind) => {
    const { f, work, packet } = await prepared();
    const response = await f.api(f.request('retest-receipt', packet));
    expect(response.status).toBe(200);
    const ack = engineeringHttpResult(await engineeringHttpObject(response));
    await changeTrust(f, kind);
    expect((await f.api(f.request('retest', { commandId: crypto.randomUUID(), workId: work.workId, retestRequestId: packet.retestRequestId, receiptReference: ack.receipt }))).status).toBe(409);
    expect((await f.host.application.readEngineeringFollowupWork(f.staff, { ticketId: work.ticketId, workId: work.workId })).retestResults).toEqual([]);
  });

  it.each(['governance', 'policy'] as const)('closes the exact current %s resource after the operation-local report observation', async (kind) => {
    const { f, observation } = await observedRetest();
    await changeTrust(f, kind);
    await expect(observation.confirm(new AbortController().signal)).rejects.toThrow();
  });
  it('refuses a genuinely confirmed report from a runner outside the current private check policy', async () => {
    const { f, packet, report } = await prepared('passed', true, 'fictional-untrusted-runner');
    expect(report.status).toBe('confirmed');
    expect(report.evidence.runnerId).toBe('fictional-untrusted-runner');
    expect((await f.api(f.request('retest-receipt', packet))).status).toBe(409);
    expect(await f.store.collection(supportFollowupRetestReceipts).list(f.f.identity.ticketId)).toEqual([]);
  });
  it('distinguishes unavailable governance from a changed actual report and writes no association', async () => {
    const { f, packet } = await prepared();
    const capability = retests(f, { readGovernance: async () => null });
    await expect(capability.prepare(f.context, f.f.identity.ticketId, packet)).rejects.toMatchObject({ status: 503, code: 'followup_retest_unavailable' });
    expect(await f.store.collection(supportFollowupRetestReceipts).list(f.f.identity.ticketId)).toEqual([]);
  });

  it('expires an abandoned staged intent without starting a fresh command or rereading the report', async () => {
    const { f, packet } = await prepared();
    const counted = countedReports(f);
    const capability = retests(f, { stagedPreparation: true, reports: () => counted.reports });
    const pending = await capability.prepare(f.context, f.f.identity.ticketId, packet);
    expect(pending).toMatchObject({ pending: 'report' });
    const intent = (await f.store.collection(supportFollowupRetestReceipts).list(f.f.identity.ticketId)).find((value) => value.kind === 'intent');
    if (intent?.kind !== 'intent' || !intent.preparedAt) throw new Error('Actual dated intent required');
    const clock = vi.spyOn(f.f.clock, 'now').mockReturnValue(new Date(Date.parse(intent.preparedAt) + SUPPORT_FOLLOWUP_RETEST_INTENT_MS).toISOString());
    try {
      await expect(capability.prepare(f.context, f.f.identity.ticketId, packet)).rejects.toMatchObject({ status: 410, code: 'followup_retest_expired' });
      expect(counted.observe).not.toHaveBeenCalled();
    } finally { clock.mockRestore(); }
  });

  it('redacts accepted and abandoned coordinates/Audit after24h while exact-command hashes prevent reexecution', async () => {
    const { f, packet } = await prepared();
    const counted = countedReports(f);
    const capability = retests(f, { stagedPreparation: true, reports: () => counted.reports });
    await capability.prepare(f.context, f.f.identity.ticketId, packet);
    const ack = await capability.prepare(f.context, f.f.identity.ticketId, packet);
    expect(ack).toHaveProperty('receipt');
    const abandoned = { ...packet, commandId: crypto.randomUUID() };
    await capability.prepare(f.context, f.f.identity.ticketId, abandoned);
    const before = await f.store.collection(supportFollowupRetestReceipts).list(f.f.identity.ticketId);
    const saved = before.find((value) => value.kind === 'receipt');
    if (saved?.kind !== 'receipt') throw new Error('Actual saved receipt required');
    expect(Date.parse(saved.retainUntil!) - Date.parse(saved.verifiedAt)).toBe(SUPPORT_FOLLOWUP_RETEST_RETENTION_MS);
    const due = Math.max(...before.flatMap((value) => value.kind === 'receipt' || value.kind === 'intent' ? [Date.parse(value.retainUntil!)] : []));
    const clock = vi.spyOn(f.f.clock, 'now').mockReturnValue(new Date(due + 1).toISOString());
    counted.observe.mockClear();
    try {
      await cleanupSupportFollowupRetests({ store: f.store, clock: f.f.clock }, { limit: 8 });
      const after = await f.store.collection(supportFollowupRetestReceipts).list(f.f.identity.ticketId);
      expect(after.map((value) => value.kind).sort()).toEqual(['capacity', 'tombstone', 'tombstone']);
      expect(JSON.stringify(after)).not.toContain(packet.report.reportId);
      expect(JSON.stringify(after)).not.toContain(packet.report.receipt);
      expect(JSON.stringify(after)).not.toContain(packet.workId);
      expect(JSON.stringify(after)).not.toContain(f.staff.principalId);
      expect(JSON.stringify(after)).not.toContain(f.collectionId);
      for (const input of [packet, abandoned]) await expect(capability.prepare(f.context, f.f.identity.ticketId, input)).rejects.toMatchObject({ status: 410, code: 'followup_retest_expired' });
      await expect(capability.prepare(f.context, f.f.identity.ticketId, { ...packet, retestRequestId: 'changed' })).rejects.toMatchObject({ status: 409, code: 'conflict' });
      expect(counted.observe).not.toHaveBeenCalled();
    } finally { clock.mockRestore(); }
  });

  it('atomically admits only the last capacity slot for concurrent same-ticket preparations and preserves accepted replay', async () => {
    const { f, packet } = await prepared();
    await f.store.collection(rawRetests).put({ kind: 'capacity', ticketId: f.f.identity.ticketId, id: 'capacity', payload: JSON.stringify({ kind: 'capacity', ticketId: f.f.identity.ticketId, id: 'capacity', admitted: SUPPORT_FOLLOWUP_RETEST_CAPACITY - 1 }) });
    let reads = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const racing: Store = { collection(definition) {
      const records = f.store.collection(definition);
      if (definition.name !== supportFollowupRetestReceipts.name) return records;
      return { ...records, async getVersioned(key) {
        const value = await records.getVersioned(key);
        if (key.id === 'capacity' && reads < 2) { reads++; if (reads === 2) release(); await barrier; }
        return value;
      } };
    } };
    const capability = retests(f, { store: racing, stagedPreparation: true });
    const other = { ...packet, commandId: crypto.randomUUID() };
    const results = await Promise.allSettled([capability.prepare(f.context, f.f.identity.ticketId, packet), capability.prepare(f.context, f.f.identity.ticketId, other)]);
    expect(results.filter((value) => value.status === 'fulfilled')).toHaveLength(1);
    const acceptedIndex = results.findIndex((value) => value.status === 'fulfilled');
    const accepted = acceptedIndex === 0 ? packet : other;
    const rows = await f.store.collection(supportFollowupRetestReceipts).list(f.f.identity.ticketId);
    expect(rows.filter((value) => value.kind === 'intent')).toHaveLength(1);
    expect(rows.find((value) => value.kind === 'capacity')).toMatchObject({ admitted: SUPPORT_FOLLOWUP_RETEST_CAPACITY });
    await expect(capability.prepare(f.context, f.f.identity.ticketId, { ...packet, commandId: crypto.randomUUID() })).rejects.toMatchObject({ status: 429, code: 'followup_retest_capacity' });
    // The accepted command may finish its explicitly requested second phase;
    // the lifetime admission ceiling only refuses distinct new commands.
    expect(await capability.prepare(f.context, f.f.identity.ticketId, accepted)).toHaveProperty('receipt');
  });
  it.each(['note', 'priority'] as const)(
    'prepares and records an exact Work-bound retest after an unrelated ticket %s advances its revision',
    async (change) => {
      const { f, work, packet } = await prepared();
      const command = {
        ticketId: work.ticketId,
        commandId: crypto.randomUUID(),
        correlationId: 'fictional-unrelated-ticket-change',
        expectedRevision: packet.expectedTicketRevision,
      };
      const changed =
        change === 'note'
          ? await f.host.application.addNote(f.staff, {
              ...command,
              messageId: crypto.randomUUID(),
              body: 'Fictional internal handoff note.',
            })
          : await f.host.application.changePriority(f.staff, {
              ...command,
              priority: 'urgent',
            });
      expect(changed.ticket.revision).toBeGreaterThan(
        packet.expectedTicketRevision,
      );
      const current = await f.host.application.readEngineeringFollowupWork(
        f.staff,
        {
          ticketId: work.ticketId,
          workId: work.workId,
        },
      );
      expect(current.workGeneration).toBe(packet.expectedWorkGeneration);
      expect(current.acceptedTicketRevision).toBe(
        packet.expectedTicketRevision,
      );
      const response = await f.api(f.request('retest-receipt', packet));
      expect(response.status).toBe(200);
      const ack = engineeringHttpResult(await engineeringHttpObject(response));
      const submitted = await f.api(
        f.request('retest', {
          commandId: crypto.randomUUID(),
          workId: work.workId,
          retestRequestId: packet.retestRequestId,
          receiptReference: ack.receipt,
        }),
      );
      expect(submitted.status).toBe(200);
      expect(
        engineeringHttpResult(await engineeringHttpObject(submitted)),
      ).toMatchObject({
        outcome: 'recorded',
        result: 'passed',
      });
      expect(
        (
          await f.api(
            f.request('retest-receipt', {
              ...packet,
              commandId: crypto.randomUUID(),
              expectedTicketRevision: changed.ticket.revision,
            }),
          )
        ).status,
      ).toBe(409);
    },
  );

  it('rechecks the real report when its operation-local confirmation closes after reset', async () => {
    const { f, packet, observation } = await observedRetest();
    expect(observation.verified.result).toBe('passed');
    await f.knowledge.evidence.reset(f.staff, {
      articleId: f.articleId,
      commandId: crypto.randomUUID(),
      expectedLedgerEpoch: packet.report.ledgerEpoch,
    });
    await expect(
      observation.confirm(new AbortController().signal),
    ).rejects.toThrow();
  });

  it('keeps the actual KB handle single-use and rechecks Source and expiry synchronously at handoff', async () => {
    const { f, observation } = await observedRetest();
    const assertion = await observation.confirm(new AbortController().signal);
    expect(assertion).toBeTypeOf('function');
    if (typeof assertion !== 'function')
      throw new Error('Final host assertion required');
    expect(assertion()).toBe(true);
    await expect(
      observation.confirm(new AbortController().signal),
    ).rejects.toThrow();
    const clock = vi
      .spyOn(f.f.clock, 'now')
      .mockReturnValue(observation.verified.validUntil);
    try {
      expect(assertion).toThrow();
    } finally {
      clock.mockRestore();
    }
    Reflect.set(
      f.environment,
      'PEGMA_SUPPORT_RELEASE_FOLLOWUP_ENABLED',
      'false',
    );
    expect(assertion).toThrow();
  });

  it('records a confirmed passed report through normal authenticated routes with models OFF', async () => {
    const { f, work, packet } = await prepared();
    const calls = f.f.state.modelCalls;
    f.composition.configuration.generation.model.generate = async () => {
      throw new Error('Models are OFF');
    };
    const response = await f.api(f.request('retest-receipt', packet));
    expect(response.status).toBe(200);
    const ack = engineeringHttpResult(await engineeringHttpObject(response));
    expect(Object.keys(ack).sort()).toEqual([
      'actorId',
      'commandId',
      'receipt',
      'retestRequestId',
      'ticketId',
      'validUntil',
      'workId',
    ]);
    const resultPacket = {
      commandId: crypto.randomUUID(),
      workId: work.workId,
      retestRequestId: packet.retestRequestId,
      receiptReference: ack.receipt,
    };
    const submitted = await f.api(f.request('retest', resultPacket));
    expect(submitted.status).toBe(200);
    expect(
      engineeringHttpResult(await engineeringHttpObject(submitted)),
    ).toMatchObject({ outcome: 'recorded', result: 'passed' });
    expect(f.f.state.modelCalls).toBe(calls);
    const rows = await f.store
      .collection(supportFollowupRetestReceipts)
      .list(f.f.identity.ticketId);
    expect(rows).toHaveLength(3);
    expect(JSON.stringify(rows)).not.toContain(
      'PRIVATE_RETEST_BODY_NEVER_COPIED_TO_RECEIPT',
    );
    const replay = await f.api(f.request('retest', resultPacket));
    expect(replay.status).toBe(200);
    expect(
      engineeringHttpResult(await engineeringHttpObject(replay)),
    ).toMatchObject({ result: 'passed' });
  });
  it('requires genuine staff confirmation, exact report generation and the original actor', async () => {
    const { f, packet } = await prepared('passed', false);
    expect((await f.api(f.request('retest-receipt', packet))).status).toBe(409);
    expect(
      (
        await f.api(
          f.request('retest-receipt', {
            ...packet,
            expectedPrincipalId: f.peer.principalId,
          }),
        )
      ).status,
    ).toBe(403);
    expect(
      (await f.api(f.request('retest-receipt', { ...packet, extra: true })))
        .status,
    ).toBe(400);
  });
  it('records an actual failed report as failed and never manufactures a successful result', async () => {
    const { f, work, packet } = await prepared('failed');
    const response = await f.api(f.request('retest-receipt', packet));
    expect(response.status).toBe(200);
    const ack = engineeringHttpResult(await engineeringHttpObject(response));
    const submitted = await f.api(
      f.request('retest', {
        commandId: crypto.randomUUID(),
        workId: work.workId,
        retestRequestId: packet.retestRequestId,
        receiptReference: ack.receipt,
      }),
    );
    expect(submitted.status).toBe(200);
    expect(
      engineeringHttpResult(await engineeringHttpObject(submitted)),
    ).toMatchObject({ result: 'failed' });
  });

  it('denies a withdrawn release mapping and a reset report before any SDK retest result is recorded', async () => {
    const { f, work, packet } = await prepared();
    const response = await f.api(f.request('retest-receipt', packet));
    expect(response.status).toBe(200);
    const ack = engineeringHttpResult(await engineeringHttpObject(response));
    await f.source.mappings!.withdraw(f.context, work.ticketId, {
      commandId: crypto.randomUUID(),
      expectedPrincipalId: f.staff.principalId,
      expectedTicketRevision: work.acceptedTicketRevision,
      expectedMappingGeneration: 1,
      ...f.f.identity.association,
      reason: 'Explicit staff rollback observation',
    });
    const submitted = await f.api(
      f.request('retest', {
        commandId: crypto.randomUUID(),
        workId: work.workId,
        retestRequestId: packet.retestRequestId,
        receiptReference: ack.receipt,
      }),
    );
    expect(submitted.status).toBe(409);
    expect(
      (
        await f.host.application.readEngineeringFollowupWork(f.staff, {
          ticketId: work.ticketId,
          workId: work.workId,
        })
      ).retestResults,
    ).toEqual([]);
    await f.knowledge.evidence.reset(f.staff, {
      articleId: f.articleId,
      commandId: crypto.randomUUID(),
      expectedLedgerEpoch: packet.report.ledgerEpoch,
    });
    expect(
      (
        await f.api(
          f.request('retest-receipt', {
            ...packet,
            commandId: crypto.randomUUID(),
          }),
        )
      ).status,
    ).toBe(409);
  });

  it('uses normal same-origin CSRF, current Support role and exact command replay guards', async () => {
    const { f, packet } = await prepared();
    const missingCsrf = f.request('retest-receipt', packet);
    missingCsrf.headers.delete('X-Pegma-CSRF');
    expect((await f.api(missingCsrf)).status).toBe(403);
    expect(
      (await f.api(f.request('retest-receipt', packet, 'knowledge'))).status,
    ).toBe(403);
    const response = await f.api(f.request('retest-receipt', packet));
    expect(response.status).toBe(200);
    const accepted = engineeringHttpResult(
      await engineeringHttpObject(response),
    );
    const replay = await f.api(
      f.request('retest-receipt', structuredClone(packet)),
    );
    expect(replay.status).toBe(200);
    expect(engineeringHttpResult(await engineeringHttpObject(replay))).toEqual(
      accepted,
    );
    expect(
      (
        await f.api(
          f.request('retest-receipt', {
            ...packet,
            retestRequestId: 'different-request',
          }),
        )
      ).status,
    ).toBe(409);
    await f.f.f.revoke('staff', 'Support');
    expect((await f.api(f.request('retest-receipt', packet))).status).toBe(403);
  });
  it('closes the original real browser session after paired report verification and before the SDK retest commit', async () => {
    const { f, work, packet } = await prepared();
    const response = await f.api(f.request('retest-receipt', packet));
    expect(response.status).toBe(200);
    const ack = engineeringHttpResult(await engineeringHttpObject(response));
    const original = crypto.subtle.digest.bind(crypto.subtle);
    let destroyed = false;
    const hook = vi
      .spyOn(crypto.subtle, 'digest')
      .mockImplementation(async (algorithm, data) => {
        const result = await original(algorithm, data);
        const bytes = ArrayBuffer.isView(data)
          ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
          : new Uint8Array(data);
        if (
          !destroyed &&
          new TextDecoder()
            .decode(bytes)
            .includes('"verifierReceiptId":"pgretest1.')
        ) {
          destroyed = true;
          await f.f.f.sessions.destroy(
            f.f.f.cookies.get('staff')!.split('=')[1]!,
          );
        }
        return result;
      });
    try {
      const submitted = await f.api(
        f.request('retest', {
          commandId: crypto.randomUUID(),
          workId: work.workId,
          retestRequestId: packet.retestRequestId,
          receiptReference: ack.receipt,
        }),
      );
      expect(destroyed).toBe(true);
      expect(submitted.status).toBe(401);
      expect(
        (
          await f.host.application.readEngineeringFollowupWork(f.staff, {
            ticketId: work.ticketId,
            workId: work.workId,
          })
        ).retestResults,
      ).toEqual([]);
    } finally {
      hook.mockRestore();
    }
  });
  it('records an actual failed handoff retest after delivery without unsending or automatically reviving work', async () => {
    const { f, work, packet } = await prepared();
    const ready = await f.api(f.request('retest-receipt', packet));
    const ack = engineeringHttpResult(await engineeringHttpObject(ready));
    expect(
      (
        await f.api(
          f.request('retest', {
            commandId: crypto.randomUUID(),
            workId: work.workId,
            retestRequestId: packet.retestRequestId,
            receiptReference: ack.receipt,
          }),
        )
      ).status,
    ).toBe(200);
    const current = await f.host.application.readEngineeringFollowupWork(
      f.staff,
      { ticketId: work.ticketId, workId: work.workId },
    );
    const messageId = crypto.randomUUID();
    expect(
      (
        await f.api(
          f.request('post', {
            commandId: crypto.randomUUID(),
            workId: work.workId,
            expectedWorkGeneration: current.workGeneration,
            expectedTicketRevision: current.acceptedTicketRevision,
            bundleHash: current.preparedBundle!.bundleHash,
            messageId,
          }),
        )
      ).status,
    ).toBe(200);
    const delivered = await f.host.application.readEngineeringFollowupWork(
      f.staff,
      { ticketId: work.ticketId, workId: work.workId },
    );
    expect(delivered.handoff?.retestRequests).toHaveLength(1);
    const report = await f.report('failed');
    const failed = {
      commandId: crypto.randomUUID(),
      expectedPrincipalId: f.staff.principalId,
      workId: work.workId,
      expectedWorkGeneration: delivered.workGeneration,
      expectedTicketRevision: delivered.delivered!.ticketRevision,
      retestRequestId: packet.retestRequestId,
      report: {
        articleId: report.articleId,
        ledgerEpoch: report.ledgerEpoch,
        reportId: report.reportId,
        expectedReportGeneration: report.reportGeneration,
        reviewBindingHash: report.reviewBindingHash,
        receipt: report.receipt,
      },
    };
    const preparedFailure = await f.api(f.request('retest-receipt', failed));
    expect(preparedFailure.status).toBe(200);
    const failureAck = engineeringHttpResult(
      await engineeringHttpObject(preparedFailure),
    );
    const result = await f.api(
      f.request('retest', {
        commandId: crypto.randomUUID(),
        workId: work.workId,
        retestRequestId: packet.retestRequestId,
        receiptReference: failureAck.receipt,
      }),
    );
    expect(result.status).toBe(200);
    expect(
      engineeringHttpResult(await engineeringHttpObject(result)),
    ).toMatchObject({ result: 'failed' });
    const retained = await f.host.application.readEngineeringFollowupWork(
      f.staff,
      { ticketId: work.ticketId, workId: work.workId },
    );
    expect(retained.status).toBe('delivered');
    expect(retained.heldReason).toBe('retest_failed');
    expect(retained.retestResults).toMatchObject([
      { requestId: packet.retestRequestId, result: 'failed' },
    ]);
    expect(
      (
        await f.host.application.readStaffTicket(f.staff, work.ticketId)
      ).messages.filter((message) => message.id === messageId),
    ).toHaveLength(1);
  });
});
