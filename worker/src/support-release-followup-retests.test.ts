import { describe, expect, it, vi } from 'vitest';
import { createSupportFollowupHostFixture } from './support-release-followup-host-fixtures';
import { supportFollowupRetestReceipts } from './support-release-followup-retests';
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
) {
  const f = await createSupportFollowupHostFixture();
  const work = await f.prepared();
  const report = await f.report(result, confirmed);
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

async function observedRetest() {
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
describe('actual KB report association for exact release follow-up retests', () => {
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
    expect(rows).toHaveLength(2);
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
