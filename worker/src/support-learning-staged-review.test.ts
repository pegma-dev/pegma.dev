import { createMemoryStore } from '@pegma/storage-core';
import { describe, expect, it } from 'vitest';
import { KNOWLEDGE_ROLE, SUPPORT_ROLE } from './support-access';
import { createStagedReviewFixture, responseObject, resultObject } from './support-learning-staged-review-fixture';

async function prepared() {
  const f = await createStagedReviewFixture(createMemoryStore());
  const delivered = await f.checked();
  const packet = await f.prepare(delivered.source.sourceGeneration);
  return { f, delivered, packet };
}

describe('staged staff learning review through actual HTTP and SDK adapters', () => {
  it('admits durably, runs one phase in each reconstructed delivery, then recovers the exact receipt', async () => {
    const { f, delivered, packet } = await prepared();
    const before = await f.learning.application.readResolutionLearningSource(f.learning.actors.staff, 'learning-ticket');
    const models = f.learning.state.modelCalls;
    const admitted = await f.invoke('/review-queue', packet.body);
    expect(admitted.status).toBe(202);
    expect(resultObject(await responseObject(admitted))).toMatchObject({ outcome: 'pending', phase: 'proof', claimed: false });
    expect((await f.learning.application.readResolutionLearningSource(f.learning.actors.staff, 'learning-ticket')).reviewBindingCount)
      .toBe(before.reviewBindingCount);
    const hint = f.messages[0]!;
    const proof = await f.deliver(hint);
    expect(proof).toEqual({ acknowledgements: 0, delays: [30] });
    const pending = resultObject(await responseObject(await f.invoke('/review-queue-status', packet.body)));
    expect(pending).toMatchObject({ outcome: 'pending', phase: 'commit', claimed: false });
    const commit = await f.deliver(hint);
    expect(commit).toEqual({ acknowledgements: 1, delays: [] });
    const receipt = resultObject(await responseObject(await f.invoke('/review-queue-status', packet.body)));
    expect(receipt).toMatchObject({ outcome: 'accepted', result: { ticketId: 'learning-ticket', sourceGeneration: delivered.source.sourceGeneration } });
    expect(await f.deliver(hint)).toEqual({ acknowledgements: 1, delays: [] });
    expect(f.learning.state.modelCalls).toBe(models);
    expect((await f.learning.application.readResolutionLearningSource(f.learning.actors.staff, 'learning-ticket')).reviewBindingCount)
      .toBe(before.reviewBindingCount + 1);
    await f.revoke(KNOWLEDGE_ROLE);
    const replay = await f.invoke('/review-queue', packet.body);
    expect(replay.status).toBe(200);
    expect(resultObject(await responseObject(replay)).outcome).toBe('accepted');
    await expect(f.learning.knowledge.getPublishedArticle(f.learning.actors.customer, { articleId: delivered.articleId })).rejects.toThrow();
  });

  it('recovers a lost send by bounded scheduled pages; no scan invocation performs either review proof', async () => {
    const { f, packet } = await prepared();
    f.state.sendFailure = true;
    expect((await f.invoke('/review-queue', packet.body)).status).toBe(202);
    expect(f.messages).toHaveLength(0);
    f.state.sendFailure = false;
    for (let page = 0; page < 256 && f.messages.length === 0; page++) await f.scan();
    expect(f.messages).toHaveLength(1);
    expect(resultObject(await responseObject(await f.invoke('/review-queue-status', packet.body)))).toMatchObject({ outcome: 'pending', phase: 'proof' });
    await f.deliver(f.messages[0]!);
    // Simulate exhausted/lost broker retries after P1, then cold physical scan
    // recovery. SDK commit phase remains durable; it never regenerates P1.
    f.messages.length = 0;
    for (let page = 0; page < 256 && f.messages.length === 0; page++) await f.scan();
    expect(f.messages).toHaveLength(1);
    expect(resultObject(await responseObject(await f.invoke('/review-queue-status', packet.body)))).toMatchObject({ outcome: 'pending', phase: 'commit' });
    expect(await f.deliver(f.messages[0]!)).toEqual({ acknowledgements: 1, delays: [] });
    expect(resultObject(await responseObject(await f.invoke('/review-queue-status', packet.body))).outcome).toBe('accepted');
  });

  it('cancels the exact admitted packet after P1 without old KB permission or proof', async () => {
    const { f, packet } = await prepared();
    expect((await f.invoke('/review-queue', packet.body)).status).toBe(202);
    const hint = f.messages[0]!; await f.deliver(hint); await f.revoke(KNOWLEDGE_ROLE);
    const cancelled = await f.invoke('/review-queue-cancel', packet.body);
    expect(cancelled.status).toBe(200);
    expect(resultObject(await responseObject(cancelled))).toMatchObject({ outcome: 'cancelled', commandId: 'EXACT-UPPERCASE-STAGED-REVIEW' });
    expect(await f.deliver(hint)).toEqual({ acknowledgements: 1, delays: [] });
    expect(resultObject(await responseObject(await f.invoke('/review-queue-status', packet.body))).outcome).toBe('cancelled');
  });

  it('denies a fresh original actor role revocation in the worker and withholds private status', async () => {
    const { f, packet } = await prepared();
    expect((await f.invoke('/review-queue', packet.body)).status).toBe(202);
    await f.revoke(SUPPORT_ROLE);
    expect(await f.deliver(f.messages[0]!)).toEqual({ acknowledgements: 0, delays: [30] });
    const denied = await f.invoke('/review-queue-status', packet.body);
    expect(denied.status).toBe(403);
    expect(await responseObject(denied)).toEqual({ error: 'forbidden' });
    expect((await f.learning.application.readResolutionLearningSource(f.learning.actors.staff, 'learning-ticket')).reviewBindingCount).toBe(0);
  });

  it('requires fresh KB permission for new admission but not an absent-receipt status read', async () => {
    const { f, packet } = await prepared(); await f.revoke(KNOWLEDGE_ROLE);
    expect((await f.invoke('/review-queue', packet.body)).status).toBe(403);
    expect(f.messages).toHaveLength(0);
    const status = await f.invoke('/review-queue-status', packet.body);
    expect(status.status).toBe(200); expect((await responseObject(status)).result).toBeNull();
  });

  it('treats logout after durable admission as lost browser access, not command cancellation', async () => {
    const { f, packet } = await prepared();
    expect((await f.invoke('/review-queue', packet.body)).status).toBe(202);
    await f.destroySession();
    expect((await f.invoke('/review-queue-status', packet.body)).status).toBe(401);
    const hint = f.messages[0]!;
    expect((await f.deliver(hint)).acknowledgements).toBe(0);
    expect((await f.deliver(hint)).acknowledgements).toBe(1);
    expect((await f.learning.application.readResolutionLearningSource(f.learning.actors.staff, 'learning-ticket')).reviewBindingCount).toBe(1);
  });

  it('keeps disabled learning routes unavailable without queue delivery', async () => {
    const { f, packet } = await prepared(); f.state.enabled = false;
    for (const operation of ['/review-queue', '/review-queue-status', '/review-queue-cancel']) {
      expect((await f.graph().api(f.request(operation, packet.body))).status).toBe(404);
    }
    expect(f.messages).toHaveLength(0);
  });

  it('preserves real inline review when the separate staged switch is false', async () => {
    const { f, packet } = await prepared(); f.state.stagedEnabled = false;
    expect((await f.graph().api(f.request('/review-queue', packet.body))).status).toBe(503);
    const response = await f.graph().api(f.request('/review', packet.body));
    expect(response.status).toBe(200);
    expect(resultObject(await responseObject(response)).outcome).toBe('accepted');
    expect(f.messages).toHaveLength(0);
  });
});
