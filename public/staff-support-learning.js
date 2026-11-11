/* Optional staff learning panel. The host supplies its existing authenticated
 * request/session readers and calls suspend before hiding/changing staff views.
 * This module registers no route, reads no roles and creates no persistent store. */
(function () {
  const invalid = () => Object.assign(new Error('invalid_response'), { status: 502 });
  const scalar = (value, maximum = 200) => {
    if (typeof value !== 'string' || value.length < 1 || value.length > maximum || /[\u0000-\u001f\u007f-\u009f]/u.test(value))
      throw new Error('invalid_input');
    return value;
  };
  const positive = (value) => {
    if (!Number.isSafeInteger(value) || value < 1) throw invalid();
    return value;
  };
  // SourceResult starts at zero; an unsuccessful first proof can remain held0.
  // Positive work/review keys are a separate published SDK contract.
  const sourceCounter = (value) => {
    if (!Number.isSafeInteger(value) || value < 0) throw invalid();
    return value;
  };
  const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  const withdrawalReasons = ['privacy_withdrawal', 'source_access_revoked', 'source_deleted'];
  const invalidationReasons = ['evidence_revoked', 'product_binding_revoked', 'check_policy_revoked'];

  function createPanel(options) {
    const { root, request, readSession } = options;
    const document = options.document ?? globalThis.document;
    if (!root || typeof request !== 'function' || typeof readSession !== 'function')
      throw new TypeError('Learning panel requires the existing host request/session readers.');
    let epoch = 0;
    let context = null;
    let session = null;
    let source = null;
    let work = null;
    let shownBinding = null;
    let pending = null;
    let pendingAction = 'submit';
    let pollTimer = null;
    let polls = 0;
    let busy = false;
    let ready = false;
    let retryAt = 0;
    const controllers = new Set();
    const now = options.now ?? (() => Date.now());
    const commandId = options.commandId ?? (() => crypto.randomUUID());
    const status = element('p', 'Learning tools are not loaded.');
    status.role = 'status';
    status.ariaLive = 'polite';
    const refreshButton = button('refresh', 'Read learning source', () => refresh());
    const privatePanel = element('section');
    const sourceText = element('p');
    const workText = element('p');
    const proposalText = element('pre');
    const readWorkButton = button('work', 'Read learning work', () => read('work'));
    const proposalButton = button('proposal', 'Read private KB proposal', () => read('proposal'));
    const enrollButton = button('enroll', 'Enroll this resolved ticket', () => mutate('enroll'));
    const solution = field('solution', 'Public solution message ID');
    const verification = field('verification', 'Staff verification reference');
    const evidenceButton = button('evidence', 'Record staff-verified fix', () => mutate('evidence'));
    const reviewReason = field('review-reason', 'Review reason (optional)');
    const approveButton = button('approve', 'Approve shown proposal', () => mutate('approve'));
    const rejectButton = button('reject', 'Reject shown proposal', () => mutate('reject'));
    const withdrawReason = choice('withdraw-reason', 'Withdrawal reason', withdrawalReasons);
    const withdrawButton = button('withdraw', 'Withdraw learning source', () => mutate('withdraw'));
    const invalidateReason = choice('invalidate-reason', 'Invalidation reason', invalidationReasons);
    const invalidateButton = button('invalidate', 'Invalidate learning evidence', () => mutate('invalidate'));
    const retryButton = button('retry', 'Retry the previous exact action', () => retry());
    const receiptButton = button('check-review', 'Check the unresolved review', () => recoverReview('receipt'));
    const cancelButton = button('cancel-review', 'Cancel the unresolved review', () => recoverReview('cancel'));
    privatePanel.append(sourceText, workText, readWorkButton, proposalButton,
      proposalText, enrollButton, solution.label, verification.label, evidenceButton,
      reviewReason.label, approveButton, rejectButton, withdrawReason.label,
      withdrawButton, invalidateReason.label, invalidateButton);
    root.replaceChildren(element('h2', 'Resolution learning'),
      element('p', 'Staff review only. Approved proposals remain KB drafts for a separate publication review.'),
      status, refreshButton, privatePanel, retryButton, receiptButton, cancelButton);
    hidePrivate();
    controls();

    function element(tag, text) {
      const node = document.createElement(tag);
      if (text !== undefined) node.textContent = text;
      return node;
    }
    function button(action, label, run) {
      const node = element('button', label);
      node.type = 'button';
      node.dataset.learningAction = action;
      node.addEventListener('click', () => { void run(); });
      return node;
    }
    function field(name, labelText) {
      const label = element('label', labelText + ' ');
      const input = element('input');
      input.type = 'text';
      input.maxLength = 200;
      input.autocomplete = 'off';
      input.dataset.learningField = name;
      label.append(input);
      return { label, input };
    }
    function choice(name, labelText, values) {
      const label = element('label', labelText + ' ');
      const input = element('select');
      input.dataset.learningField = name;
      for (const value of values) {
        const option = element('option', value.replaceAll('_', ' '));
        option.value = value;
        input.append(option);
      }
      input.value = values[0];
      label.append(input);
      return { label, input };
    }
    function notice(message, error = false) {
      status.textContent = message;
      status.dataset.tone = error ? 'error' : 'neutral';
    }
    function hidePrivate() {
      privatePanel.hidden = true;
      sourceText.textContent = '';
      workText.textContent = '';
      proposalText.textContent = '';
      solution.input.value = '';
      verification.input.value = '';
      reviewReason.input.value = '';
      source = null;
      work = null;
      shownBinding = null;
      ready = false;
    }
    function stopPolling() {
      if (pollTimer !== null) globalThis.clearTimeout?.(pollTimer);
      pollTimer = null;
    }
    function pollReview(generation, candidate, held) {
      stopPolling();
      // Poll only a durably admitted intent, never an ambiguous failed write.
      // Ten read-only polls bound automatic traffic; explicit recovery remains.
      if (held || polls >= 10 || candidate.queued !== true || pending !== candidate ||
        generation !== epoch || context === null || typeof globalThis.setTimeout !== 'function') return;
      pollTimer = globalThis.setTimeout(() => {
        pollTimer = null;
        if (pending !== candidate || generation !== epoch || context === null || busy) return;
        ++polls;
        void recoverReview('receipt');
      }, 30_000);
    }
    function canRecordEvidence() {
      return source !== null && source.state !== 'withdrawn' && context?.resolved === true;
    }
    function canReadWork() {
      return source !== null && source.state === 'eligible' && source.sourceGeneration > 0;
    }
    function controls() {
      refreshButton.disabled = busy || context === null;
      const blocked = busy || !ready || context === null;
      for (const node of [enrollButton, evidenceButton, approveButton, rejectButton,
        withdrawButton, invalidateButton]) node.disabled = blocked || pending !== null;
      evidenceButton.disabled ||= !canRecordEvidence();
      approveButton.disabled ||= shownBinding === null || !canReadWork();
      rejectButton.disabled ||= shownBinding === null || !canReadWork();
      readWorkButton.disabled = blocked || !canReadWork();
      proposalButton.disabled = blocked || !canReadWork() || work?.hasProposal !== true;
      retryButton.hidden = pending === null;
      retryButton.disabled = busy || context === null || (pending?.review !== true && !ready) || pending === null ||
        pending.subject !== context?.actorSubject || pending.ticketId !== context?.ticketId;
      for (const node of [receiptButton, cancelButton]) {
        node.hidden = pending?.review !== true;
        node.disabled = busy || context === null || pending?.review !== true ||
          pending.subject !== context?.actorSubject || pending.ticketId !== context?.ticketId;
      }
      if (pending?.review === true && pendingAction === 'cancel') retryButton.textContent = 'Retry the exact cancellation';
      else if (pending?.queued === true) retryButton.textContent = 'Retry the exact queued review intent';
      else retryButton.textContent = 'Retry the previous exact action';
      for (const node of [solution.input, verification.input, reviewReason.input,
        withdrawReason.input, invalidateReason.input]) node.disabled = blocked || pending !== null;
    }
    function cancelReads() {
      for (const controller of controllers) controller.abort();
      controllers.clear();
    }
    function current(generation) {
      if (generation !== epoch || context === null)
        throw Object.assign(new Error('stale_view'), { stale: true });
    }
    function sameSession(left, right) {
      return left.subject === right.subject && left.csrfToken === right.csrfToken;
    }
    async function viewer(generation, expected) {
      const raw = await readSession();
      current(generation);
      const next = Object.freeze({
        subject: scalar(raw?.subject ?? raw?.account?.subject),
        csrfToken: scalar(raw?.csrfToken, 2_000),
      });
      if (next.subject !== context.actorSubject ||
        (expected && !sameSession(next, expected)) ||
        (pending && (pending.subject !== next.subject || pending.ticketId !== context.ticketId)))
        throw Object.assign(new Error('session_changed'), { status: 401 });
      return next;
    }
    async function call(path, init, generation, actor) {
      current(generation);
      const controller = new AbortController();
      controllers.add(controller);
      try {
        const result = await request(path, {
          ...init,
          headers: { ...(init?.headers ?? {}), 'X-Pegma-CSRF': actor.csrfToken },
          signal: controller.signal,
        });
        current(generation);
        if (!object(result) || !Object.prototype.hasOwnProperty.call(result, 'result') ||
          result.csrfToken !== actor.csrfToken) throw invalid();
        return result.result;
      } finally { controllers.delete(controller); }
    }
    function base() {
      return `/api/support/admin/tickets/${encodeURIComponent(context.ticketId)}/learning`;
    }
    function failure(error, generation) {
      if (generation !== epoch || error?.stale) return;
      stopPolling();
      hidePrivate();
      session = null;
      if (error?.status === 429) retryAt = Math.max(retryAt,
        Number.isSafeInteger(error.retryAt) ? error.retryAt : now() + 30_000);
      notice(error?.status === 401
        ? 'Current account could not be confirmed. Sign in to the original account in another tab and reload this ticket.'
        : error?.status === 403
          ? 'Current access could not be confirmed. Reload to check access again.'
          : pending
            ? 'The action may have completed. Reload, then explicitly retry the previous exact action.'
            : 'Learning data could not be confirmed. Reload before another action.', true);
      if ([401, 403].includes(error?.status)) {
        try { options.onAccessLost?.({ status: error.status, hasPending: pending !== null }); } catch { /* Host reporting cannot settle a command. */ }
      }
    }
    async function operation(run) {
      if (busy || context === null) return;
      busy = true;
      const generation = epoch;
      controls();
      try { await run(generation); }
      catch (error) { failure(error, generation); }
      finally { if (generation === epoch) { busy = false; controls(); } }
    }
    function checkedIntent(value) {
      const exact = (input, keys) => object(input) && Object.keys(input).length === keys.length &&
        keys.every((key) => Object.prototype.hasOwnProperty.call(input, key));
      if (!exact(value, ['reviewerId', 'ticketId', 'sourceGeneration', 'expectedWorkGeneration', 'target', 'policy']) ||
        value.reviewerId !== context.actorSubject || value.ticketId !== context.ticketId ||
        !exact(value.target, ['articleId', 'collectionId', 'articleRevision', 'contentHash',
          'sourceSnapshotGeneration', 'sourceSnapshotHash', 'orderedReferencesHash']) ||
        !exact(value.policy, ['version', 'binding', 'verifiedAt', 'validUntil'])) throw invalid();
      positive(value.sourceGeneration); positive(value.expectedWorkGeneration);
      positive(value.target.articleRevision); sourceCounter(value.target.sourceSnapshotGeneration);
      for (const key of ['articleId', 'collectionId']) scalar(value.target[key]);
      for (const key of ['contentHash', 'sourceSnapshotHash', 'orderedReferencesHash'])
        if (typeof value.target[key] !== 'string' || !/^[0-9a-f]{64}$/u.test(value.target[key])) throw invalid();
      scalar(value.policy.version); scalar(value.policy.binding);
      for (const key of ['verifiedAt', 'validUntil']) {
        const stamp = scalar(value.policy[key], 40); const parsed = Date.parse(stamp);
        if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== stamp) throw invalid();
      }
      return Object.freeze({ reviewerId: value.reviewerId, ticketId: value.ticketId,
        sourceGeneration: value.sourceGeneration, expectedWorkGeneration: value.expectedWorkGeneration,
        target: Object.freeze({ ...value.target }), policy: Object.freeze({ ...value.policy }) });
    }
    function validateSource(value) {
      if (!object(value) || value.ticketId !== context.ticketId ||
        !['unverified', 'eligible', 'held', 'withdrawn'].includes(value.state) ||
        typeof value.reconciliationPending !== 'boolean') throw invalid();
      sourceCounter(value.sourceGeneration);
      positive(value.resolutionCycle);
      if (value.heldReason !== undefined) scalar(value.heldReason);
      return Object.freeze({ sourceGeneration: value.sourceGeneration,
        resolutionCycle: value.resolutionCycle, state: value.state,
        reconciliationPending: value.reconciliationPending,
        heldReason: value.heldReason });
    }
    async function refresh() {
      return operation(async (generation) => {
        hidePrivate();
        notice('Reading current learning source…');
        const actor = await viewer(generation);
        let result = null;
        try { result = await call(base(), { method: 'GET' }, generation, actor); }
        catch (error) {
          // A 404 does not settle an earlier write or establish a role. Explicit
          // enrollment still receives all current server checks.
          if (error?.status !== 404) throw error;
        }
        const next = result === null ? null : validateSource(result);
        await viewer(generation, actor);
        current(generation);
        session = actor;
        source = next;
        ready = true;
        sourceText.textContent = next === null ? 'No learning source was returned.'
          : `Source ${next.sourceGeneration} · resolution cycle ${next.resolutionCycle} · ${next.state}${next.heldReason ? ' · ' + next.heldReason : ''}${next.reconciliationPending ? ' · reconciliation pending' : ''}`;
        privatePanel.hidden = false;
        notice(pending ? 'An earlier action is unresolved. Reads do not acknowledge it; retry the same action explicitly.' : 'Current source read. Each action is checked again by the server.');
      });
    }
    async function read(kind) {
      if (!ready || !canReadWork() || (kind === 'proposal' && work?.hasProposal !== true)) return;
      const selected = source.sourceGeneration;
      const previous = { source, work, sourceText: sourceText.textContent, workText: workText.textContent, session };
      return operation(async (generation) => {
        hidePrivate();
        const actor = await viewer(generation, previous.session);
        const result = await call(`${base()}/${kind}?sourceGeneration=${selected}`, { method: 'GET' }, generation, actor);
        if (!object(result) || result.ticketId !== context.ticketId ||
          (kind === 'work' && result.sourceGeneration !== selected)) throw invalid();
        let next;
        if (kind === 'work') {
          positive(result.workGeneration);
          scalar(result.status); scalar(result.stage);
          if (typeof result.hasProposal !== 'boolean') throw invalid();
          next = Object.freeze({ workGeneration: result.workGeneration,
            status: result.status, stage: result.stage, hasProposal: result.hasProposal });
        } else {
          const intent = checkedIntent(result.intent);
          if (intent.sourceGeneration !== selected ||
            !object(result.draft?.revision) || typeof result.draft.revision.title !== 'string' ||
            !object(result.draft.revision.content) || typeof result.draft.revision.content.text !== 'string' ||
            result.draft.revision.articleId !== intent.target.articleId) throw invalid();
          next = Object.freeze({ intent });
        }
        await viewer(generation, actor);
        current(generation);
        source = previous.source;
        work = previous.work;
        sourceText.textContent = previous.sourceText;
        workText.textContent = previous.workText;
        session = actor;
        ready = true;
        privatePanel.hidden = false;
        if (kind === 'work') {
          work = next;
          workText.textContent = `Work ${next.workGeneration} · ${next.status} · ${next.stage}${next.hasProposal ? ' · private proposal available' : ''}`;
        } else {
          // The actual checked revision is inert text. Echo its immutable intent
          // as a binding; the server/SDK recheck authority and new-write proof.
          proposalText.textContent = JSON.stringify(result.draft.revision, null, 2);
          shownBinding = next;
        }
        notice(kind === 'work' ? 'Current learning work read.' : 'Checked private KB proposal shown. Choose approve or reject explicitly.');
      });
    }
    function packet(action) {
      if (!ready || session === null || context === null) throw new Error('not_ready');
      let path = action;
      let value;
      if (action === 'enroll') value = { expectedRevision: context.revision };
      else if (action === 'evidence') {
        if (!canRecordEvidence()) throw new Error('not_ready');
        value = { expectedRevision: context.revision, resolutionCycle: source.resolutionCycle,
          solutionMessageId: scalar(solution.input.value), verificationReference: scalar(verification.input.value) };
      } else if (action === 'approve' || action === 'reject') {
        if (shownBinding === null || !canReadWork()) throw new Error('not_ready');
        try { path = options.stagedReviewsEnabled?.() === true ? 'review-queue' : 'review'; }
        catch { path = 'review'; }
        value = { intent: shownBinding.intent, decision: action,
          ...(reviewReason.input.value === '' ? {} : { reason: scalar(reviewReason.input.value) }) };
      } else if (action === 'withdraw' || action === 'invalidate') {
        const reason = action === 'withdraw' ? withdrawReason.input.value : invalidateReason.input.value;
        if (!(action === 'withdraw' ? withdrawalReasons : invalidationReasons).includes(reason)) throw new Error('invalid_input');
        value = { reason };
      } else throw new Error('invalid_input');
      // Never normalize a command identifier or reconstruct a sent JSON packet.
      const id = scalar(commandId());
      const body = JSON.stringify({ commandId: id, ...value });
      return Object.freeze({ subject: context.actorSubject, ticketId: context.ticketId,
        path: `${base()}/${path}`, body, commandId: id,
        review: path === 'review' || path === 'review-queue', queued: path === 'review-queue',
        reviewGeneration: path === 'review' || path === 'review-queue' ? shownBinding.intent.sourceGeneration : undefined });
    }
    function pendingChanged() {
      try { options.onPendingChange?.(pending !== null); } catch { /* The packet remains owned here. */ }
    }
    async function send(candidate, generation, action = 'submit') {
      if (now() < retryAt) {
        notice('The server requested a retry delay. Wait before retrying the same action.', true);
        return;
      }
      const expected = session;
      stopPolling();
      hidePrivate();
      controls();
      const actor = await viewer(generation, expected);
      if (candidate.subject !== actor.subject || candidate.ticketId !== context.ticketId)
        throw Object.assign(new Error('session_changed'), { status: 401 });
      current(generation);
      if (pending === null) { pending = candidate; pendingAction = 'submit'; pendingChanged(); }
      else if (pending !== candidate) throw new Error('pending_action');
      hidePrivate();
      controls();
      if (candidate.review && action === 'cancel') pendingAction = 'cancel';
      if (candidate.review && action === 'submit' && pendingAction === 'cancel') action = 'cancel';
      const path = candidate.review && action !== 'submit'
        ? candidate.path + (action === 'receipt' ? (candidate.queued ? '-status' : '-receipt') : '-cancel') : candidate.path;
      const result = await call(path, { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: candidate.body }, generation, actor);
      let cancelled = false;
      if (candidate.review) {
        if (candidate.queued && object(result) && result.outcome === 'pending') {
          if (result.ticketId !== candidate.ticketId || result.commandId !== candidate.commandId ||
            !['proof', 'commit'].includes(result.phase) || typeof result.claimed !== 'boolean' ||
            typeof result.held !== 'boolean' || typeof result.expiresAt !== 'string' ||
            !Number.isFinite(Date.parse(result.expiresAt)) || new Date(result.expiresAt).toISOString() !== result.expiresAt)
            throw invalid();
          await viewer(generation, actor);
          session = actor;
          notice(result.held
            ? 'The recorded review intent is held. Keep the original action to check or cancel it.'
            : 'The review intent is recorded and pending. This is not a completed review or KB publication.');
          pollReview(generation, candidate, result.held);
          return;
        }
        if (action === 'receipt' && result === null) {
          await viewer(generation, actor); current(generation);
          notice('No exact receipt was observed. The review may still complete; keep its original packet.', true);
          return;
        }
        if (!object(result)) throw invalid();
        if (result.outcome === 'cancelled') {
          if (result.ticketId !== candidate.ticketId || result.commandId !== candidate.commandId) throw invalid();
          cancelled = true;
        } else if (result.outcome === 'accepted') {
          const accepted = result.result;
          if (!object(accepted) || accepted.ticketId !== candidate.ticketId ||
            accepted.sourceGeneration !== candidate.reviewGeneration ||
            !['unverified', 'eligible', 'held', 'withdrawn'].includes(accepted.state)) throw invalid();
          positive(accepted.sourceGeneration); positive(accepted.resolutionCycle);
        } else throw invalid();
      } else {
        if (!object(result) || result.ticketId !== candidate.ticketId ||
          !['unverified', 'eligible', 'held', 'withdrawn'].includes(result.state)) throw invalid();
        sourceCounter(result.sourceGeneration); positive(result.resolutionCycle);
      }
      await viewer(generation, actor);
      current(generation);
      if (pending !== candidate) throw invalid();
      pending = null; pendingAction = 'submit';
      polls = 0;
      stopPolling();
      pendingChanged();
      notice(cancelled ? 'Review cancellation acknowledged. Read current state before another action.'
        : 'Action acknowledged. Read the source again before another action.');
    }
    async function mutate(action) {
      if (pending !== null || busy || !ready) return;
      let candidate;
      try { candidate = packet(action); }
      catch { notice('Complete the required bounded fields before submitting.', true); return; }
      return operation((generation) => send(candidate, generation));
    }
    async function retry() {
      if (pending === null || (pending.review !== true && !ready) || busy) return;
      return operation((generation) => send(pending, generation));
    }
    async function recoverReview(action) {
      if (pending?.review !== true || context === null || busy) return;
      return operation((generation) => send(pending, generation, action));
    }
    function suspend() {
      ++epoch;
      stopPolling();
      cancelReads();
      context = null;
      session = null;
      busy = false;
      hidePrivate();
      notice(pending ? 'An earlier action is awaiting confirmation under its original account and ticket.' : 'Learning view cleared.');
      controls();
    }
    async function showTicket(value, mode = {}) {
      suspend();
      try {
        const ticketId = scalar(value?.ticketId);
        if (!/^[A-Za-z0-9._~-]{1,200}$/u.test(ticketId)) throw new Error('invalid_input');
        context = Object.freeze({ ticketId, revision: positive(value.revision),
          actorSubject: scalar(value.actorSubject),
          resolved: ['resolved', 'closed'].includes(value.status) &&
            typeof value.resolvedAt === 'string' && Number.isFinite(Date.parse(value.resolvedAt)) });
      } catch { notice('A current staff ticket is required.', true); controls(); return; }
      if (mode.recoveryOnly === true && pending?.review === true) {
        notice('The original review is retained. Check its exact receipt or explicitly cancel it.');
        controls(); return;
      }
      return refresh();
    }
    return Object.freeze({ showTicket, refresh, suspend,
      hasPending: () => pending !== null, hasPendingReview: () => pending?.review === true });
  }
  globalThis.PegmaSupportLearning = Object.freeze({ createPanel });
})();
