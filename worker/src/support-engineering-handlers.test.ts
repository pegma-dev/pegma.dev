import { supportPermissions } from '@pegma/support-desk-application';
import { describe, expect, it, vi } from 'vitest';
import { IDENTITY_ISSUER } from './identity-api';
import { isPlainObject } from './api-auth';
import { ADMIN_ROLE, APPLICATION_SCOPE, SUPPORT_ROLE } from './support-access';
import { controlledHumanBody } from './support-human-control-fixtures';
import { engineeringCanary, engineeringProofReference, engineeringRepositories, engineeringTicketId } from './support-engineering-fixtures';
import { createSupportEngineeringHandlers } from './support-engineering-handlers';
import { createSupportEngineeringRuntime } from './support-engineering';
import {
  createSupportEngineeringHttpFixture, engineeringHttpCommand, engineeringHttpNumber,
  engineeringHttpObject, engineeringHttpResult, engineeringHttpRoute,
} from './support-engineering-http-fixtures';

const fixture = createSupportEngineeringHttpFixture;
const object = engineeringHttpObject;
const result = engineeringHttpResult;
const number = engineeringHttpNumber;

function selectionPacket(work: Record<string, unknown>, key: string) {
  const selected = work.selection;
  if (!isPlainObject(selected) || !Array.isArray(selected.repositoryChoices))
    throw new Error('Expected actual immutable repository choices');
  const choice: unknown = selected.repositoryChoices.find((value: unknown) => isPlainObject(value) && value.key === key);
  if (!isPlainObject(choice)) throw new Error('Expected the configured choice');
  return { repositoryKey: choice.key, repositoryId: choice.repositoryId,
    repositoryDescriptorHash: choice.descriptorHash,
    policyGeneration: selected.policyGeneration, policyHash: selected.policyHash };
}

function useApplication(f: Awaited<ReturnType<typeof fixture>>, application: typeof f.engineering.application) {
  f.state.runtime = createSupportEngineeringRuntime({ application, clock: f.engineering.clock,
    staffAccess: { resolve: (id) => f.resolve(id) }, ports: f.engineering.ports,
    processingEnabled: () => false });
}

function firstIntentRepository(packet: { intent: Record<string, unknown> }) {
  const policy = packet.intent.policy;
  if (!isPlainObject(policy) || !Array.isArray(policy.repositories)) throw new Error('Expected prepared full policy');
  const first: unknown = policy.repositories[0];
  if (!isPlainObject(first)) throw new Error('Expected prepared repository snapshot');
  return first;
}

describe('unregistered engineering HTTP through current real host authority', () => {
  it('defaults human routes OFF before lazy runtime construction and leaves worker routes unclaimed', async () => {
    const f = await fixture(); const { enabled, ...options } = f.options; void enabled;
    const handle = createSupportEngineeringHandlers(options);
    expect((await handle(f.request()))?.status).toBe(503); expect(f.state.runtimeCalls).toBe(0);
    for (const suffix of ['proposal', 'review']) {
      const response = await handle(new Request(IDENTITY_ISSUER + engineeringHttpRoute + '/' + suffix));
      expect(response?.status).toBe(503);
      if (response === null) throw new Error('Expected owned human engineering route');
      expect(await object(response)).toEqual({ error: 'support_engineering_disabled' });
    }
    for (const suffix of ['dispatch', 'process'])
      expect(await handle(new Request(IDENTITY_ISSUER + engineeringHttpRoute + '/' + suffix))).toBeNull();
    expect(f.engineering.state.modelCalls).toBe(0); expect(f.engineering.state.creates).toEqual([]);
  });

  it('keeps human, administrator, Knowledge and service capabilities separate in the real role policy', async () => {
    const f = await fixture(); const staff = await f.resolve(f.principals.staff);
    const admin = await f.resolve(f.principals.admin); const both = await f.resolve(f.principals.both);
    expect(staff?.permissions).toContain(supportPermissions.engineeringRead);
    expect(staff?.permissions).not.toContain(supportPermissions.engineeringProcess);
    expect(staff?.permissions).not.toContain(supportPermissions.engineeringReconcile);
    expect(staff?.permissions).not.toContain(supportPermissions.engineeringRestrictedRead);
    expect(staff?.permissions).not.toContain(supportPermissions.engineeringSecurityReview);
    expect(admin?.permissions).not.toContain(supportPermissions.queueRead);
    expect(admin?.permissions).not.toContain(supportPermissions.engineeringRead);
    expect(both?.permissions).toContain(supportPermissions.engineeringPolicyManage);
    expect(both?.permissions).toContain(supportPermissions.queueRead);
  });

  it.each(['admin', 'knowledge', 'customer'] as const)('denies %s before a staff source factory call', async (actor) => {
    const f = await fixture(); expect((await f.send(f.request('', undefined, actor))).status).toBe(403);
    expect(f.state.runtimeCalls).toBe(0);
  });

  it.each(['staff', 'admin', 'knowledge', 'customer'] as const)('denies policy access to %s without both current roles and SDK rights', async (actor) => {
    const f = await fixture(); expect((await f.send(f.request('policy', undefined, actor))).status).toBe(403);
    expect(f.state.runtimeCalls).toBe(0);
  });

  it('enrolls and records an actual verified failure with exact uppercase command replay', async () => {
    const f = await fixture(); const original = f.state.runtime;
    f.state.runtime = { ...original, async enroll(...args: Parameters<typeof original.enroll>) {
      f.state.captured.push(args[1].clientCommandId); return original.enroll(...args);
    } };
    const ticket = await f.engineering.createTicket();
    const packet = { commandId: engineeringHttpCommand, expectedRevision: ticket.revision };
    const accepted = await object(await f.send(f.request('enroll', packet))); const enrolledRows = await f.rows();
    expect(await object(await f.send(f.request('enroll', packet)))).toEqual(accepted);
    expect(await f.rows()).toEqual(enrolledRows);
    expect(f.state.captured).toEqual([engineeringHttpCommand, engineeringHttpCommand]);
    const evidence = { commandId: 'HTTP-FAILURE-EXACT', expectedRevision: ticket.revision, security: 'ordinary',
      expectedBehavior: 'The export contains rows.', actualBehavior: 'The downloaded file is empty.',
      reproductionSteps: ['Export the fictional workspace.'], visibleMessageIds: ['engineering-question'],
      verificationReference: engineeringProofReference };
    const first = await object(await f.send(f.request('evidence', evidence))); const rows = await f.rows();
    expect(result(first)).toMatchObject({ state: 'eligible', security: 'ordinary' });
    expect(await object(await f.send(f.request('evidence', evidence)))).toEqual(first);
    expect(await f.rows()).toEqual(rows);
    expect((await f.engineering.source()).evidence?.actorId).toBe(f.principals.staff);
    expect(JSON.stringify(first)).not.toContain(engineeringProofReference);
    expect(f.engineering.state.modelCalls).toBe(0); expect(f.engineering.state.creates).toEqual([]);
  });

  it('projects only operational fields from actual source and checked work records', async () => {
    const f = await fixture(); const accepted = await f.verified(); await f.prepared();
    const source = await object(await f.send(f.request()));
    const work = await object(await f.send(f.request('work', undefined, 'staff', '?sourceGeneration=' + accepted.key.sourceGeneration)));
    expect(result(source)).toMatchObject({ hasEvidence: true, hasProductContext: true });
    expect(result(work)).toMatchObject({ hasPreparedProposal: true, hasApproval: false, hasDispatch: false });
    for (const value of [source, work]) {
      for (const key of ['evidence', 'product', 'candidate', 'proposal', 'exactRequest', 'approval', 'dispatch', 'heldReason'])
        expect(result(value)).not.toHaveProperty(key);
      for (const privateText of [engineeringCanary, engineeringProofReference, 'Workspace export produces an empty file',
        'synthetic-approved-public-reproduction', 'checksReceipt', 'installationBinding'])
        expect(JSON.stringify(value)).not.toContain(privateText);
    }
    expect(f.engineering.state.creates).toEqual([]);
  });

  it('keeps uncertain evidence private even when the ordinary staff submitted it', async () => {
    const f = await fixture(); const accepted = await f.verified('uncertain');
    expect(accepted.source.state).toBe('restricted');
    for (const incoming of [f.request(), f.request('work', undefined, 'staff', '?sourceGeneration=' + accepted.key.sourceGeneration)]) {
      const response = await f.send(incoming); expect(response.status).toBe(403);
      expect(await object(response)).toEqual({ error: 'forbidden' });
    }
    expect((await f.rows()).filter((row) => row.kind === 'engineering_work')).toEqual([]);
    expect(f.engineering.state.modelCalls).toBe(0);
  });

  it('retains the actual trusted-product hold rather than accepting browser product claims', async () => {
    const f = await fixture(); f.engineering.state.product = 'missing';
    const accepted = await f.verified(); expect(accepted.source.state).toBe('held');
    expect((await f.rows()).filter((row) => row.kind === 'engineering_work')).toEqual([]);
    expect(f.engineering.state.modelCalls).toBe(0);
  });

  it.each(['Origin', 'Authorization', 'X-Pegma-CSRF', 'Cookie'] as const)('refuses invalid browser %s before an engineering write', async (header) => {
    const f = await fixture(); const ticket = await f.engineering.createTicket(); const before = await f.rows();
    const incoming = f.request('enroll', { commandId: 'BAD-BROWSER', expectedRevision: ticket.revision });
    incoming.headers.set(header, header === 'Origin' ? 'https://foreign.example' : header === 'Authorization' ? 'Bearer synthetic' : 'invalid');
    expect([401, 403]).toContain((await f.send(incoming)).status); expect(await f.rows()).toEqual(before);
  });

  it.each([{ actorId: 'forged' }, { productId: 'forged' }, { buildId: 'forged' }, { calibration: 'forged' },
    { verifiedAt: '2026-11-10T12:00:00Z' }, { correlationId: 'forged' }, { providerUrl: 'https://foreign.example' }])(
    'rejects authority/proof fields in the closed enrollment packet: %j', async (extra) => {
      const f = await fixture(); const ticket = await f.engineering.createTicket(); const before = await f.rows();
      expect((await f.send(f.request('enroll', { commandId: 'CLOSED-EXACT', expectedRevision: ticket.revision, ...extra }))).status).toBe(400);
      expect(await f.rows()).toEqual(before); expect(f.state.runtimeCalls).toBe(0);
    });

  it.each(['?sourceGeneration=0', '?sourceGeneration=1&sourceGeneration=1', '?sourceGeneration=9007199254740992',
    '?sourceGeneration=1&role=Admin'])('bounds a work key before runtime access: %s', async (query) => {
    const f = await fixture();
    expect((await f.send(f.request('work', undefined, 'staff', query))).status).toBe(400);
    expect(f.state.runtimeCalls).toBe(0);
  });

  it('rejects private visible-message references and changed fields under a retained command', async () => {
    const f = await fixture(); const accepted = await f.verified(); const before = await f.rows();
    expect((await f.send(f.request('evidence', { ...accepted.packet, actualBehavior: 'A changed report.' }))).status).toBe(409);
    expect((await f.send(f.request('evidence', { ...accepted.packet, commandId: 'PRIVATE-NOTE-DENIED',
      visibleMessageIds: ['engineering-note'] }))).status).toBe(409);
    expect(await f.rows()).toEqual(before);
  });

  it('uses exact selection fences and SDK receipt-first replay after current policy changes', async () => {
    const f = await fixture(); const accepted = await f.verified(); f.engineering.state.modelRouting = 'ambiguous';
    expect((await f.process()).outcome).toBe('candidate');
    const response = await f.send(f.request('work', undefined, 'staff', '?sourceGeneration=' + accepted.key.sourceGeneration));
    const view = result(await object(response));
    const packet = { commandId: 'SELECT-EXACT', sourceGeneration: accepted.key.sourceGeneration,
      expectedWorkGeneration: number(view.workGeneration), ...selectionPacket(view, engineeringRepositories[1]!.repositoryId),
      reason: 'Select the allowlisted download API.' };
    const first = await object(await f.send(f.request('repository', packet)));
    expect(result(first).status).toBe('candidate');
    const policy = await f.engineering.runtime.readPolicy(f.engineering.actors.admin);
    await f.engineering.runtime.disableExports(f.engineering.actors.admin, { clientCommandId: 'DISABLE-AFTER-SELECTION', expectedGeneration: policy.generation });
    const rows = await f.rows();
    expect(await object(await f.send(f.request('repository', packet)))).toEqual(first);
    expect(await f.rows()).toEqual(rows); expect(f.engineering.state.modelCalls).toBe(1);
    expect(f.engineering.state.creates).toEqual([]);
  });

  it('rejects arbitrary repository URLs or identities before changing a work target', async () => {
    const f = await fixture(); const accepted = await f.verified(); expect((await f.process()).outcome).toBe('candidate');
    const work = await f.work(); const before = await f.rows();
    const view = result(await object(await f.send(f.request('work', undefined, 'staff', '?sourceGeneration=' + accepted.key.sourceGeneration))));
    const packet = { commandId: 'UNKNOWN-REPOSITORY', sourceGeneration: accepted.key.sourceGeneration,
      expectedWorkGeneration: work.workGeneration, ...selectionPacket(view, engineeringRepositories[0]!.repositoryId),
      repositoryKey: 'https://foreign.example/repository', reason: 'Unapproved destination.' };
    expect((await f.send(f.request('repository', packet))).status).toBe(409);
    expect(await f.rows()).toEqual(before);
  });


  it('uses declarative server-only policy descriptors and replays independently of live metadata availability', async () => {
    const f = await fixture(); const policy = await f.engineering.runtime.readPolicy(f.engineering.actors.admin);
    const packet = { commandId: 'POLICY-EXACT-HTTP', expectedGeneration: policy.generation, enabled: true,
      repositoryKeys: [engineeringRepositories[0]!.repositoryId] };
    const retained = await f.preparePolicy(packet);
    const first = await object(await f.send(f.request('policy', retained, 'both')));
    expect(result(first).enabled).toBe(true);
    const actual = await f.engineering.runtime.readPolicy(f.engineering.actors.admin);
    expect(actual.policy.repositories).toEqual([engineeringRepositories[0]]);
    f.engineering.state.installationActive = false;
    const rows = await f.policyRows();
    expect(await object(await f.send(f.request('policy', retained, 'both')))).toEqual(first);
    expect(await f.policyRows()).toEqual(rows);
    const view = result(await object(await f.send(f.request('policy', undefined, 'both'))));
    expect(view.repositories).toEqual([{ key: engineeringRepositories[0]!.repositoryId, enabled: true }]);
    expect(view.catalog).toEqual(engineeringRepositories.map((descriptor) => ({ key: descriptor.repositoryId, enabled: true })));
    expect(JSON.stringify(view)).not.toContain('responsibilities'); expect(JSON.stringify(view)).not.toContain('installationBinding');
    expect(f.engineering.state.modelCalls).toBe(0); expect(f.engineering.state.creates).toEqual([]);
  });

  it('returns the full configured catalog after the actual durable policy is emptied', async () => {
    const f = await fixture();
    const retained = await f.preparePolicy({ commandId: 'EMPTY-POLICY-EXACT', expectedGeneration: 1,
      enabled: false, repositoryKeys: [] });
    const saved = await f.send(f.request('policy', retained, 'both'));
    expect(saved.status).toBe(200); const rows = await f.policyRows();
    const response = await f.send(f.request('policy', undefined, 'both'));
    expect(response.status).toBe(200);
    const view = result(await object(response));
    expect(view.repositories).toEqual([]); expect(view.unmappedRepositoryCount).toBe(0);
    expect(view.catalog).toEqual(engineeringRepositories.map((descriptor) => ({ key: descriptor.repositoryId, enabled: true })));
    expect(view.enabled).toBe(false); expect(await f.policyRows()).toEqual(rows);
    for (const field of ['owner', 'name', 'descriptor', 'visibility', 'installationBinding', 'responsibilities'])
      expect(JSON.stringify(view)).not.toContain('"' + field + '"');
  });

  it('prepares a complete actor-bound immutable policy packet without SDK policy/source writes', async () => {
    const f = await fixture(); const before = await f.policyRows(); const supportRows = await f.rows();
    const input = { commandId: engineeringHttpCommand, expectedGeneration: 1, enabled: true,
      repositoryKeys: [engineeringRepositories[1]!.repositoryId, engineeringRepositories[0]!.repositoryId] };
    const packet = await f.preparePolicy(input);
    expect(packet.intent).toEqual({ version: 1, actorId: f.principals.both, commandId: engineeringHttpCommand,
      expectedGeneration: 1, repositoryKeys: input.repositoryKeys,
      policy: { enabled: true, repositories: [engineeringRepositories[1], engineeringRepositories[0]] } });
    expect(await f.preparePolicy(input)).toEqual(packet);
    expect(await f.policyRows()).toEqual(before); expect(await f.rows()).toEqual(supportRows);
    expect(f.engineering.state.modelCalls).toBe(0); expect(f.engineering.state.creates).toEqual([]);
  });

  it('refuses a keys-only submit instead of reconstructing a mutable policy packet', async () => {
    const f = await fixture(); const before = await f.policyRows();
    const response = await f.send(f.request('policy', { commandId: 'OLD-KEYS-ONLY', expectedGeneration: 1,
      enabled: true, repositoryKeys: [engineeringRepositories[0]!.repositoryId] }, 'both'));
    expect(response.status).toBe(400); expect(await f.policyRows()).toEqual(before);
    expect(f.state.runtimeCalls).toBe(0);
  });

  it.each(['staff', 'admin', 'knowledge', 'customer'] as const)('does not disclose a full prepared policy to %s', async (actor) => {
    const f = await fixture(); const before = await f.policyRows();
    const response = await f.send(f.request('policy/prepare', { commandId: 'PREPARE-DENIED', expectedGeneration: 1,
      enabled: true, repositoryKeys: [engineeringRepositories[0]!.repositoryId] }, actor));
    expect(response.status).toBe(403); expect(await object(response)).toEqual({ error: 'forbidden' });
    expect(f.state.runtimeCalls).toBe(0); expect(await f.policyRows()).toEqual(before);
  });

  it.each(['changed-descriptor', 'removed-key'] as const)('recovers the exact lost policy ACK after deployment %s', async (change) => {
    const f = await fixture(); const retained = await f.preparePolicy({ commandId: 'POLICY-LOST-EXACT', expectedGeneration: 1,
      enabled: true, repositoryKeys: [engineeringRepositories[0]!.repositoryId] });
    const original = f.state.runtime; let lose = true;
    let accepted: Awaited<ReturnType<typeof original.putPolicy>> | undefined;
    f.state.runtime = { ...original, async putPolicy(...args: Parameters<typeof original.putPolicy>) {
      const value = await original.putPolicy(...args); accepted = value;
      if (lose) { lose = false; throw new Error('Synthetic committed policy ACK loss'); } return value;
    } };
    expect((await f.send(f.request('policy', retained, 'both'))).status).toBe(503);
    const before = await f.policyRows();
    const repositories = change === 'removed-key' ? [] : f.options.repositories.map((entry) => ({ ...entry,
      descriptor: { ...entry.descriptor, responsibilities: 'A changed current deployment description.' } }));
    const later = createSupportEngineeringHandlers({ ...f.options, repositories });
    const replay = await later(f.request('policy', retained, 'both'));
    expect(replay?.status).toBe(200); if (replay === null) throw new Error('Expected policy route');
    expect(result(await object(replay))).toEqual(accepted);
    expect(await f.policyRows()).toEqual(before);
    expect((await f.engineering.runtime.readPolicy(f.engineering.actors.admin)).policy.repositories)
      .toEqual([engineeringRepositories[0]]);
  });

  it('binds stale wrapper keys and their order to the actual SDK receipt without changing command identity', async () => {
    const f = await fixture(); const retained = await f.preparePolicy({ commandId: 'FULL-INTENT-EXACT', expectedGeneration: 1,
      enabled: true, repositoryKeys: engineeringRepositories.map((entry) => entry.repositoryId) });
    const first = await object(await f.send(f.request('policy', retained, 'both'))); const before = await f.policyRows();
    const changed = structuredClone(retained);
    changed.intent.repositoryKeys = [engineeringRepositories[1]!.repositoryId, engineeringRepositories[0]!.repositoryId];
    expect((await f.send(f.request('policy', changed, 'both'))).status).toBe(409);
    expect(await f.policyRows()).toEqual(before);
    expect(await object(await f.send(f.request('policy', retained, 'both')))).toEqual(first);
    expect(await f.policyRows()).toEqual(before);
  });

  it.each(['snapshot', 'key', 'actor', 'version', 'extra-field'] as const)('rejects a fresh altered policy intent %s', async (change) => {
    const f = await fixture(); const retained = await f.preparePolicy({ commandId: 'FRESH-INTENT-EXACT', expectedGeneration: 1,
      enabled: true, repositoryKeys: [engineeringRepositories[0]!.repositoryId] });
    const changed = structuredClone(retained); const before = await f.policyRows();
    if (change === 'snapshot') firstIntentRepository(changed).responsibilities = 'An unapproved descriptor.';
    else if (change === 'key') changed.intent.repositoryKeys = [engineeringRepositories[1]!.repositoryId];
    else if (change === 'actor') changed.intent.actorId = f.principals.staff;
    else if (change === 'version') changed.intent.version = 2;
    else firstIntentRepository(changed).installationProof = 'forged';
    const response = await f.send(f.request('policy', changed, 'both'));
    expect(response.status).toBe(change === 'actor' ? 403 : change === 'version' || change === 'extra-field' ? 400 : 409);
    expect(await f.policyRows()).toEqual(before);
  });

  it('does not submit an old-catalog snapshot as a fresh policy when no earlier receipt committed', async () => {
    const f = await fixture(); const retained = await f.preparePolicy({ commandId: 'FRESH-OLD-CATALOG', expectedGeneration: 1,
      enabled: true, repositoryKeys: [engineeringRepositories[0]!.repositoryId] });
    const later = createSupportEngineeringHandlers({ ...f.options, repositories: f.options.repositories.map((entry) => ({ ...entry,
      descriptor: { ...entry.descriptor, component: 'a-new-component' } })) });
    const before = await f.policyRows(); const response = await later(f.request('policy', retained, 'both'));
    expect(response?.status).toBe(409); expect(await f.policyRows()).toEqual(before);
  });

  it('rejects a future generation and a reordered full snapshot without a policy write', async () => {
    const f = await fixture(); const retained = await f.preparePolicy({ commandId: 'ORDERED-INTENT-EXACT', expectedGeneration: 1,
      enabled: true, repositoryKeys: engineeringRepositories.map((entry) => entry.repositoryId) });
    const before = await f.policyRows(); const future = structuredClone(retained); future.intent.expectedGeneration = 2;
    expect((await f.send(f.request('policy', future, 'both'))).status).toBe(409);
    const reordered = structuredClone(retained);
    if (!isPlainObject(reordered.intent.policy) || !Array.isArray(reordered.intent.policy.repositories))
      throw new Error('Expected actual full prepared snapshot');
    reordered.intent.policy.repositories.reverse();
    expect((await f.send(f.request('policy', reordered, 'both'))).status).toBe(409);
    expect(await f.policyRows()).toEqual(before);
  });

  it.each(['missing', 'pruned'] as const)('keeps an old %s policy receipt from creating a new commit', async (kind) => {
    const f = await fixture(); const retained = await f.preparePolicy({ commandId: 'OLD-RECEIPT-EXACT', expectedGeneration: 1,
      enabled: true, repositoryKeys: [engineeringRepositories[0]!.repositoryId] });
    if (kind === 'pruned') {
      expect((await f.send(f.request('policy', retained, 'both'))).status).toBe(200);
      f.engineering.advance(31 * 24 * 60 * 60 * 1_000);
      const pruned = await f.engineering.application.pruneRepositoryPolicyHistory(f.engineering.actors.admin, { limit: 64 });
      expect(pruned.deletedPairs).toBeGreaterThan(0);
      expect((await f.policyRows()).filter((row) => row.kind === 'engineering_policy_command')).toEqual([]);
    } else {
      await f.engineering.runtime.disableExports(f.engineering.actors.admin, { clientCommandId: 'OTHER-POLICY-ADVANCE', expectedGeneration: 1 });
    }
    const before = await f.policyRows();
    expect((await f.send(f.request('policy', retained, 'both'))).status).toBe(409);
    expect(await f.policyRows()).toEqual(before);
  });

  it('lets the actual SDK CAS reject a head advance after the actual late catalog guard', async () => {
    const f = await fixture(); const retained = await f.preparePolicy({ commandId: 'CAS-INTENT-EXACT', expectedGeneration: 1,
      enabled: true, repositoryKeys: [engineeringRepositories[0]!.repositoryId] });
    const application = f.engineering.application; let advanced = false;
    let racedRows: Awaited<ReturnType<typeof f.policyRows>> | undefined;
    useApplication(f, { ...application, putRepositoryPolicy: (access, command, control) =>
      application.putRepositoryPolicy(access, command, { ...control, verifyBeforeCommit: async () => {
        const assertion = await control?.verifyBeforeCommit?.();
        if (!advanced) {
          advanced = true;
          await f.engineering.runtime.disableExports(f.engineering.actors.admin,
            { clientCommandId: 'CAS-COMPETITOR', expectedGeneration: command.expectedGeneration });
          racedRows = await f.policyRows();
        }
        return assertion;
      } }) });
    expect((await f.send(f.request('policy', retained, 'both'))).status).toBe(409);
    expect(advanced).toBe(true); expect(await f.policyRows()).toEqual(racedRows);
  });

  it.each([ADMIN_ROLE, SUPPORT_ROLE])('requires still-current %s before submitting a retained policy intent', async (role) => {
    const f = await fixture(); const retained = await f.preparePolicy({ commandId: 'REVOKED-INTENT-EXACT', expectedGeneration: 1,
      enabled: true, repositoryKeys: [] }); const before = await f.policyRows();
    await f.revoke('both', role);
    expect((await f.send(f.request('policy', retained, 'both'))).status).toBe(403);
    expect(await f.policyRows()).toEqual(before);
  });

  it.each(['logout', 'admin', 'queue', 'cookie'] as const)('rechecks %s after a retained policy body before its SDK head read', async (change) => {
    const f = await fixture(); const retained = await f.preparePolicy({ commandId: 'POLICY-BODY-IDENTITY-EXACT', expectedGeneration: 1,
      enabled: true, repositoryKeys: [engineeringRepositories[0]!.repositoryId] });
    const before = await f.policyRows(); const calls = f.state.runtimeCalls;
    const body = await controlledHumanBody(f.request('policy', retained, 'both')); const pending = f.send(body.request);
    try {
      await body.waitFor(pending);
      if (change === 'logout') await f.destroy('both');
      else if (change === 'admin') await f.revoke('both', ADMIN_ROLE);
      else if (change === 'queue') await f.revoke('both', SUPPORT_ROLE);
      else body.request.headers.set('Cookie', f.cookies.get('peer')!);
    } finally { body.complete(); }
    const response = await pending;
    expect(response.status).toBe(change === 'logout' ? 401 : 403);
    expect(await f.policyRows()).toEqual(before); expect(f.state.runtimeCalls).toBe(calls);
    expect(await object(response)).not.toHaveProperty('result');
  });

  it('accepts a genuine legal eight-repository UTF8 intent above64KiB through the policy-only128KiB reader', async () => {
    const f = await fixture(); const repositories = Array.from({ length: 8 }, (_value, index) => ({ key: 'Wide-' + index,
      descriptor: { ...engineeringRepositories[0]!, repositoryId: 'synthetic-wide-' + index,
        responsibilities: '界'.repeat(2_000), product: '界'.repeat(750) } }));
    const handle = createSupportEngineeringHandlers({ ...f.options, repositories });
    const prepared = await handle(f.request('policy/prepare', { commandId: 'WIDE-INTENT-EXACT', expectedGeneration: 1,
      enabled: true, repositoryKeys: repositories.map((entry) => entry.key) }, 'both'));
    expect(prepared?.status).toBe(200); if (prepared === null) throw new Error('Expected prepare route');
    const value = result(await object(prepared)); if (!isPlainObject(value.intent)) throw new Error('Expected full intent');
    const retained = { intent: value.intent };
    const bytes = new TextEncoder().encode(JSON.stringify(retained)).byteLength;
    expect(bytes).toBeGreaterThan(65_536); expect(bytes).toBeLessThanOrEqual(131_072);
    expect((await handle(f.request('policy', retained, 'both')))?.status).toBe(200);
    expect((await f.engineering.runtime.readPolicy(f.engineering.actors.admin)).policy.repositories).toHaveLength(8);
  });

  it('keeps policy submit physically bounded and requires CSRF even for read-only preparation', async () => {
    const f = await fixture(); const before = await f.policyRows();
    const incoming = f.request('policy/prepare', { commandId: 'PREPARE-CSRF', expectedGeneration: 1, enabled: true, repositoryKeys: [] }, 'both');
    incoming.headers.delete('X-Pegma-CSRF'); expect((await f.send(incoming)).status).toBe(403);
    expect((await f.send(f.request('policy', { intent: 'x'.repeat(131_073) }, 'both'))).status).toBe(413);
    expect(await f.policyRows()).toEqual(before);
  });

  it('reports an absent configured catalog and unmapped durable rows without silently rewriting them', async () => {
    const f = await fixture(); const before = await f.policyRows();
    const handle = createSupportEngineeringHandlers({ ...f.options, repositories: [] });
    const response = await handle(f.request('policy', undefined, 'both'));
    expect(response?.status).toBe(200);
    if (response === null) throw new Error('Expected owned policy route');
    const view = result(await object(response));
    expect(view.catalog).toEqual([]); expect(view.repositories).toEqual([]);
    expect(view.unmappedRepositoryCount).toBe(2); expect(await f.policyRows()).toEqual(before);
  });

  it('preserves catalog key case and accepts exactly twenty unique server entries without a policy write', async () => {
    const f = await fixture(); const before = await f.policyRows();
    const repositories = [
      { key: 'Core-V1', descriptor: engineeringRepositories[0]! },
      { key: 'API-v1', descriptor: engineeringRepositories[1]! },
      ...Array.from({ length: 18 }, (_value, index) => ({ key: 'Unused-' + index,
        descriptor: { ...engineeringRepositories[0]!, repositoryId: 'synthetic-unused-' + index } })),
    ];
    const handle = createSupportEngineeringHandlers({ ...f.options, repositories });
    const response = await handle(f.request('policy', undefined, 'both'));
    expect(response?.status).toBe(200);
    if (response === null) throw new Error('Expected owned policy route');
    const view = result(await object(response));
    expect(view.catalog).toEqual(repositories.map((entry) => ({ key: entry.key, enabled: true })));
    expect(view.repositories).toEqual([{ key: 'Core-V1', enabled: true }, { key: 'API-v1', enabled: true }]);
    expect(await f.policyRows()).toEqual(before);
  });

  it.each(['duplicate-key', 'duplicate-id', 'over-limit', 'empty-key', 'wide-key', 'control-key', 'empty-id'] as const)(
    'refuses invalid trusted catalog %s before a runtime or policy mutation', async (kind) => {
      const f = await fixture(); const before = await f.policyRows();
      const first = engineeringRepositories[0]!; const second = engineeringRepositories[1]!;
      const repositories = kind === 'duplicate-key' ? [{ key: 'same', descriptor: first }, { key: 'same', descriptor: second }]
        : kind === 'duplicate-id' ? [{ key: 'one', descriptor: first }, { key: 'two', descriptor: first }]
        : kind === 'over-limit' ? Array.from({ length: 21 }, (_value, index) => ({ key: 'entry-' + index,
          descriptor: { ...first, repositoryId: 'synthetic-entry-' + index } }))
        : [{ key: kind === 'empty-key' ? '' : kind === 'wide-key' ? 'x'.repeat(101) : kind === 'control-key' ? 'bad\u0000key' : 'valid-key',
          descriptor: kind === 'empty-id' ? { ...first, repositoryId: '' } : first }];
      expect(() => createSupportEngineeringHandlers({ ...f.options, repositories })).toThrow(TypeError);
      expect(f.state.runtimeCalls).toBe(0); expect(await f.policyRows()).toEqual(before);
    });

  it.each([{ publicationMode: 'automatic' }, { repositoryUrl: 'https://foreign.example' }, { metadataProof: 'forged' }])(
    'refuses client publication/routing authority in policy configuration: %j', async (extra) => {
      const f = await fixture(); const before = await f.policyRows();
      expect((await f.send(f.request('policy/prepare', { commandId: 'POLICY-DENIED', expectedGeneration: 1, enabled: true,
        repositoryKeys: [engineeringRepositories[0]!.repositoryId], ...extra }, 'both'))).status).toBe(400);
      expect(await f.policyRows()).toEqual(before); expect(f.engineering.state.creates).toEqual([]);
    });

  it('rejects unknown or duplicate server policy keys and stale generation without a write', async () => {
    const f = await fixture(); const before = await f.policyRows();
    for (const packet of [
      { commandId: 'POLICY-UNKNOWN', expectedGeneration: 1, enabled: true, repositoryKeys: ['not-configured'] },
      { commandId: 'POLICY-DUPLICATE', expectedGeneration: 1, enabled: true, repositoryKeys: [engineeringRepositories[0]!.repositoryId, engineeringRepositories[0]!.repositoryId] },
      { commandId: 'POLICY-STALE', expectedGeneration: 0, enabled: true, repositoryKeys: [] },
    ]) expect((await f.send(f.request('policy/prepare', packet, 'both'))).status).toBe(packet.commandId === 'POLICY-STALE' ? 409 : 400);
    expect(await f.policyRows()).toEqual(before);
  });

  it('keeps current metadata mandatory in the actual SDK after a declarative allowlist is configured', async () => {
    const f = await fixture(); await f.verified(); expect((await f.process()).outcome).toBe('candidate');
    f.engineering.state.installationActive = false;
    expect((await f.process()).outcome).toBe('held');
    expect((await f.work()).proposal).toBeUndefined(); expect(f.engineering.state.creates).toEqual([]);
  });

  it('disables exports through the SDK while model configuration is OFF', async () => {
    const f = await fixture(); f.engineering.state.enabled = false; f.engineering.state.configuration = 'disabled';
    const before = await f.engineering.runtime.readPolicy(f.engineering.actors.admin);
    const response = await f.send(f.request('policy/disable', { commandId: 'DISABLE-EXACT', expectedGeneration: before.generation }, 'both'));
    expect(response.status).toBe(200); expect(result(await object(response)).enabled).toBe(false);
    expect((await f.engineering.runtime.readPolicy(f.engineering.actors.admin)).policy.enabled).toBe(false);
  });

  it.each(['logout', 'role', 'header'] as const)('rechecks %s after a delayed body before enrollment', async (change) => {
    const f = await fixture(); const ticket = await f.engineering.createTicket(); const before = await f.rows();
    const body = await controlledHumanBody(f.request('enroll', { commandId: 'BODY-RACE', expectedRevision: ticket.revision }));
    const pending = f.send(body.request);
    try {
      await body.waitFor(pending);
      if (change === 'logout') await f.destroy('staff');
      else if (change === 'role') await f.revoke('staff', SUPPORT_ROLE);
      else body.request.headers.set('Cookie', f.cookies.get('peer')!);
    } finally { body.complete(); }
    expect([401, 403]).toContain((await pending).status); expect(await f.rows()).toEqual(before);
  });

  it('rechecks current authority after the real limiter before beginning the protected body/SDK operation', async () => {
    const f = await fixture(); const ticket = await f.legacyTicket(); const before = await f.rows();
    let revoked = false;
    const mutationLimiter = { ...f.options.mutationLimiter, async allow(...args: Parameters<typeof f.options.mutationLimiter.allow>) {
      const decision = await f.options.mutationLimiter.allow(...args);
      if (!revoked) { revoked = true; await f.revoke('staff', SUPPORT_ROLE); }
      return decision;
    } };
    const handle = createSupportEngineeringHandlers({ ...f.options, mutationLimiter });
    const response = await handle(f.request('enroll', { commandId: 'LIMITER-HANDOFF-EXACT', expectedRevision: ticket.revision }));
    expect(response?.status).toBe(403); expect(revoked).toBe(true);
    expect(await f.rows()).toEqual(before); expect(f.state.runtimeCalls).toBe(0);
  });

  it.each([ADMIN_ROLE, SUPPORT_ROLE])('rechecks %s at the actual policy commit callback after its head read', async (role) => {
    const f = await fixture(); const retained = await f.preparePolicy({ commandId: 'HEAD-AUTH-HANDOFF', expectedGeneration: 1,
      enabled: true, repositoryKeys: [engineeringRepositories[0]!.repositoryId] });
    const application = f.engineering.application; let revoked = false; const before = await f.policyRows();
    useApplication(f, { ...application, putRepositoryPolicy: (access, command, control) =>
      application.putRepositoryPolicy(access, command, { ...control, verifyBeforeCommit: async () => {
        if (!revoked) { revoked = true; await f.revoke('both', role); }
        return control?.verifyBeforeCommit?.();
      } }) });
    expect((await f.send(f.request('policy', retained, 'both'))).status).toBe(403);
    expect(revoked).toBe(true); expect(await f.policyRows()).toEqual(before);
  });

  it.each([ADMIN_ROLE, SUPPORT_ROLE])('rechecks %s after local intent hashing before any policy write', async (role) => {
    const f = await fixture(); const retained = await f.preparePolicy({ commandId: 'DIGEST-AUTH-HANDOFF', expectedGeneration: 1,
      enabled: true, repositoryKeys: [engineeringRepositories[0]!.repositoryId] });
    const before = await f.policyRows(); const original = f.state.runtime; let puts = 0;
    f.state.runtime = { ...original, async putPolicy(...args: Parameters<typeof original.putPolicy>) {
      puts += 1; return original.putPolicy(...args);
    } };
    let entered = false; let release = () => {};
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const target = JSON.stringify(retained.intent); const digest = crypto.subtle.digest.bind(crypto.subtle);
    const spy = vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (algorithm, bytes) => {
      if (!entered && new TextDecoder().decode(bytes) === target) { entered = true; await hold; }
      return digest(algorithm, bytes);
    });
    const pending = f.send(f.request('policy', retained, 'both'));
    try {
      await vi.waitFor(() => expect(entered).toBe(true), { timeout: 3_000 });
      await f.revoke('both', role); release();
      const response = await pending;
      expect(response.status).toBe(403); expect(puts).toBe(0);
      expect(await f.policyRows()).toEqual(before); expect(await object(response)).not.toHaveProperty('result');
    } finally { release(); try { await pending; } finally { spy.mockRestore(); } }
  });

  it('withholds a committed enrollment ACK after actual role revocation without inventing rollback', async () => {
    const f = await fixture(); const ticket = await f.legacyTicket();
    expect((await f.rows()).some((row) => row.kind === 'engineering_source')).toBe(false);
    let commits = 0;
    f.hooks.commit = async () => { commits += 1; if (commits === 1) await f.revoke('staff', SUPPORT_ROLE); };
    const packet = { commandId: 'COMMITTED-ENROLLMENT', expectedRevision: ticket.revision };
    expect((await f.send(f.request('enroll', packet))).status).toBe(403);
    expect(commits).toBe(1);
    const committed = await f.rows();
    expect(committed.filter((row) => row.kind === 'engineering_source')).toHaveLength(1);
    expect(committed.filter((row) => row.kind === 'engineering_receipt')).toHaveLength(1);
    // A new real audited grant restores current authority; an exact SDK replay
    // returns the retained ACK without another Source/receipt transaction.
    await f.host.roleStore.grantRoleAssignmentWithAudit({ assignment: {
      id: 'engineering-http-restored-staff-Support', principalId: f.principals.staff, role: SUPPORT_ROLE,
      scope: APPLICATION_SCOPE, grantedBy: { kind: 'system', systemId: 'synthetic-engineering-http' },
      grantedAtEpochMs: Date.now(), status: 'active',
    }, auditEventId: 'engineering-http-restored-staff-grant' });
    expect((await f.send(f.request('enroll', packet))).status).toBe(200);
    expect(commits).toBe(1); expect(await f.rows()).toEqual(committed);
  });

  it('withholds a committed policy ACK after real Admin revocation while preserving the SDK mutation', async () => {
    const f = await fixture(); f.hooks.policy = async () => { delete f.hooks.policy; await f.revoke('both', ADMIN_ROLE); };
    const response = await f.send(f.request('policy/disable', { commandId: 'COMMITTED-POLICY', expectedGeneration: 1 }, 'both'));
    expect(response.status).toBe(403);
    expect((await f.engineering.runtime.readPolicy(f.engineering.actors.admin)).policy.enabled).toBe(false);
  });

  it('recovers the exact SDK enrollment receipt after a synthetic post-commit response loss', async () => {
    const f = await fixture(); const ticket = await f.engineering.createTicket(); const original = f.state.runtime; let lose = true;
    f.state.runtime = { ...original, async enroll(...args: Parameters<typeof original.enroll>) {
      const value = await original.enroll(...args); if (lose) { lose = false; throw new Error('Synthetic response loss'); } return value;
    } };
    const packet = { commandId: 'LOST-ACK-EXACT', expectedRevision: ticket.revision };
    expect((await f.send(f.request('enroll', packet))).status).toBe(503); const rows = await f.rows();
    expect((await f.send(f.request('enroll', packet))).status).toBe(200); expect(await f.rows()).toEqual(rows);
  });

  it.each([false, true])('applies final original-session checks to a private read or failed read (failure=%s)', async (fail) => {
    const f = await fixture(); await f.verified(); const original = f.state.runtime;
    f.state.runtime = { ...original, async readSource(access, ticketId) {
      const value = await original.readSource(access, ticketId); await f.destroy('staff');
      if (fail) throw new Error('SYNTHETIC_PRIVATE_DEPENDENCY_FAILURE'); return value;
    } };
    const response = await f.send(f.request()); expect(response.status).toBe(401);
    expect(await object(response)).toEqual({ error: 'authentication_required' });
  });

  it.each(['invalidate', 'withdraw'] as const)('keeps authorized %s available with processing OFF', async (operation) => {
    const f = await fixture(); await f.verified(); f.engineering.state.enabled = false;
    const response = await f.send(f.request(operation, { commandId: operation.toUpperCase() + '-EXACT',
      reason: operation === 'withdraw' ? 'privacy_withdrawal' : 'evidence_revoked' }));
    expect(response.status).toBe(200);
    expect(result(await object(response)).state).toBe(operation === 'withdraw' ? 'withdrawn' : 'held');
    expect(f.engineering.state.modelCalls).toBe(0);
  });

  it('returns the dedicated durable read quota Retry-After without a private factory call', async () => {
    const f = await fixture(); for (let index = 0; index < 120; index += 1) await f.host.engineeringReadLimiter.allow(f.principals.staff);
    const response = await f.send(f.request()); expect(response.status).toBe(429);
    expect(Number(response.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect(await object(response)).toEqual({ error: 'rate_limited' }); expect(f.state.runtimeCalls).toBe(0);
  });

  it('enforces existing byte/scalar limits and the finite delayed-body deadline', async () => {
    const f = await fixture(); const ticket = await f.engineering.createTicket(); const before = await f.rows();
    expect((await f.send(f.request('enroll', { commandId: 'x'.repeat(201), expectedRevision: ticket.revision }))).status).toBe(400);
    expect((await f.send(f.request('enroll', { commandId: 'x'.repeat(65_536), expectedRevision: ticket.revision }))).status).toBe(413);
    const body = await controlledHumanBody(f.request('enroll', { commandId: 'UNFINISHED', expectedRevision: ticket.revision }));
    vi.useFakeTimers(); const pending = f.send(body.request);
    try {
      await body.waitFor(pending); await vi.advanceTimersByTimeAsync(10_001);
      expect((await pending).status).toBe(408); expect(body.cancellations).toBeGreaterThan(0);
      expect(await f.rows()).toEqual(before);
    } finally { body.complete(); vi.useRealTimers(); }
  });
});
