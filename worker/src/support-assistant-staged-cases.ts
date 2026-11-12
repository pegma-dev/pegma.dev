import { describe, expect, it } from 'vitest';
import { supportAssistantFixture, type AssistantBackend } from './support-assistant-fixtures';
import type { SupportAssistantOptions } from './support-assistant';

type Fixture = Awaited<ReturnType<typeof supportAssistantFixture>>;

// Each call constructs a fresh real host runtime (and a fresh D1 adapter when
// supplied by that backend). This bounded test driver is NOT a scheduled tick:
// production runTick scans one bounded page and processes at most one turn.
async function nextPhase(
  f: Fixture,
  options: Partial<SupportAssistantOptions> = {},
  stopAtDeferred = false,
) {
  for (let tick = 0; tick < 128; ++tick) {
    const result = await f.tick(options);
    if (result.outcome === 'deferred') {
      if (stopAtDeferred) return result;
      f.advance(Math.max(0, Date.parse(result.nextAttemptAt) - Date.parse(f.clock.now())));
      continue;
    }
    if (result.outcome !== 'scanned' || result.turn !== 'none') return result;
  }
  throw new Error('The physical scan did not reach a staged turn.');
}

async function prepare(f: Fixture) {
  const result = await nextPhase(f);
  expect(result).toMatchObject({ outcome: 'prepared', checkpointSaved: false });
  if (result.outcome !== 'prepared') throw new Error('No durable no-call handoff.');
  expect(f.modelCalls).toEqual([]);
  expect(f.usageReservations).toEqual([]);
  expect(f.usageObservations).toEqual([]);
  expect(Object.keys(result).sort()).toEqual([
    'candidates',
    'checkpointSaved',
    'nextAttemptAt',
    'outcome',
    'physicalRows',
    'preparationAttemptId',
    'ticketId',
    'turnId',
  ]);
  const job = (await f.rows()).find((row) => row.kind === 'assistant_turn');
  expect(job).toMatchObject({
    status: 'retry',
    attempt: 1,
    preparedAttempts: [{ accounting: 'not_called' }],
  });
  expect(job).not.toHaveProperty('claim');
  expect(job).not.toHaveProperty('leaseUntil');
  f.advance(Math.max(0, Date.parse(result.nextAttemptAt) - Date.parse(f.clock.now())));
  return result;
}

async function answers(f: Fixture) {
  return (await f.messages()).filter((message) => message.authorKind === 'assistant');
}

/** Candidate tests: execute only after genuine registry025 adoption. The Memory
 * and native D1 registrations below use the same public-SDK host workflow. */
export function registerStagedSupportAssistantCases(
  name: string,
  createBackend: () => Promise<AssistantBackend>,
) {
  describe('phased answering across real physical invocations (' + name + ')', () => {
    it.each([0, 4])(
      'completes two simultaneous real tickets with %i later candidates within their existing five-minute window',
      async (laterCandidates) => {
        const f = await supportAssistantFixture(await createBackend());
        const second = await f.createTicket('fictional-second-answer-ticket');
        const later = [];
        for (let index = 0; index < laterCandidates; ++index)
          later.push(await f.createTicket('z-fictional-later-ticket-' + index));
        const original = await f.checkpoint();
        if (laterCandidates > 0) {
          const count =
            (await f.rows()).length +
            (await f.rows(second)).length +
            (await Promise.all(later.map((id) => f.rows(id)))).reduce(
              (total, rows) => total + rows.length,
              0,
            );
          expect(count).toBeGreaterThan(32);
        }
        const initial = (await f.rows(second)).find((row) => row.kind === 'assistant_turn');
        if (initial?.kind !== 'assistant_turn') throw new Error('Actual assistant turn required.');
        const began = Date.parse(f.clock.now());
        expect(Date.parse(initial.turnDeadline) - Date.parse(initial.createdAt)).toBe(300_000);
        const outcomes = [];
        for (let physicalTick = 0; physicalTick < 4; ++physicalTick) {
          f.advance(60_000);
          const calls = f.modelCalls.length;
          const result = await f.tick();
          outcomes.push({
            ageMs: Date.parse(f.clock.now()) - began,
            outcome: result.outcome,
            turn: result.outcome === 'scanned' ? result.turn : undefined,
          });
          expect(f.modelCalls.length - calls).toBeLessThanOrEqual(1);
          expect(f.scanned.every((page) => page.physicalRows <= 32)).toBe(true);
          if (physicalTick === 1 && laterCandidates > 0) {
            expect(result).toMatchObject({ outcome: 'scanned', turn: 'completed' });
            if (result.outcome !== 'scanned') throw new Error('Actual completion required.');
            expect(result.candidates).toBeGreaterThan(1);
            expect(f.scanned.at(-1)?.physicalRows).toBe(32);
            expect((await f.checkpoint())?.cursor).toBe(original?.cursor ?? null);
          }
        }
        console.info(JSON.stringify({ fixture: 'two-simultaneous-public-turns', outcomes }));
        expect((await f.rows()).find((row) => row.kind === 'assistant_turn')).toMatchObject({
          status: 'completed',
          attempt: 2,
        });
        expect((await f.rows(second)).find((row) => row.kind === 'assistant_turn')).toMatchObject({
          status: 'completed',
          attempt: 2,
        });
        expect(Date.parse(f.clock.now())).toBeLessThan(Date.parse(initial.turnDeadline));
        expect(f.modelCalls).toHaveLength(2);
        for (const id of later)
          expect((await f.rows(id)).find((row) => row.kind === 'assistant_turn')).toMatchObject({
            status: 'pending',
            attempt: 0,
          });
        expect(
          (await f.messages()).filter((message) => message.authorKind === 'assistant'),
        ).toHaveLength(1);
        expect(
          (await f.messages(second)).filter((message) => message.authorKind === 'assistant'),
        ).toHaveLength(1);
      },
    );

    it('prepares without a mode override or paid work, then completes exactly one paid chance in a fresh factory', async () => {
      const f = await supportAssistantFixture(await createBackend());
      const configuration = f.configuration();
      const prepared = await prepare(f);
      const checkpoint = await f.checkpoint();
      // No runtime/assistant/claim object from phase one is reused by f.tick.
      expect(await nextPhase(f)).toMatchObject({ outcome: 'scanned', turn: 'completed' });
      expect(f.configuration()).toEqual(configuration);
      expect(f.usageReservations).toHaveLength(1);
      expect(f.usageObservations).toContainEqual(expect.objectContaining({ state: 'known' }));
      expect(f.modelCalls).toHaveLength(1);
      expect(await answers(f)).toHaveLength(1);
      const job = (await f.rows()).find((row) => row.kind === 'assistant_turn');
      expect(job).toMatchObject({
        attempt: 2,
        preparedAttempts: [
          { accounting: 'not_called', attemptId: prepared.preparationAttemptId },
          { accounting: 'unknown' },
        ],
      });
      expect(await f.checkpoint()).not.toEqual(checkpoint);
      for (let tick = 0; tick < 12; ++tick) await f.tick();
      expect(f.modelCalls).toHaveLength(1);
      expect(await answers(f)).toHaveLength(1);
    });

    it.each(['configuration', 'application'] as const)(
      'refuses staging at the existing %s attempt cap of one without raising it',
      async (cap) => {
        const f = await supportAssistantFixture(
          await createBackend(),
          cap === 'configuration' ? { maxAttempts: 1 } : { applicationMaxAttempts: 1 },
        );
        expect((await nextPhase(f)).outcome).not.toBe('prepared');
        expect(f.modelCalls).toEqual([]);
        expect(f.usageReservations).toEqual([]);
        expect(await answers(f)).toEqual([]);
      },
    );

    it.each([
      'identity',
      'role',
      'evidence',
      'publication',
      'kill',
      'expiry',
      'configuration',
      'audience',
      'usage-scope',
    ] as const)('rechecks current %s after discarding the preparing factory', async (change) => {
      const f = await supportAssistantFixture(await createBackend());
      const prepared = await prepare(f);
      if (change === 'identity') await f.withdrawCustomer();
      if (change === 'role') await f.revokeAudienceRole();
      if (change === 'evidence') await f.revokeEvidence();
      if (change === 'publication') await f.retireGuide();
      if (change === 'kill') f.state.enabled = false;
      if (change === 'expiry') f.advance(3_600_001);
      if (change === 'configuration') f.state.configurationCurrent = false;
      if (change === 'audience') f.state.audienceCurrent = false;
      if (change === 'usage-scope') f.state.usageScopeRef += '-reissued';
      // Expiry escalates the real turn during claim and returns a deferred result.
      const result = await nextPhase(f, {}, change === 'expiry');
      if (change === 'expiry') {
        expect(result).toMatchObject({ outcome: 'deferred', checkpointSaved: false });
        const customer = await f.support.readCustomerTicket(
          await f.access('fictional-answer-customer'),
          prepared.ticketId,
        );
        expect(customer.ticket.handling).toBe('human-pending');
        expect(await f.takeOver()).toMatchObject({ ticket: { id: prepared.ticketId } });
        const staff = await f.support.readStaffTicket(
          await f.access('fictional-support-operator'),
          prepared.ticketId,
        );
        expect(staff.ticket.handling?.state).toBe('human-active');
      }
      expect(f.modelCalls).toEqual([]);
      expect(f.usageReservations).toEqual([]);
      const messages = change === 'identity' ? await f.staffMessages() : await f.messages();
      expect(messages.filter((message) => message.authorKind === 'assistant')).toEqual([]);
    });

    it.each([
      'verifiedAt',
      'validUntil',
      'accountRef',
      'projectRef',
      'endpointRef',
      'modelRef',
      'featuresRef',
      'exceptionsRef',
      'intermediaryRefs',
    ] as const)(
      'invalidates the full prepared snapshot after a genuine same-version %s renewal',
      async (field) => {
        const f = await supportAssistantFixture(await createBackend());
        await prepare(f);
        const prior = f.configuration();
        f.advance(1);
        const controls = { ...prior.dataControls };
        if (field === 'verifiedAt') controls.verifiedAt = f.clock.now();
        else if (field === 'validUntil')
          controls.validUntil = new Date(Date.parse(controls.validUntil) - 1000).toISOString();
        else if (field === 'intermediaryRefs')
          controls.intermediaryRefs = [
            ...controls.intermediaryRefs,
            'fictional-renewed-intermediary',
          ];
        else controls[field] += '-renewed';
        f.replaceConfiguration({ ...prior, dataControls: controls });
        expect(f.configuration().version).toBe(prior.version);
        await nextPhase(f);
        expect(f.modelCalls).toEqual([]);
        expect(f.usageReservations).toEqual([]);
        expect(await answers(f)).toEqual([]);
      },
    );

    it('retains unknown paid liability across fresh factories and cannot fund a second turn', async () => {
      const f = await supportAssistantFixture(await createBackend(), { maxPoolCostMicros: 10_000 });
      await prepare(f);
      f.setModel(async () => {
        throw new Error('Fictional accepted request ACK unknown.');
      });
      await nextPhase(f);
      expect(f.modelCalls).toHaveLength(1);
      expect(f.usageObservations).toContainEqual(expect.objectContaining({ state: 'unknown' }));
      await f.createTicket('fictional-next-staged-ticket');
      expect((await nextPhase(f)).outcome).toBe('prepared');
      await nextPhase(f);
      for (let tick = 0; tick < 12; ++tick) await f.tick();
      expect(f.modelCalls).toHaveLength(1);
      expect(await answers(f)).toEqual([]);
    });

    it('does not adopt an ambiguous no-call preparation after its actual commit loses the ACK', async () => {
      const f = await supportAssistantFixture(await createBackend());
      const actual = f.support;
      expect(
        await nextPhase(f, {
          application: {
            ...actual,
            async prepareAssistantTurnAttempt(...args) {
              await actual.prepareAssistantTurnAttempt(...args);
              throw new Error('Fictional lost no-call preparation ACK.');
            },
          },
        }),
      ).toMatchObject({ outcome: 'scanned', turn: 'pending', checkpointSaved: false });
      expect(f.modelCalls).toEqual([]);
      expect(f.usageReservations).toEqual([]);
      f.advance(31_000);
      await nextPhase(f);
      expect(f.modelCalls).toEqual([]);
      expect(f.usageReservations).toEqual([]);
      expect(await answers(f)).toEqual([]);
    });

    it('reports an ambiguous finish as pending and a fresh factory can recover its acknowledged durable no-call state', async () => {
      const f = await supportAssistantFixture(await createBackend());
      const actual = f.support;
      expect(
        await nextPhase(f, {
          application: {
            ...actual,
            async finishAssistantTurnAttempt(...args) {
              await actual.finishAssistantTurnAttempt(...args);
              throw new Error('Fictional lost committed no-call finish ACK.');
            },
          },
        }),
      ).toMatchObject({ outcome: 'scanned', turn: 'pending', checkpointSaved: false });
      expect(f.modelCalls).toEqual([]);
      expect(f.usageReservations).toEqual([]);
      expect(await nextPhase(f)).toMatchObject({ outcome: 'scanned', turn: 'completed' });
      expect(f.modelCalls).toHaveLength(1);
      expect(f.usageReservations).toHaveLength(1);
      expect(await answers(f)).toHaveLength(1);
    });

    it('keeps a committed answer after a lost ACK without another paid chance in later factories', async () => {
      const f = await supportAssistantFixture(await createBackend());
      await prepare(f);
      f.state.loseCompletionAck = true;
      expect(await nextPhase(f)).toMatchObject({
        outcome: 'scanned',
        turn: 'pending',
        checkpointSaved: false,
      });
      expect(await answers(f)).toHaveLength(1);
      for (let tick = 0; tick < 12; ++tick) await f.tick();
      expect(f.modelCalls).toHaveLength(1);
      expect(await answers(f)).toHaveLength(1);
    });
  });
}
