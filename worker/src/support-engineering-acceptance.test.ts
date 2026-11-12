import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createMemoryStore,
  defineCollection,
  type CollectionDefinition,
  type CollectionStore,
  type Store,
  type StoredRecord,
} from '@pegma/storage-core';
import {
  createSupportDeskApplication,
  type EngineeringDispatchProofBinding,
  type EngineeringRepositoryDescriptor,
} from '@pegma/support-desk-application';
import {
  createSupportEngineeringCreationReceipts,
  type EngineeringCreationBinding,
  type EngineeringCreationAcceptance,
} from './support-engineering-acceptance';
import { canonical } from './support-openrouter-model';
import {
  createSupportEngineeringFixture,
  engineeringRepositories,
} from './support-engineering-fixtures';
import {
  createSupportEngineeringRuntime,
  supportEngineeringApplicationOptions,
} from './support-engineering';
import type { EngineeringGitHubPort } from '@pegma/support-desk-ai';

const START = '2026-11-12T12:00:00.000Z';
const live = () => new AbortController().signal;
const digest = (value: unknown) =>
  createHash('sha256').update(canonical(value)).digest('hex');
const raw = defineCollection<StoredRecord>({
  name: 'pegma.support-engineering-creation.v1',
  key: (row) => ({ partition: String(row.partition), id: String(row.id) }),
  codec: { encode: (row) => row, decode: (row) => row },
});
function binding(): EngineeringCreationBinding {
  return {
    repositoryId: '42',
    dispatchId: 'dispatch:one',
    requestHash: 'a'.repeat(64),
    repositoryMetadataHash: 'b'.repeat(64),
    exportMarker: 'pegma-engineering:' + 'c'.repeat(48),
    sourceFence: {
      ticketId: 'fictional-ticket',
      sourceGeneration: 1,
      sourceBindingHash: 'd'.repeat(64),
    },
    appId: '7',
    installationId: '9',
    installationBinding: 'fictional-installation',
  };
}
function acceptance(selected = binding()): EngineeringCreationAcceptance {
  return {
    binding: selected,
    acknowledgement: {
      repositoryId: selected.repositoryId,
      issueId: '101',
      issueNumber: 1,
      url: 'https://github.com/fictional/project/issues/1',
    },
    payloadHash: digest({
      title: 'Fictional title',
      body: 'Fictional approved body',
      labels: ['bug'],
    }),
    recordedAt: START,
  };
}
function fixture() {
  const backing = createMemoryStore();
  let time = START;
  const state = {
    calls: 0,
    inserts: 0,
    writes: 0,
    scans: 0,
    loseInsert: false,
    loseWrite: false,
    fail: false,
    conflicts: 0,
    before: undefined as (() => void | Promise<void>) | undefined,
  };
  const store: Store = {
    collection<Value>(
      definition: CollectionDefinition<Value>,
    ): CollectionStore<Value> {
      const actual = backing.collection(definition);
      async function before() {
        state.calls += 1;
        await state.before?.();
        if (state.fail) throw new Error('Fictional storage outage');
      }
      return {
        ...actual,
        async get(key) {
          await before();
          return actual.get(key);
        },
        async getVersioned(key) {
          await before();
          return actual.getVersioned(key);
        },
        async insertIfAbsent(value) {
          state.inserts += 1;
          await before();
          const result = await actual.insertIfAbsent(value);
          if (state.loseInsert) {
            state.loseInsert = false;
            throw new Error('Lost actual insert ACK');
          }
          return result;
        },
        async putIfUnchanged(value, version) {
          state.writes += 1;
          await before();
          // A real concurrent write changes the token that this caller observed.
          if (state.conflicts-- > 0) {
            const pending = await actual.get(definition.key(value));
            if (pending !== null) await actual.put(pending);
          }
          const result = await actual.putIfUnchanged(value, version);
          if (state.loseWrite) {
            state.loseWrite = false;
            throw new Error('Lost actual write ACK');
          }
          return result;
        },
        async scan() {
          state.scans += 1;
          throw new Error('Unexpected scan');
        },
        async list() {
          state.scans += 1;
          throw new Error('Unexpected list');
        },
        async listVersioned() {
          state.scans += 1;
          throw new Error('Unexpected list');
        },
      };
    },
  };
  const clock = { now: () => time };
  const create = () =>
    createSupportEngineeringCreationReceipts({ store, clock });
  return {
    backing,
    store,
    state,
    create,
    port: create(),
    at: (value: string) => {
      time = value;
    },
    rows: () => backing.collection(raw).list('creation'),
  };
}

describe('Store-owned engineering creation acceptance', () => {
  it('checks cancellation after the actual Web Crypto await before touching Store', async () => {
    const f = fixture();
    const controller = new AbortController();
    const preparing = f.port.prepare(binding(), controller.signal);
    controller.abort();
    expect(await preparing).toBe(false);
    expect(f.state.calls).toBe(0);
    expect(await f.rows()).toHaveLength(0);
  });
  it('grants only one acknowledged prepare under concurrent real Store insertion', async () => {
    const f = fixture();
    const results = await Promise.all(
      Array.from({ length: 16 }, () => f.create().prepare(binding(), live())),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await f.port.read(binding(), live())).toBeNull();
    expect(await f.rows()).toHaveLength(1);
    expect(f.state.scans).toBe(0);
  });

  it('retains a tombstone after insert ACK loss, restart and arbitrarily later clocks', async () => {
    const f = fixture();
    f.state.loseInsert = true;
    expect(await f.port.prepare(binding(), live())).toBe(false);
    expect(await f.rows()).toHaveLength(1);
    f.at('2036-11-12T12:00:00.000Z');
    expect(await f.create().prepare(binding(), live())).toBe(false);
    expect(await f.create().read(binding(), live())).toBeNull();
  });

  it('does not mint an acceptance for an absent intent or a pending marker', async () => {
    const f = fixture();
    expect(await f.port.record(acceptance(), live())).toBe(false);
    expect(await f.port.read(binding(), live())).toBeNull();
    expect(await f.port.prepare(binding(), live())).toBe(true);
    expect(await f.port.read(binding(), live())).toBeNull();
    expect(f.state.writes).toBe(0);
  });

  it('records immutable history and a bounded deterministic proof without the approved payload', async () => {
    const f = fixture();
    const input = acceptance();
    expect(await f.port.prepare(input.binding, live())).toBe(true);
    expect(await f.port.record(input, live())).toBe(true);
    const receipt = await f.create().read(input.binding, live());
    expect(receipt).toMatchObject(input);
    expect(receipt?.proof).toBe(
      'engineering-create:' +
        digest(['pegma.engineering-creation-acceptance.v1', input]),
    );
    expect(receipt?.proof).toMatch(/^engineering-create:[a-f0-9]{64}$/u);
    expect(receipt?.proof.length).toBeLessThanOrEqual(200);
    expect(await f.port.read(input.binding, live())).toEqual(receipt);
    const stored = JSON.stringify(await f.rows());
    expect(stored).not.toContain('Fictional approved body');
    expect(stored).not.toContain('Fictional title');
    expect(stored).not.toContain('labels');
    expect(f.state.scans).toBe(0);
  });

  it('recovers an actually committed record ACK without rewriting or changing recorded time', async () => {
    const f = fixture();
    await f.port.prepare(binding(), live());
    f.state.loseWrite = true;
    expect(await f.port.record(acceptance(), live())).toBe(false);
    const known = await f.create().read(binding(), live());
    expect(known).toMatchObject(acceptance());
    f.at('2026-11-12T12:01:00.000Z');
    expect(
      await f
        .create()
        .record(
          { ...acceptance(), recordedAt: '2026-11-12T12:01:00.000Z' },
          live(),
        ),
    ).toBe(true);
    expect(await f.create().read(binding(), live())).toEqual(known);
    expect(f.state.writes).toBe(1);
    expect(await f.port.prepare(binding(), live())).toBe(false);
  });

  const changes: [
    string,
    (value: EngineeringCreationBinding) => EngineeringCreationBinding,
  ][] = [
    ['repository', (value) => ({ ...value, repositoryId: '84' })],
    ['request', (value) => ({ ...value, requestHash: 'e'.repeat(64) })],
    [
      'metadata',
      (value) => ({ ...value, repositoryMetadataHash: 'e'.repeat(64) }),
    ],
    [
      'marker',
      (value) => ({
        ...value,
        exportMarker: 'pegma-engineering:' + 'e'.repeat(48),
      }),
    ],
    [
      'ticket',
      (value) => ({
        ...value,
        sourceFence: { ...value.sourceFence, ticketId: 'other' },
      }),
    ],
    [
      'generation',
      (value) => ({
        ...value,
        sourceFence: { ...value.sourceFence, sourceGeneration: 2 },
      }),
    ],
    [
      'source binding',
      (value) => ({
        ...value,
        sourceFence: {
          ...value.sourceFence,
          sourceBindingHash: 'e'.repeat(64),
        },
      }),
    ],
    ['App', (value) => ({ ...value, appId: '8' })],
    ['installation', (value) => ({ ...value, installationId: '10' })],
    [
      'installation binding',
      (value) => ({ ...value, installationBinding: 'other' }),
    ],
  ];
  it.each(changes)(
    'refuses %s drift without reopening the same dispatch',
    async (_name, change) => {
      const f = fixture();
      await f.port.prepare(binding(), live());
      await f.port.record(acceptance(), live());
      const changed = change(binding());
      expect(await f.port.prepare(changed, live())).toBe(false);
      expect(await f.port.record(acceptance(changed), live())).toBe(false);
      expect(await f.port.read(changed, live())).toBeNull();
      expect(await f.port.read(binding(), live())).toMatchObject(acceptance());
      expect(await f.rows()).toHaveLength(1);
    },
  );

  it.each(['acknowledgement', 'payload'] as const)(
    'refuses conflicting %s without overwriting known history',
    async (change) => {
      const f = fixture();
      await f.port.prepare(binding(), live());
      await f.port.record(acceptance(), live());
      const before = await f.port.read(binding(), live());
      const changed = { ...acceptance() };
      if (change === 'payload') changed.payloadHash = 'e'.repeat(64);
      else
        changed.acknowledgement = {
          ...changed.acknowledgement,
          issueId: '102',
        };
      expect(await f.port.record(changed, live())).toBe(false);
      expect(await f.port.read(binding(), live())).toEqual(before);
      expect(f.state.writes).toBe(1);
    },
  );

  it('converges concurrent conflicting acknowledgements on exactly one immutable receipt', async () => {
    const f = fixture();
    await f.port.prepare(binding(), live());
    const one = acceptance();
    const two = {
      ...acceptance(),
      acknowledgement: { ...acceptance().acknowledgement, issueId: '102' },
    };
    expect(
      (
        await Promise.all([
          f.port.record(one, live()),
          f.create().record(two, live()),
        ])
      ).filter(Boolean),
    ).toHaveLength(1);
    const receipt = await f.port.read(binding(), live());
    expect(['101', '102']).toContain(receipt?.acknowledgement.issueId);
    expect(await f.port.prepare(binding(), live())).toBe(false);
  });

  it('bounds CAS retries and preserves pending intent through genuine version conflicts', async () => {
    const f = fixture();
    await f.port.prepare(binding(), live());
    f.state.conflicts = 3;
    expect(await f.port.record(acceptance(), live())).toBe(false);
    expect(f.state.writes).toBe(3);
    expect(await f.port.read(binding(), live())).toBeNull();
    expect(await f.port.prepare(binding(), live())).toBe(false);
    expect(await f.port.record(acceptance(), live())).toBe(true);
  });

  it('rechecks cancellation after Store reads and never mutates a newly cancelled attempt', async () => {
    const f = fixture();
    await f.port.prepare(binding(), live());
    const controller = new AbortController();
    f.state.before = () => controller.abort();
    expect(await f.port.record(acceptance(), controller.signal)).toBe(false);
    expect(f.state.writes).toBe(0);
    expect(await f.port.read(binding(), controller.signal)).toBeNull();
  });

  it('keeps an accepted intent after cancellation during its insert await', async () => {
    const f = fixture();
    const controller = new AbortController();
    f.state.before = () => controller.abort();
    expect(await f.port.prepare(binding(), controller.signal)).toBe(false);
    f.state.before = undefined;
    expect(await f.create().prepare(binding(), live())).toBe(false);
    expect(await f.rows()).toHaveLength(1);
  });

  it('performs zero Store operations for pre-aborted inputs', async () => {
    const f = fixture();
    const controller = new AbortController();
    controller.abort();
    expect(await f.port.prepare(binding(), controller.signal)).toBe(false);
    expect(await f.port.record(acceptance(), controller.signal)).toBe(false);
    expect(await f.port.read(binding(), controller.signal)).toBeNull();
    expect(f.state.calls).toBe(0);
  });

  it('reports cancellation after a handed-off acceptance write conservatively and recovers its real ACK', async () => {
    const f = fixture();
    await f.port.prepare(binding(), live());
    const controller = new AbortController();
    f.state.before = () => {
      if (f.state.writes > 0) controller.abort();
    };
    expect(await f.port.record(acceptance(), controller.signal)).toBe(false);
    f.state.before = undefined;
    expect(await f.create().read(binding(), live())).toMatchObject(
      acceptance(),
    );
    expect(await f.create().prepare(binding(), live())).toBe(false);
  });

  it('contains failures and cannot turn unavailable or future history into another permit', async () => {
    const f = fixture();
    f.state.fail = true;
    expect(await f.port.prepare(binding(), live())).toBe(false);
    expect(await f.port.read(binding(), live())).toBeNull();
    f.state.fail = false;
    await f.port.prepare(binding(), live());
    expect(
      await f.port.record(
        { ...acceptance(), recordedAt: '2026-11-12T12:01:00.000Z' },
        live(),
      ),
    ).toBe(false);
    expect(await f.port.read(binding(), live())).toBeNull();
    expect(await f.port.prepare(binding(), live())).toBe(false);
  });

  it('snapshots caller binding and acknowledgement before an awaited Store operation', async () => {
    const f = fixture();
    const selected = { ...binding() };
    f.state.before = () => {
      selected.appId = '8';
      selected.sourceFence = { ...selected.sourceFence, ticketId: 'changed' };
    };
    expect(await f.port.prepare(selected, live())).toBe(true);
    const input = { ...acceptance() };
    f.state.before = () => {
      input.acknowledgement = { ...input.acknowledgement, issueId: '999' };
      input.payloadHash = 'e'.repeat(64);
    };
    expect(await f.port.record(input, live())).toBe(true);
    f.state.before = undefined;
    expect(await f.port.read(binding(), live())).toMatchObject(acceptance());
  });

  it('returns detached history and preserves it across time and edits of later observations', async () => {
    const f = fixture();
    await f.port.prepare(binding(), live());
    await f.port.record(acceptance(), live());
    const original = await f.port.read(binding(), live());
    if (!original) throw new Error('Expected actual receipt');
    const edited = {
      ...original,
      acknowledgement: { ...original.acknowledgement },
    };
    edited.acknowledgement.issueId = '999';
    f.at('2036-11-12T12:00:00.000Z');
    expect(await f.create().read(binding(), live())).toEqual(original);
    expect(await f.create().prepare(binding(), live())).toBe(false);
    f.at('2026-11-12T11:59:59.000Z');
    expect(await f.port.read(binding(), live())).toBeNull();
    expect(await f.port.record(acceptance(), live())).toBe(false);
    expect(await f.port.prepare(binding(), live())).toBe(false);
  });

  it('keeps distinct genuine dispatch identities separate without enumerating other work', async () => {
    const f = fixture();
    const other = { ...binding(), dispatchId: 'dispatch:two' };
    expect(await f.port.prepare(binding(), live())).toBe(true);
    expect(await f.port.prepare(other, live())).toBe(true);
    expect(await f.port.record(acceptance(), live())).toBe(true);
    expect(await f.port.read(other, live())).toBeNull();
    expect(await f.rows()).toHaveLength(2);
    expect(f.state.scans).toBe(0);
  });

  it('rejects corrupt stored envelopes without erasing the existing dispatch tombstone', async () => {
    const f = fixture();
    await f.port.prepare(binding(), live());
    const row = (await f.rows())[0]!;
    await f.backing
      .collection(raw)
      .put({ ...row, payload: '{"unexpected":"PRIVATE_TEXT"}' });
    expect(await f.port.read(binding(), live())).toBeNull();
    expect(await f.port.record(acceptance(), live())).toBe(false);
    expect(await f.port.prepare(binding(), live())).toBe(false);
    expect(await f.rows()).toHaveLength(1);
  });

  it('refuses a validly shaped payload transplanted under another dispatch key', async () => {
    const f = fixture();
    await f.port.prepare(binding(), live());
    const row = (await f.rows())[0]!;
    const payload = JSON.parse(String(row.payload));
    payload.binding.dispatchId = 'dispatch:transplanted';
    await f.backing
      .collection(raw)
      .put({ ...row, payload: canonical(payload) });
    expect(await f.port.read(binding(), live())).toBeNull();
    expect(await f.port.record(acceptance(), live())).toBe(false);
    expect(await f.port.prepare(binding(), live())).toBe(false);
    expect(await f.rows()).toHaveLength(1);
  });

  it.each([
    { ...binding(), unexpected: 'PRIVATE_TEXT' },
    { ...binding(), dispatchId: 'x'.repeat(201) },
    { ...binding(), appId: '007' },
    { ...binding(), requestHash: 'not-a-hash' },
    {
      ...binding(),
      sourceFence: { ...binding().sourceFence, sourceGeneration: 0 },
    },
    { ...binding(), installationBinding: 'bad\u0000value' },
  ])('refuses malformed binding %# before Store access', async (input) => {
    const f = fixture();
    expect(await f.port.prepare(input, live())).toBe(false);
    expect(f.state.calls).toBe(0);
  });

  it.each([
    { ...acceptance(), unexpected: 'PRIVATE_TEXT' },
    { ...acceptance(), payloadHash: 'unbounded-or-raw-payload' },
    { ...acceptance(), recordedAt: 'not-a-time' },
    {
      ...acceptance(),
      acknowledgement: { ...acceptance().acknowledgement, repositoryId: '84' },
    },
    {
      ...acceptance(),
      acknowledgement: {
        ...acceptance().acknowledgement,
        issueNumber: Number.MAX_SAFE_INTEGER + 1,
      },
    },
    {
      ...acceptance(),
      acknowledgement: {
        ...acceptance().acknowledgement,
        url: 'https://evil.example/issues/1',
      },
    },
    {
      ...acceptance(),
      acknowledgement: {
        ...acceptance().acknowledgement,
        url: 'https://github.com/fictional/project/issues/2',
      },
    },
  ])(
    'refuses malformed acknowledgement %# before Store access',
    async (input) => {
      const f = fixture();
      expect(await f.port.record(input, live())).toBe(false);
      expect(f.state.calls).toBe(0);
    },
  );

  it('rejects accessors, symbols and foreign prototypes before evaluating caller fields', async () => {
    const f = fixture();
    let evaluated = false;
    const accessor = {
      ...binding(),
      get dispatchId() {
        evaluated = true;
        return 'dispatch:two';
      },
    };
    expect(await f.port.prepare(accessor, live())).toBe(false);
    expect(evaluated).toBe(false);
    expect(
      await f.port.prepare(
        { ...binding(), [Symbol('unexpected')]: true },
        live(),
      ),
    ).toBe(false);
    expect(
      await f.port.prepare(Object.assign(Object.create({}), binding()), live()),
    ).toBe(false);
    expect(f.state.calls).toBe(0);
  });
});

describe('creation acceptance with released SDK028 state', () => {
  async function sdkFixture(known: boolean, expired = false) {
    const store = createMemoryStore();
    const f = await createSupportEngineeringFixture(store);
    const repositories: readonly EngineeringRepositoryDescriptor[] =
      engineeringRepositories.map((row, index) => ({
        ...row,
        repositoryId: index === 0 ? '42' : '84',
      }));
    const policy = await f.runtime.putPolicy(f.actors.admin, {
      clientCommandId: 'CREATION-NUMERIC-REPOSITORIES',
      expectedGeneration: 1,
      policy: { enabled: true, repositories },
    });
    f.state.calibrationPolicyHash = policy.policyHash;
    f.state.modelRepositoryId = '42';
    f.metadata.clear();
    for (const row of repositories)
      f.metadata.set(row.repositoryId, {
        repositoryId: row.repositoryId,
        owner: row.owner,
        name: row.name,
        visibility: row.visibility,
        installationBinding: 'fictional-installation',
        metadataVersion: 'fictional-metadata-v1',
      });
    const receipts = createSupportEngineeringCreationReceipts({
      store,
      clock: f.clock,
    });
    let posts = 0;
    let selected: EngineeringCreationBinding | undefined;
    const withInstallation = (
      input: Omit<
        EngineeringCreationBinding,
        'appId' | 'installationId' | 'installationBinding'
      >,
    ): EngineeringCreationBinding => ({
      ...input,
      appId: '7',
      installationId: '9',
      installationBinding: 'fictional-installation',
    });
    const github: EngineeringGitHubPort = {
      ...f.ports.github,
      async createIssue(request, context) {
        selected = withInstallation({
          repositoryId: request.repository.repositoryId,
          dispatchId: context.dispatchId,
          requestHash: context.requestHash,
          exportMarker: request.bundle.exportMarker,
          sourceFence: context.sourceFence,
          repositoryMetadataHash: digest(request.repository),
        });
        if (!(await receipts.prepare(selected, context.signal)))
          throw new Error('No new creation permit');
        posts += 1;
        if (known) {
          const recorded = await receipts.record(
            {
              binding: selected,
              acknowledgement: {
                repositoryId: '42',
                issueId: '101',
                issueNumber: 1,
                url: 'https://github.com/synthetic-org/workspace-core/issues/1',
              },
              payloadHash: digest({
                title: request.bundle.title,
                body: request.bundle.body,
                labels: [...request.bundle.labels].sort(),
              }),
              recordedAt: f.clock.now(),
            },
            context.signal,
          );
          if (!recorded) throw new Error('Actual Store acceptance unavailable');
        }
        throw new Error(
          known
            ? 'Fictional SDK ACK loss after stored provider ACK'
            : 'Fictional provider ACK never arrived',
        );
      },
      async reconcile(input, context) {
        if (
          input.sourceFence === undefined ||
          input.repositoryMetadataHash === undefined
        )
          return { outcome: 'unknown' };
        const receipt = await receipts.read(
          withInstallation({
            repositoryId: input.repositoryId,
            dispatchId: input.dispatchId,
            requestHash: input.requestHash,
            sourceFence: input.sourceFence,
            repositoryMetadataHash: input.repositoryMetadataHash,
            exportMarker: input.exportMarker,
          }),
          context.signal,
        );
        return receipt === null
          ? { outcome: 'unknown' }
          : {
              outcome: 'accepted',
              acknowledgement: receipt.acknowledgement,
              proof: receipt.proof,
            };
      },
    };
    async function verify(
      input: EngineeringDispatchProofBinding,
      signal: AbortSignal,
    ) {
      if (
        input.operation !== 'create_issue' ||
        input.result.outcome !== 'accepted'
      )
        return null;
      const receipt = await receipts.read(
        withInstallation({
          repositoryId: input.repositoryId,
          dispatchId: input.dispatchId,
          requestHash: input.requestHash,
          exportMarker: input.exportMarker,
          sourceFence: {
            ticketId: input.ticketId,
            sourceGeneration: input.sourceGeneration,
            sourceBindingHash: input.sourceBindingHash,
          },
          repositoryMetadataHash: input.repositoryMetadataHash,
        }),
        signal,
      );
      if (
        receipt === null ||
        canonical(receipt.acknowledgement) !==
          canonical(input.result.acknowledgement)
      )
        return null;
      return {
        binding: input,
        verifierReceiptId: receipt.proof,
        verifierVersion: 'fictional-creation-v1',
        verifiedAt: f.clock.now(),
        validUntil: new Date(
          Date.parse(f.clock.now()) + (expired ? 0 : 60_000),
        ).toISOString(),
      };
    }
    const application = createSupportDeskApplication({
      store,
      clock: f.clock,
      engineering: supportEngineeringApplicationOptions({
        enabled: true,
        routing: f.ports.routing,
        checks: f.ports.checks,
        repositoryMetadata: {
          async resolve(id, signal) {
            const value = f.metadata.get(id);
            return signal.aborted ||
              !f.state.installationActive ||
              value === undefined
              ? null
              : structuredClone(value);
          },
        },
        dispatchResults: { verify },
      }),
    });
    const runtime = createSupportEngineeringRuntime({
      application,
      clock: f.clock,
      staffAccess: { resolve: f.resolve },
      processingEnabled: () => f.state.enabled,
      ports: { ...f.ports, github },
    });
    const { key } = await f.eligible();
    await f.prepared();
    await f.approve();
    const process = () =>
      runtime.processWork({
        ...key,
        workerId: 'creation:unknown-ack',
        leaseMilliseconds: 30_000,
      });
    await process();
    expect((await f.work()).status).toBe('unknown');
    expect(posts).toBe(1);
    return {
      ...f,
      receipts,
      key,
      selected: () => selected!,
      posts: () => posts,
      process,
      runtime,
    };
  }

  it('recovers known acceptance after SDK ACK loss with model and issue writes disabled', async () => {
    const f = await sdkFixture(true);
    const known = await f.receipts.read(f.selected(), live());
    expect(known?.proof.length).toBeLessThanOrEqual(200);
    f.state.enabled = false;
    f.state.configuration = 'disabled';
    expect((await f.runtime.reconcileSource(f.key.ticketId)).outcome).toBe(
      'reconciled',
    );
    expect(f.posts()).toBe(1);
    expect(f.state.modelCalls).toBe(1);
    expect(await f.receipts.read(f.selected(), live())).toEqual(known);
    expect(await f.receipts.prepare(f.selected(), live())).toBe(false);
  });

  it('keeps missing provider ACK unknown through reconciliation and later work retries', async () => {
    const f = await sdkFixture(false);
    expect((await f.runtime.reconcileSource(f.key.ticketId)).outcome).toBe(
      'pending',
    );
    f.advance(31_000);
    await f.process();
    expect(await f.receipts.read(f.selected(), live())).toBeNull();
    expect(await f.receipts.prepare(f.selected(), live())).toBe(false);
    expect(f.posts()).toBe(1);
  });

  it('retains historical acceptance while an expired current verifier proof denies SDK completion', async () => {
    const f = await sdkFixture(true, true);
    expect((await f.runtime.reconcileSource(f.key.ticketId)).outcome).toBe(
      'pending',
    );
    expect(await f.receipts.read(f.selected(), live())).not.toBeNull();
    expect(await f.receipts.prepare(f.selected(), live())).toBe(false);
    expect(f.posts()).toBe(1);
  });

  it('preserves current stored reconciliation-role denial without discarding a known receipt', async () => {
    const f = await sdkFixture(true);
    const known = await f.receipts.read(f.selected(), live());
    await f.revoke('reconciler');
    expect((await f.runtime.reconcileSource(f.key.ticketId)).outcome).toBe(
      'pending',
    );
    expect(await f.receipts.read(f.selected(), live())).toEqual(known);
    expect(f.posts()).toBe(1);
  });
});
