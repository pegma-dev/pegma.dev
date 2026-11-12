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
    let shownReport = null;
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
    const evidenceKind = choice('evidence-kind', 'Evidence', ['staff_verified_fix', 'successful_test']);
    const verification = field('verification', 'Staff verification reference');
    const reportArticle = field('report-article', 'Knowledge article ID');
    const reportLedger = field('report-ledger', 'Report ledger epoch');
    const reportId = field('report-id', 'Knowledge report ID');
    const reportReadButton = button('report-read', 'Read current Knowledge report', () => readReport());
    const reportText = element('pre');
    const reportAssociateButton = button('report-associate', 'Associate shown report with this solution', () => mutate('test-receipt'));
    const testNotice = element('p', 'Read a confirmed passed report, explicitly associate it with this ticket and solution, then record resolution evidence. Report confirmation remains in the existing Knowledge workflow.');
    const evidenceButton = button('evidence', 'Record resolution evidence', () => mutate('evidence'));
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
      proposalText, enrollButton, solution.label, evidenceKind.label, verification.label,
      reportArticle.label, reportLedger.label, reportId.label, reportReadButton,
      reportText, reportAssociateButton, testNotice, evidenceButton,
      reviewReason.label, approveButton, rejectButton, withdrawReason.label,
      withdrawButton, invalidateReason.label, invalidateButton);
    root.replaceChildren(element('h2', 'Resolution learning'),
      element('p', 'Staff review only. Approved proposals remain KB drafts for a separate publication review.'),
      status, refreshButton, privatePanel, retryButton, receiptButton, cancelButton);
    for (const input of [reportArticle.input, reportLedger.input, reportId.input]) {
      input.addEventListener('input', () => {
        shownReport = null;
        reportText.textContent = '';
        controls();
      });
    }
    evidenceKind.input.addEventListener('change', controls);
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
      reportArticle.input.value = '';
      reportLedger.input.value = '';
      reportId.input.value = '';
      reportText.textContent = '';
      shownReport = null;
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
    function testReceiptEnabled() {
      try {
        return options.testReceiptEnabled?.() === true;
      } catch {
        return false;
      }
    }
    function ownsPending() {
      return (
        pending !== null &&
        context !== null &&
        pending.subject === context.actorSubject &&
        pending.ticketId === context.ticketId
      );
    }
    function preparedEvidence() {
      return ownsPending() && pending.intake === 'evidence' && pendingAction === 'prepared';
    }
    function canReadWork() {
      return source !== null && source.state === 'eligible' && source.sourceGeneration > 0;
    }
    function controls() {
      refreshButton.disabled = busy || context === null;
      const blocked = busy || !ready || context === null;
      for (const node of [enrollButton, evidenceButton, approveButton, rejectButton,
        withdrawButton, invalidateButton]) node.disabled = blocked || pending !== null;
      evidenceButton.disabled ||= !canRecordEvidence() || evidenceKind.input.value === 'successful_test';
      if (preparedEvidence()) evidenceButton.disabled = blocked;
      reportReadButton.disabled = blocked || pending !== null || !testReceiptEnabled();
      reportAssociateButton.disabled = blocked || pending !== null || !canRecordEvidence() ||
        !testReceiptEnabled() || shownReport?.qualified !== true;
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
      if (preparedEvidence()) retryButton.textContent = 'Record evidence from the associated report';
      else if (pending?.preparation === true) retryButton.textContent = 'Retry the exact report association';
      else if (pending?.review === true && pendingAction === 'cancel') retryButton.textContent = 'Retry the exact cancellation';
      else if (pending?.queued === true) retryButton.textContent = 'Retry the exact queued review intent';
      else if (pending?.intake) retryButton.textContent = 'Retry and reconcile the previous intake action';
      else retryButton.textContent = 'Retry the previous exact action';
      for (const node of [solution.input, evidenceKind.input, verification.input, reviewReason.input,
        withdrawReason.input, invalidateReason.input]) node.disabled = blocked || pending !== null;
      for (const node of [reportArticle.input, reportLedger.input, reportId.input])
        node.disabled = blocked || pending !== null || !testReceiptEnabled();
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
    async function callRaw(path, init, generation, actor) {
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
        return result;
      } finally { controllers.delete(controller); }
    }
    async function call(path, init, generation, actor) {
      const result = await callRaw(path, init, generation, actor);
      if (!object(result) || !Object.prototype.hasOwnProperty.call(result, 'result') ||
        result.csrfToken !== actor.csrfToken) throw invalid();
      return result.result;
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
        notice('Reading current learning sourceÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦');
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
          : `Source ${next.sourceGeneration} Ãƒâ€šÃ‚Â· resolution cycle ${next.resolutionCycle} Ãƒâ€šÃ‚Â· ${next.state}${next.heldReason ? ' Ãƒâ€šÃ‚Â· ' + next.heldReason : ''}${next.reconciliationPending ? ' Ãƒâ€šÃ‚Â· reconciliation pending' : ''}`;
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
          workText.textContent = `Work ${next.workGeneration} Ãƒâ€šÃ‚Â· ${next.status} Ãƒâ€šÃ‚Â· ${next.stage}${next.hasProposal ? ' Ãƒâ€šÃ‚Â· private proposal available' : ''}`;
        } else {
          // The actual checked revision is inert text. Echo its immutable intent
          // as a binding; the server/SDK recheck authority and new-write proof.
          proposalText.textContent = JSON.stringify(result.draft.revision, null, 2);
          shownBinding = next;
        }
        notice(kind === 'work' ? 'Current learning work read.' : 'Checked private KB proposal shown. Choose approve or reject explicitly.');
      });
    }
    function reportCoordinates() {
      const articleId = scalar(reportArticle.input.value);
      const reportIdValue = scalar(reportId.input.value);
      const ledger = reportLedger.input.value;
      if (!/^[1-9][0-9]*$/u.test(ledger)) throw new Error('invalid_input');
      return Object.freeze({
        articleId,
        ledgerEpoch: positive(Number(ledger)),
        reportId: reportIdValue,
      });
    }
    function checkedReport(value, selected) {
      if (
        !object(value) ||
        value.articleId !== selected.articleId ||
        value.reportId !== selected.reportId ||
        value.ledgerEpoch !== selected.ledgerEpoch ||
        !['pending', 'confirmed', 'rejected'].includes(value.status) ||
        !object(value.report) ||
        typeof value.report.summary !== 'string' ||
        typeof value.report.details !== 'string' ||
        !object(value.evidence) ||
        !['passed', 'failed', 'inconclusive'].includes(value.evidence.result)
      )
        throw invalid();
      positive(value.reportGeneration);
      if (
        value.expectedReportGeneration !== value.reportGeneration ||
        typeof value.reviewBindingHash !== 'string' ||
        !/^[0-9a-f]{64}$/u.test(value.reviewBindingHash)
      )
        throw invalid();
      const receipt = scalar(value.receipt);
      const qualified =
        value.status === 'confirmed' &&
        value.evidence.result === 'passed' &&
        object(value.confirmation);
      return Object.freeze({
        ...selected,
        expectedReportGeneration: value.expectedReportGeneration,
        reviewBindingHash: value.reviewBindingHash,
        receipt,
        qualified,
        display: JSON.stringify(
          {
            articleId: value.articleId,
            ledgerEpoch: value.ledgerEpoch,
            reportId: value.reportId,
            reportGeneration: value.reportGeneration,
            status: value.status,
            result: value.evidence.result,
            summary: value.report.summary,
            details: value.report.details,
          },
          null,
          2,
        ),
      });
    }
    async function readReport() {
      if (!ready || pending !== null || !testReceiptEnabled()) return;
      let selected;
      try {
        selected = reportCoordinates();
      } catch {
        notice('Complete the article, positive ledger epoch and report ID before reading.', true);
        return;
      }
      const expected = session;
      shownReport = null;
      reportText.textContent = '';
      return operation(async (generation) => {
        const actor = await viewer(generation, expected);
        const value = await callRaw(
          '/api/staff/knowledge/command',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ operation: 'reportRead', input: selected }),
          },
          generation,
          actor,
        );
        const checked = checkedReport(value, selected);
        await viewer(generation, actor);
        current(generation);
        if (!testReceiptEnabled()) {
          notice('Test-report association is unavailable.', true);
          return;
        }
        session = actor;
        shownReport = checked;
        reportText.textContent = checked.display;
        notice(
          checked.qualified
            ? 'Confirmed passed report shown. Explicitly associate it with this ticket revision, resolution cycle and public solution.'
            : 'This report cannot be associated. Use the existing Knowledge confirmation workflow for a confirmed passed report.',
        );
      });
    }
    function packet(action) {
      if (!ready || session === null || context === null) throw new Error('not_ready');
      let path = action;
      let value;
      if (action === 'test-receipt') {
        if (!canRecordEvidence() || !testReceiptEnabled() || shownReport?.qualified !== true)
          throw new Error('not_ready');
        const selected = reportCoordinates();
        if (selected.articleId !== shownReport.articleId ||
          selected.ledgerEpoch !== shownReport.ledgerEpoch ||
          selected.reportId !== shownReport.reportId)
          throw new Error('report_changed');
        value = {
          expectedPrincipalId: context.actorSubject,
          expectedRevision: context.revision,
          resolutionCycle: source.resolutionCycle,
          solutionMessageId: scalar(solution.input.value),
          report: {
            articleId: shownReport.articleId,
            ledgerEpoch: shownReport.ledgerEpoch,
            reportId: shownReport.reportId,
            expectedReportGeneration: shownReport.expectedReportGeneration,
            reviewBindingHash: shownReport.reviewBindingHash,
            receipt: shownReport.receipt,
          },
        };
      } else if (action === 'enroll') value = { expectedRevision: context.revision };
      else if (action === 'evidence') {
        if (!canRecordEvidence()) throw new Error('not_ready');
        const common = { expectedRevision: context.revision, resolutionCycle: source.resolutionCycle,
          solutionMessageId: scalar(solution.input.value) };
        if (evidenceKind.input.value === 'staff_verified_fix')
          value = { ...common, verificationReference: scalar(verification.input.value) };
        else throw new Error('invalid_input');
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
        preparation: action === 'test-receipt',
        preparationEvidence: action === 'test-receipt' ? Object.freeze({ expectedRevision: value.expectedRevision,
          resolutionCycle: value.resolutionCycle, solutionMessageId: value.solutionMessageId }) : undefined,
        review: path === 'review' || path === 'review-queue', queued: path === 'review-queue',
        intake: action === 'enroll' || action === 'evidence' ? action : null,
        expectedRevision: action === 'enroll' || action === 'evidence' ? value.expectedRevision : undefined,
        reviewGeneration: path === 'review' || path === 'review-queue' ? shownBinding.intent.sourceGeneration : undefined });
    }
    function checkedPreparation(candidate, result) {
      const keys = ['actorId', 'ticketId', 'commandId', 'receipt', 'validUntil'];
      if (
        !object(result) ||
        Object.keys(result).length !== keys.length ||
        !keys.every((key) => Object.prototype.hasOwnProperty.call(result, key)) ||
        result.actorId !== candidate.subject ||
        result.ticketId !== candidate.ticketId ||
        result.commandId !== candidate.commandId
      )
        throw invalid();
      const receipt = scalar(result.receipt);
      const stamp = scalar(result.validUntil, 40);
      const parsed = Date.parse(stamp);
      if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== stamp) throw invalid();
      return receipt;
    }
    function preparedPacket(candidate, receipt) {
      const id = scalar(commandId());
      return Object.freeze({
        subject: candidate.subject,
        ticketId: candidate.ticketId,
        path: candidate.path.replace(/\/test-receipt$/u, '/evidence'),
        body: JSON.stringify({
          commandId: id,
          ...candidate.preparationEvidence,
          kind: 'successful_test',
          receipt,
        }),
        commandId: id,
        review: false,
        queued: false,
        intake: 'evidence',
        expectedRevision: candidate.preparationEvidence.expectedRevision,
      });
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
        ? candidate.path + (action === 'receipt' ? (candidate.queued ? '-status' : '-receipt') : '-cancel')
        : candidate.intake && action === 'recover' ? candidate.path + '-recovery' : candidate.path;
      if (pendingAction === 'prepared') pendingAction = 'submit';
      let result = await call(path, { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: candidate.body }, generation, actor);
      if (candidate.preparation === true) {
        const receipt = checkedPreparation(candidate, result);
        await viewer(generation, actor);
        current(generation);
        if (pending !== candidate) throw invalid();
        pending = preparedPacket(candidate, receipt);
        pendingAction = 'prepared';
        session = actor;
        ready = true;
        privatePanel.hidden = false;
        pendingChanged();
        notice('Report associated. Resolution evidence has not been recorded. Choose Record resolution evidence explicitly.');
        return;
      }
      let cancelled = false;
      let superseded = false;
      if (candidate.intake && action === 'recover') {
        if (!object(result) || result.ticketId !== candidate.ticketId || result.commandId !== candidate.commandId ||
          result.operation !== candidate.intake) throw invalid();
        const scoped = ['outcome', 'ticketId', 'commandId', 'operation'];
        const keys = result.outcome === 'accepted' ? [...scoped, 'result']
          : result.outcome === 'superseded' ? [...scoped, 'expectedRevision', 'observedRevision', ...(Object.hasOwn(result, 'fence') ? ['fence'] : [])] : scoped;
        if (Object.keys(result).sort().join(',') !== keys.sort().join(',')) throw invalid();
        if (result.outcome === 'pending') {
          await viewer(generation, actor); current(generation);
          notice('Keep this unresolved action and retry its exact packet. If the ticket needs a reply or status change, use another staff tab, then retry here after the revision advances.', true);
          return;
        }
        if (result.outcome === 'superseded') {
          if (result.expectedRevision !== candidate.expectedRevision || !Number.isSafeInteger(result.observedRevision)) throw invalid();
          if (Object.hasOwn(result, 'fence')) {
            if (candidate.intake !== 'evidence' || result.observedRevision !== candidate.expectedRevision ||
              !['resolution_unavailable', 'solution_unavailable', 'resolution_cycle_changed'].includes(result.fence)) throw invalid();
          } else if (result.observedRevision <= candidate.expectedRevision) throw invalid();
          superseded = true;
        } else if (result.outcome === 'accepted') result = result.result;
        else throw invalid();
      }
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
      } else if (!superseded) {
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
      notice(superseded ? 'The original action is fenced from future application. Its earlier outcome remains unknown. Read current state before another action.'
        : cancelled ? 'Review cancellation acknowledged. Read current state before another action.'
        : 'Action acknowledged. Read the source again before another action.');
    }
    async function mutate(action) {
      if (action === 'evidence' && preparedEvidence() && !busy && ready)
        return operation((generation) => send(pending, generation));
      if (pending !== null || busy || !ready) return;
      let candidate;
      try { candidate = packet(action); }
      catch { notice('Complete the required bounded fields before submitting.', true); return; }
      return operation((generation) => send(candidate, generation));
    }
    async function retry() {
      if (pending === null || (pending.review !== true && !ready) || busy) return;
      return operation((generation) => send(pending, generation, pending.intake && pendingAction !== 'prepared' ? 'recover' : 'submit'));
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
