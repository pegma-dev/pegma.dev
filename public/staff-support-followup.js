(function (global) {
  'use strict';
  const sameSession = (a, b) =>
    a?.subject === b?.subject && a?.csrfToken === b?.csrfToken;
  function createPanel(options) {
    const { root, request, readSession, readCurrentTicket } = options;
    let context = null;
    let work = null;
    let owner = null;
    let ownerState = null;
    let epoch = 0;
    let busy = false;
    let retryAt = 0;
    let timer = null;
    let cursor = null;
    let associations = [];
    let mappingView = null;
    let shownReport = null;
    let reportVersion = 0;
    const now = options.now ?? Date.now;
    const commandId = options.commandId ?? (() => global.crypto.randomUUID());
    const doc = root.ownerDocument ?? document;
    const create = (tag, text) => {
      const node = doc.createElement(tag);
      if (text !== undefined) node.textContent = text;
      return node;
    };
    const heading = create('h2', 'Release follow-up');
    const status = create(
      'p',
      'Check the optional release-follow-up controls.',
    );
    status.setAttribute('role', 'status');
    const workId = create('input');
    workId.dataset.followupField = 'workId';
    workId.setAttribute('aria-label', 'Follow-up work ID');
    const reference = create('input');
    reference.dataset.followupField = 'inputReference';
    reference.setAttribute('aria-label', 'Trusted release input reference');
    const repository = create('input');
    repository.dataset.followupField = 'repositoryId';
    repository.setAttribute('aria-label', 'Accepted repository ID');
    const issue = create('input');
    issue.dataset.followupField = 'issueId';
    issue.setAttribute('aria-label', 'Accepted issue ID');
    const association = create('select');
    association.dataset.followupField = 'association';
    const mappingFields = {};
    for (const name of [
      'releaseRef',
      'productId',
      'version',
      'buildId',
      'deploymentId',
      'deploymentEpoch',
      'scopeRef',
      'verificationReference',
    ]) {
      const field = create('input');
      field.maxLength = 200;
      field.dataset.followupField = name;
      mappingFields[name] = field;
    }
    mappingFields.releaseRef.readOnly = true;
    mappingFields.productId.readOnly = true;
    for (const [name, values] of [
      ['issueState', ['open', 'closed']],
      ['deploymentState', ['unknown', 'deployed', 'rolled_back']],
    ]) {
      const field = create('select');
      field.dataset.followupField = name;
      for (const value of values) {
        const option = create('option', value);
        option.value = value;
        field.append(option);
      }
      mappingFields[name] = field;
    }
    const facts = create('textarea');
    facts.maxLength = 10000;
    facts.dataset.followupField = 'publicFacts';
    const verified = create('input');
    verified.type = 'checkbox';
    verified.dataset.followupField = 'mappingVerified';
    const mappingControls = create('fieldset');
    mappingControls.className = 'account-form';
    mappingControls.append(
      create('legend', 'Staff-verified deployed fix'),
      labelled('Accepted engineering association', association),
      ...Object.entries(mappingFields).map(([name, field]) =>
        labelled(
          {
            releaseRef: 'Current release reference',
            productId: 'Product',
            version: 'Fixed version',
            buildId: 'Fixed build',
            deploymentId: 'Deployment ID',
            deploymentEpoch: 'Deployment version',
            scopeRef: 'Deployment scope',
            verificationReference: 'Verification reference',
            issueState: 'Issue state',
            deploymentState: 'Deployment state',
          }[name],
          field,
        ),
      ),
      labelled(
        'Public facts JSON: one to four unique {reference,text} entries',
        facts,
      ),
      labelled(
        'I verified these issue, deployment and product facts.',
        verified,
      ),
    );
    association.addEventListener('change', () => {
      mappingView = null;
      reference.value = '';
      verified.checked = false;
      const selected =
        association.value === ''
          ? undefined
          : associations[Number(association.value)];
      repository.value = selected?.repositoryId ?? '';
      issue.value = selected?.issueId ?? '';
      mappingFields.productId.value = selected?.product?.productId ?? '';
      render();
    });
    const reason = create('input');
    reason.dataset.followupField = 'reason';
    reason.setAttribute('aria-label', 'Staff hold or rejection reason');
    const content = create('textarea');
    const retestRequest = create('select');
    retestRequest.dataset.followupField = 'retestRequestId';
    const reportFields = {};
    for (const name of ['articleId', 'ledgerEpoch', 'reportId']) {
      const field = create('input');
      field.maxLength = 200;
      field.dataset.followupField = name;
      reportFields[name] = field;
      for (const event of ['input', 'change'])
        field.addEventListener(event, () => {
          ++reportVersion;
          shownReport = null;
          reportView.textContent = '';
          render();
        });
    }
    const reportView = create('pre');
    reportView.className = 'support-message-body';
    retestRequest.addEventListener('change', () => {
      ++reportVersion;
      shownReport = null;
      reportView.textContent = '';
      render();
    });
    const retestControls = create('fieldset');
    retestControls.className = 'account-form';
    retestControls.append(
      create('legend', 'Record a verified retest result'),
      labelled('Exact retest request', retestRequest),
      labelled('Knowledge article ID', reportFields.articleId),
      labelled('Report ledger epoch', reportFields.ledgerEpoch),
      labelled('Knowledge report ID', reportFields.reportId),
      reportView,
    );
    content.dataset.followupField = 'content';
    content.setAttribute(
      'aria-label',
      'Complete retained follow-up candidate JSON',
    );
    const privateView = create('pre');
    content.rows = 8;
    function labelled(text, field) {
      const label = create('label', text);
      label.append(field);
      return label;
    }
    const controls = new Map();
    for (const field of [workId, reference, repository, issue, reason])
      field.maxLength = 200;
    content.maxLength = 16_000;
    const actions = create('div');
    function add(action, text) {
      const button = create('button', text);
      button.type = 'button';
      button.dataset.followupAction = action;
      button.addEventListener('click', () => {
        void perform(action);
      });
      controls.set(action, button);
      actions.append(button);
    }
    add('mapping-list', 'Load accepted issue choices');
    add('mapping', 'Read selected fix mapping');
    add('verify-mapping', 'Record this staff verification');
    add('withdraw-mapping', 'Withdraw this verified mapping');
    add('scan', 'Find follow-up work');
    add('work', 'Read private follow-up');
    add('observe', 'Verify trusted release input');
    add('reassess', 'Check retained draft and edits');
    add('post', 'Approve and post this exact web update');
    add('reject', 'Reject checked bundle');
    add('retry', 'Retry draftless work');
    add('abandon', 'Hold this work');
    add('report-read', 'Read current Knowledge report');
    add('retest-receipt', 'Associate this report with the retest');
    add('retest-result', 'Record the prepared retest result');
    add('exact-retry', 'Retry the exact previous command');
    add('discard', 'Discard an unsent or rejected command');
    root.replaceChildren(
      heading,
      status,
      labelled('Follow-up work ID', workId),
      labelled('Trusted release input reference', reference),
      labelled('Accepted repository ID', repository),
      labelled('Accepted issue ID', issue),
      labelled('Staff hold or rejection reason', reason),
      labelled('Complete retained candidate JSON', content),
      privateView,
      mappingControls,
      retestControls,
      actions,
    );
    function notify() {
      options.onPendingChange?.(
        owner === null
          ? null
          : Object.freeze({
              actorSubject: owner.actorSubject,
              ticketId: owner.ticketId,
            }),
      );
    }
    function render() {
      const ready = context !== null && options.canRequest?.() !== false;
      const owns =
        owner !== null &&
        context?.actorSubject === owner.actorSubject &&
        context?.ticketId === owner.ticketId;
      for (const [action, button] of controls) {
        button.disabled =
          !ready ||
          busy ||
          now() < retryAt ||
          (['exact-retry', 'retest-result', 'discard'].includes(action)
            ? !owns ||
              (action === 'discard' && !canDiscard()) ||
              (action === 'retest-result' && owner.operation !== 'retest')
            : owner !== null) ||
          (action === 'report-read' && work === null) ||
          (action === 'retest-receipt' &&
            (work === null ||
              shownReport?.qualified !== true ||
              retestRequest.value === '')) ||
          (['verify-mapping', 'withdraw-mapping'].includes(action) &&
            mappingView === null) ||
          (['reassess', 'post', 'reject', 'retry', 'abandon'].includes(
            action,
          ) &&
            work === null) ||
          (['post', 'reject'].includes(action) && work?.prepared === undefined);
      }
      for (const field of [
        workId,
        reference,
        repository,
        issue,
        reason,
        content,
        association,
        facts,
        verified,
        ...Object.values(mappingFields),
        retestRequest,
        ...Object.values(reportFields),
      ])
        field.disabled = !ready || busy || owner !== null;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (ready && retryAt > now())
        timer = setTimeout(
          () => {
            timer = null;
            render();
          },
          Math.min(60_000, retryAt - now()),
        );
    }
    function canDiscard() {
      return (
        owner !== null &&
        ownerState !== null &&
        !ownerState.uncertain &&
        (!ownerState.sent || ownerState.rejected)
      );
    }
    function terminalPreparationRefusal(error) {
      return owner?.operation === 'retest-receipt' &&
        ((error.status === 410 && error.code === 'followup_retest_expired') ||
          (error.status === 429 && error.code === 'followup_retest_capacity'));
    }
    async function ownedRequest(send, qualify) {
      const state = ownerState;
      const previouslyUncertain = state.uncertain;
      state.sent = true;
      state.uncertain = true;
      state.rejected = false;
      let response;
      try {
        response = await send();
      } catch (error) {
        // A closed refusal cannot erase a prior unknown acknowledgement.
        if (([400, 409, 413].includes(error.status) || terminalPreparationRefusal(error)) && !previouslyUncertain) {
          state.uncertain = false;
          state.rejected = true;
        }
        throw error;
      }
      const result = await qualify(response);
      state.uncertain = previouslyUncertain;
      return result;
    }
    function clearPrivate() {
      work = null;
      ++reportVersion;
      shownReport = null;
      reportView.textContent = '';
      retestRequest.replaceChildren();
      retestRequest.value = '';
      for (const field of Object.values(reportFields)) field.value = '';
      privateView.textContent = '';
      content.value = '';
      associations = [];
      mappingView = null;
      association.replaceChildren();
      facts.value = '';
      verified.checked = false;
      for (const field of Object.values(mappingFields)) field.value = '';
      for (const field of [workId, reference, repository, issue, reason])
        field.value = '';
    }
    function suspend() {
      ++epoch;
      context = null;
      clearPrivate();
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      status.textContent =
        owner === null
          ? 'Reload current staff access.'
          : 'Keep this tab open. The original command may have completed. Restore its original account and reload the ticket.';
      render();
    }
    function ensure(token, selected) {
      if (
        epoch !== token ||
        context !== selected ||
        options.canRequest?.() === false
      )
        throw Object.assign(new Error('stale_followup_view'), { stale: true });
    }
    async function authority(token, selected) {
      ensure(token, selected);
      const session = await readSession();
      ensure(token, selected);
      if (
        session?.subject !== selected.actorSubject ||
        typeof session.csrfToken !== 'string' ||
        session.csrfToken === ''
      )
        throw Object.assign(new Error('original_actor_required'), {
          status: 401,
        });
      const current = await readCurrentTicket(selected.ticketId);
      ensure(token, selected);
      if (
        current?.ticket?.id !== selected.ticketId ||
        current.csrfToken !== session.csrfToken
      )
        throw new Error('invalid_current_ticket');
      const closing = await readSession();
      ensure(token, selected);
      if (!sameSession(session, closing))
        throw Object.assign(new Error('session_changed'), { status: 401 });
      return session;
    }
    function path(selected, operation) {
      return (
        '/api/support/admin/tickets/' +
        encodeURIComponent(selected.ticketId) +
        '/follow-up/' +
        operation
      );
    }
    function required(value, label) {
      const text = typeof value === 'string' ? value.trim() : '';
      if (
        text.length < 1 ||
        text.length > 200 ||
        /[\u0000-\u001F\u007F]/u.test(text)
      )
        throw Object.assign(new Error('Enter ' + label + ' before sending.'), {
          local: true,
        });
      return text;
    }
    function currentRetestRequests() {
      const values =
        work?.prepared?.bundle?.retestRequests ?? work?.handoff?.retestRequests;
      return Array.isArray(values) &&
        values.length <= 4 &&
        values.every(
          (value) =>
            value &&
            typeof value.requestId === 'string' &&
            value.requestId.length > 0 &&
            value.requestId.length <= 200,
        )
        ? values
        : [];
    }
    function showRetestRequests() {
      ++reportVersion;
      shownReport = null;
      reportView.textContent = '';
      retestRequest.replaceChildren();
      const placeholder = create('option', 'Choose the exact retest request');
      placeholder.value = '';
      retestRequest.append(placeholder);
      for (const item of currentRetestRequests()) {
        const option = create(
          'option',
          item.requestId + ' · ' + item.expectedBehavior,
        );
        option.value = item.requestId;
        retestRequest.append(option);
      }
      retestRequest.value = '';
    }
    function reportCoordinates() {
      const articleId = reportFields.articleId.value;
      const reportId = reportFields.reportId.value;
      if (
        ![articleId, reportId].every(
          (v) =>
            typeof v === 'string' &&
            v.trim().length > 0 &&
            v.length <= 200 &&
            !/[\u0000-\u001f\u007f]/u.test(v),
        ) ||
        !/^[1-9][0-9]*$/u.test(reportFields.ledgerEpoch.value)
      )
        throw Object.assign(
          new Error(
            'Complete the article, positive ledger epoch and report ID before reading.',
          ),
          { local: true },
        );
      const ledgerEpoch = Number(reportFields.ledgerEpoch.value);
      if (!Number.isSafeInteger(ledgerEpoch))
        throw Object.assign(new Error('Enter a valid report ledger epoch.'), {
          local: true,
        });
      return { articleId, ledgerEpoch, reportId };
    }
    function readReportView(value, coordinates) {
      if (
        !value ||
        value.articleId !== coordinates.articleId ||
        value.ledgerEpoch !== coordinates.ledgerEpoch ||
        value.reportId !== coordinates.reportId ||
        !Number.isSafeInteger(value.reportGeneration) ||
        value.reportGeneration < 1 ||
        value.expectedReportGeneration !== value.reportGeneration ||
        !/^[a-f0-9]{64}$/u.test(value.reviewBindingHash) ||
        typeof value.receipt !== 'string' ||
        value.receipt.length < 1 ||
        value.receipt.length > 200 ||
        !['pending', 'confirmed', 'rejected'].includes(value.status) ||
        !['passed', 'failed', 'inconclusive'].includes(
          value.evidence?.result,
        ) ||
        typeof value.report?.summary !== 'string' ||
        typeof value.report?.details !== 'string'
      )
        throw new Error('invalid_current_report');
      return Object.freeze({
        ...coordinates,
        expectedReportGeneration: value.reportGeneration,
        reviewBindingHash: value.reviewBindingHash,
        receipt: value.receipt,
        qualified:
          value.status === 'confirmed' &&
          ['passed', 'failed'].includes(value.evidence.result) &&
          value.confirmation !== null &&
          typeof value.confirmation === 'object',
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
    function preparationResult(httpStatus, value, packet) {
      const pending = httpStatus === 202;
      const keys = [
        'actorId',
        'ticketId',
        'commandId',
        'workId',
        'retestRequestId',
        ...(pending ? ['pending'] : ['receipt', 'validUntil']),
      ];
      if (
        ![200, 202].includes(httpStatus) ||
        !value ||
        Object.keys(value).sort().join(',') !== keys.sort().join(',') ||
        value.actorId !== packet.actorSubject ||
        value.ticketId !== packet.ticketId ||
        value.commandId !== packet.commandId ||
        value.workId !== packet.workId ||
        value.retestRequestId !== packet.retestRequestId
      )
        throw new Error('unconfirmed_retest_preparation');
      if (pending) {
        if (value.pending !== 'report')
          throw new Error('invalid_pending_phase');
        return { pending: true };
      }
      if (
        typeof value.receipt !== 'string' ||
        !value.receipt.trim() ||
        value.receipt.length > 200 ||
        typeof value.validUntil !== 'string' ||
        !Number.isFinite(Date.parse(value.validUntil)) ||
        new Date(value.validUntil).toISOString() !== value.validUntil
      )
        throw new Error('invalid_retest_receipt');
      return { pending: false, receipt: value.receipt };
    }
    function ack(value, packet) {
      if (['verify-mapping', 'withdraw-mapping'].includes(packet.operation))
        return (
          value?.result?.actorId === packet.actorSubject &&
          value.result.ticketId === packet.ticketId &&
          value.result.commandId === packet.commandId &&
          Number.isSafeInteger(value.result.mappingGeneration) &&
          value.result.mappingGeneration >= 1 &&
          typeof value.result.inputReference === 'string' &&
          value.result.inputReference.length > 0
        );

      if (
        value?.commandId !== packet.commandId ||
        value.operation !== packet.operation ||
        value.result?.ticketId !== packet.ticketId
      )
        return false;
      if (packet.operation === 'observe')
        return (
          Number.isSafeInteger(value.result.headGeneration) &&
          ['queued', 'unchanged', 'held', 'stale'].includes(
            value.result.outcome,
          )
        );
      if (value.result.workId !== packet.workId) return false;
      if (packet.operation === 'retest')
        return (
          Object.keys(value.result).sort().join(',') ===
            'outcome,result,ticketId,workId' &&
          ['recorded', 'unchanged', 'held'].includes(value.result.outcome) &&
          ['passed', 'failed'].includes(value.result.result)
        );
      if (packet.operation === 'post')
        return (
          value.result.messageId === packet.messageId &&
          value.result.bundleHash === packet.bundleHash &&
          Number.isSafeInteger(value.result.ticketRevision) &&
          value.result.ticketRevision >= 1
        );
      return (
        Number.isSafeInteger(value.result.workGeneration) &&
        value.result.workGeneration >= 1 &&
        typeof value.result.status === 'string'
      );
    }
    async function perform(action) {
      if (
        !controls.has(action) ||
        context === null ||
        busy ||
        options.canRequest?.() === false ||
        now() < retryAt
      )
        return;
      const selected = context;
      const token = epoch;
      if (
        owner !== null &&
        (!['exact-retry', 'retest-result', 'discard'].includes(action) ||
          owner.actorSubject !== selected.actorSubject ||
          owner.ticketId !== selected.ticketId)
      )
        return;
      busy = true;
      options.onBusyChange?.(true);
      render();
      try {
        let session = await authority(token, selected);
        if (action === 'discard') {
          if (!canDiscard()) return;
          owner = null;
          ownerState = null;
          notify();
          clearPrivate();
          status.textContent =
            'The unsent or rejected command was discarded locally. Reload current follow-up state before preparing another command.';
          return;
        }
        if (action === 'report-read') {
          if (
            !currentRetestRequests().some(
              (item) => item.requestId === retestRequest.value,
            )
          )
            throw Object.assign(
              new Error('Read work and choose its exact retest request first.'),
              { local: true },
            );
          const coordinates = reportCoordinates();
          const observed = reportVersion;
          const chosen = retestRequest.value;
          shownReport = null;
          reportView.textContent = '';
          const value = await request('/api/staff/knowledge/command', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Pegma-CSRF': session.csrfToken,
            },
            body: JSON.stringify({
              operation: 'reportRead',
              input: coordinates,
            }),
          });
          ensure(token, selected);
          const closing = await readSession();
          ensure(token, selected);
          if (!sameSession(session, closing))
            throw Object.assign(new Error('session_changed'), { status: 401 });
          if (
            observed !== reportVersion ||
            chosen !== retestRequest.value ||
            JSON.stringify(reportCoordinates()) !== JSON.stringify(coordinates)
          ) {
            status.textContent =
              'The report selection changed. Read the selected report again.';
            return;
          }
          shownReport = readReportView(value, coordinates);
          reportView.textContent = shownReport.display;
          status.textContent = shownReport.qualified
            ? 'Confirmed report shown. Associate this exact report version with the selected retest.'
            : 'This report is pending, rejected or inconclusive. Use the existing Knowledge confirmation workflow before association.';
          return;
        }
        if (action === 'mapping-list' || action === 'mapping') {
          const suffix =
            action === 'mapping-list'
              ? ''
              : '?' +
                new URLSearchParams({
                  repositoryId: required(
                    repository.value,
                    'an accepted repository',
                  ),
                  issueId: required(issue.value, 'an accepted issue'),
                });
          const value = await request(path(selected, 'mapping') + suffix);
          ensure(token, selected);
          const closing = await readSession();
          ensure(token, selected);
          const view = value?.result;
          if (
            !sameSession(session, closing) ||
            value.csrfToken !== closing.csrfToken ||
            view?.actorId !== selected.actorSubject ||
            view.ticketId !== selected.ticketId ||
            !Number.isSafeInteger(view.ticketRevision) ||
            view.ticketRevision < 1
          )
            throw new Error('invalid_mapping_response');
          if (action === 'mapping-list') {
            if (
              !Array.isArray(view.choices) ||
              view.choices.length > 16 ||
              typeof view.hasMore !== 'boolean' ||
              view.choices.some(
                (entry) =>
                  typeof entry.repositoryId !== 'string' ||
                  typeof entry.issueId !== 'string' ||
                  !Number.isSafeInteger(entry.issueNumber) ||
                  typeof entry.repositoryName !== 'string',
              )
            )
              throw new Error('invalid_mapping_choices');
            associations = view.choices;
            mappingView = null;
            reference.value = '';
            verified.checked = false;
            association.replaceChildren();
            const placeholder = create('option', 'Choose an accepted issue');
            placeholder.value = '';
            association.append(placeholder);
            associations.forEach((entry, index) => {
              const option = create(
                'option',
                entry.repositoryName + ' #' + entry.issueNumber,
              );
              option.value = String(index);
              association.append(option);
            });
            association.value = '';
            repository.value = '';
            issue.value = '';
            status.textContent = view.hasMore
              ? 'The bounded issue list has more associations. Select one of the visible accepted issues.'
              : 'Choose an accepted issue, then read its current mapping.';
          } else {
            if (
              view.repositoryId !== repository.value ||
              view.issueId !== issue.value ||
              !Number.isSafeInteger(view.mappingGeneration) ||
              view.mappingGeneration < 0 ||
              !(view.mapping === null || typeof view.mapping === 'object') ||
              !(view.release === null || typeof view.release === 'object')
            )
              throw new Error('invalid_mapping_view');
            mappingView = view;
            verified.checked = false;
            const mapping = view.mapping;
            reference.value =
              mapping?.current === true && mapping.withdrawn !== true
                ? mapping.inputReference
                : '';
            for (const name of [
              'deploymentId',
              'deploymentEpoch',
              'scopeRef',
              'verificationReference',
            ])
              mappingFields[name].value = mapping?.[name] ?? '';
            mappingFields.releaseRef.value = view.release?.releaseRef ?? '';
            mappingFields.productId.value =
              associations.find(
                (entry) =>
                  entry.repositoryId === view.repositoryId &&
                  entry.issueId === view.issueId,
              )?.product?.productId ??
              mapping?.fixedProduct?.productId ??
              '';
            mappingFields.version.value = mapping?.fixedProduct?.version ?? '';
            mappingFields.buildId.value = mapping?.fixedProduct?.buildId ?? '';
            mappingFields.issueState.value = mapping?.issueState ?? 'open';
            mappingFields.deploymentState.value =
              mapping?.deploymentState ?? 'unknown';
            facts.value = JSON.stringify(mapping?.publicFacts ?? [], null, 2);
            privateView.textContent = JSON.stringify(view, null, 2);
            status.textContent =
              'Inspect the authenticated release and verify the entered facts. Issue closure alone is not deployment proof.';
          }
          return;
        }
        if (action === 'scan' || action === 'work') {
          const suffix =
            action === 'scan'
              ? cursor === null
                ? ''
                : '?cursor=' + encodeURIComponent(cursor)
              : '?workId=' + encodeURIComponent(workId.value.trim());
          const value = await request(path(selected, action) + suffix);
          ensure(token, selected);
          const closing = await readSession();
          ensure(token, selected);
          if (
            !sameSession(session, closing) ||
            value?.csrfToken !== closing.csrfToken ||
            value.result?.ticketId !== selected.ticketId
          )
            throw new Error('invalid_followup_response');
          if (action === 'scan') {
            const keys = [
              ...(value.result.reviewCandidates ?? []),
              ...(value.result.candidates ?? []),
            ];
            if (
              !Array.isArray(value.result.reviewCandidates) ||
              !Array.isArray(value.result.candidates) ||
              keys.some(
                (key) =>
                  key.ticketId !== selected.ticketId ||
                  typeof key.workId !== 'string',
              ) ||
              !(
                value.result.nextCursor === null ||
                typeof value.result.nextCursor === 'string'
              )
            )
              throw new Error('invalid_followup_page');
            cursor = value.result.nextCursor;
            privateView.textContent = keys.map((key) => key.workId).join('\n');
            if (keys[0]) workId.value = keys[0].workId;
            status.textContent =
              cursor === null
                ? 'Bounded follow-up scan complete.'
                : 'More records remain. Find follow-up work again to continue.';
          } else {
            if (
              value.result.workId !== workId.value.trim() ||
              !Number.isSafeInteger(value.result.workGeneration) ||
              value.result.workGeneration < 1
            )
              throw new Error('invalid_followup_work');
            work = value.result;
            showRetestRequests();
            privateView.textContent = JSON.stringify(work, null, 2);
            content.value =
              work.candidate === undefined
                ? ''
                : JSON.stringify(work.candidate, null, 2);
            status.textContent =
              'Private follow-up loaded. Review the complete bundle before posting.';
          }
          return;
        }
        if (owner === null) {
          const id = commandId();
          let body;
          if (action === 'retest-receipt') {
            const expectedTicketRevision =
              work?.delivered?.ticketRevision ?? work?.acceptedTicketRevision;
            const coordinates = reportCoordinates();
            if (
              work === null ||
              work.workId !== workId.value.trim() ||
              shownReport?.qualified !== true ||
              ['articleId', 'ledgerEpoch', 'reportId'].some(
                (key) => coordinates[key] !== shownReport[key],
              ) ||
              !currentRetestRequests().some(
                (item) => item.requestId === retestRequest.value,
              ) ||
              !Number.isSafeInteger(expectedTicketRevision) ||
              expectedTicketRevision < 1
            )
              throw Object.assign(
                new Error(
                  'Read current work, choose its retest and read a confirmed report first.',
                ),
                { local: true },
              );
            body = {
              commandId: id,
              expectedPrincipalId: selected.actorSubject,
              workId: work.workId,
              expectedWorkGeneration: work.workGeneration,
              expectedTicketRevision: expectedTicketRevision,
              retestRequestId: retestRequest.value,
              report: {
                ...coordinates,
                expectedReportGeneration: shownReport.expectedReportGeneration,
                reviewBindingHash: shownReport.reviewBindingHash,
                receipt: shownReport.receipt,
              },
            };
          } else if (
            action === 'verify-mapping' ||
            action === 'withdraw-mapping'
          ) {
            if (
              mappingView === null ||
              mappingView.repositoryId !== repository.value ||
              mappingView.issueId !== issue.value
            )
              throw Object.assign(
                new Error('Read the current selected mapping first.'),
                { local: true },
              );
            body = {
              commandId: id,
              expectedPrincipalId: selected.actorSubject,
              expectedTicketRevision: mappingView.ticketRevision,
              expectedMappingGeneration: mappingView.mappingGeneration,
              repositoryId: mappingView.repositoryId,
              issueId: mappingView.issueId,
            };
            if (action === 'withdraw-mapping')
              body.reason = required(reason.value, 'a withdrawal reason');
            else {
              if (!verified.checked)
                throw Object.assign(
                  new Error(
                    'Confirm the facts you actually verified before recording them.',
                  ),
                  { local: true },
                );
              let publicFacts;
              try {
                publicFacts = JSON.parse(facts.value);
              } catch {
                throw Object.assign(
                  new Error('Enter valid public facts JSON.'),
                  { local: true },
                );
              }
              if (
                !Array.isArray(publicFacts) ||
                publicFacts.length < 1 ||
                publicFacts.length > 4 ||
                publicFacts.some(
                  (fact) =>
                    !fact ||
                    Object.keys(fact).sort().join(',') !== 'reference,text' ||
                    typeof fact.reference !== 'string' ||
                    !fact.reference.trim() ||
                    fact.reference.length > 200 ||
                    typeof fact.text !== 'string' ||
                    !fact.text.trim() ||
                    fact.text.length > 1000 ||
                    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(
                      fact.text,
                    ),
                )
              )
                throw Object.assign(
                  new Error(
                    'Use one to four public facts with unique references and text of at most 1000 characters.',
                  ),
                  { local: true },
                );
              if (
                new Set(publicFacts.map((fact) => fact.reference)).size !==
                publicFacts.length
              )
                throw Object.assign(
                  new Error('Each public fact needs a unique reference.'),
                  { local: true },
                );
              Object.assign(body, {
                releaseRef: required(
                  mappingFields.releaseRef.value,
                  'the current release reference',
                ),
                issueState: required(
                  mappingFields.issueState.value,
                  'the issue state',
                ),
                deploymentState: required(
                  mappingFields.deploymentState.value,
                  'the deployment state',
                ),
                fixedProduct: {
                  productId: required(
                    mappingFields.productId.value,
                    'the product ID',
                  ),
                  version: required(
                    mappingFields.version.value,
                    'the fixed version',
                  ),
                  buildId: required(
                    mappingFields.buildId.value,
                    'the fixed build ID',
                  ),
                },
                deploymentId: required(
                  mappingFields.deploymentId.value,
                  'the deployment ID',
                ),
                deploymentEpoch: required(
                  mappingFields.deploymentEpoch.value,
                  'the deployment epoch',
                ),
                scopeRef: required(
                  mappingFields.scopeRef.value,
                  'the deployment scope',
                ),
                verificationReference: required(
                  mappingFields.verificationReference.value,
                  'the verification reference',
                ),
                publicFacts,
              });
            }
          } else if (action === 'observe')
            body = {
              commandId: id,
              repositoryId: required(
                repository.value,
                'the accepted repository ID',
              ),
              issueId: required(issue.value, 'the accepted issue ID'),
              inputReference: required(
                reference.value,
                'the trusted input reference',
              ),
            };
          else {
            if (work === null || work.workId !== workId.value.trim())
              throw new Error('read_current_work_first');
            body = {
              commandId: id,
              workId: work.workId,
              expectedWorkGeneration: work.workGeneration,
            };
            if (action === 'post')
              Object.assign(body, {
                expectedTicketRevision: work.acceptedTicketRevision,
                bundleHash: work.prepared?.bundleHash,
                messageId: commandId(),
              });
            else if (action === 'reject')
              Object.assign(body, {
                bundleHash: work.prepared?.bundleHash,
                reason: required(reason.value, 'a rejection reason'),
              });
            else if (action === 'abandon')
              body.reason = required(reason.value, 'a hold reason');
            else if (action === 'reassess' && content.value.trim() !== '')
              body.content = JSON.parse(content.value);
          }
          owner = Object.freeze({
            actorSubject: selected.actorSubject,
            ticketId: selected.ticketId,
            operation: action,
            body: JSON.stringify(body),
            ...body,
          });
          ownerState = { sent: false, uncertain: false, rejected: false };
          notify();
        }
        const packet = owner;
        if (packet.operation === 'retest-receipt') {
          const sendPreparation = async () => {
            const init = {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'X-Pegma-CSRF': session.csrfToken,
              },
              body: packet.body,
            };
            return ownedRequest(
              async () =>
                options.requestWithStatus
                  ? options.requestWithStatus(
                      path(selected, packet.operation),
                      init,
                    )
                  : {
                      status: 200,
                      body: await request(
                        path(selected, packet.operation),
                        init,
                      ),
                    },
              async (response) => {
                ensure(token, selected);
                const closing = await readSession();
                ensure(token, selected);
                if (
                  !sameSession(session, closing) ||
                  response.body?.csrfToken !== closing.csrfToken
                )
                  throw new Error('unconfirmed_preparation_session');
                return preparationResult(
                  response.status,
                  response.body?.result,
                  packet,
                );
              },
            );
          };
          let result = await sendPreparation();
          if (result.pending) {
            session = await authority(token, selected);
            result = await sendPreparation();
          }
          if (result.pending) {
            status.textContent =
              'Report association is pending. No retest result has been recorded. Retry the exact preparation.';
            return;
          }
          const id = commandId();
          const body = {
            commandId: id,
            workId: packet.workId,
            retestRequestId: packet.retestRequestId,
            receiptReference: result.receipt,
          };
          owner = Object.freeze({
            actorSubject: packet.actorSubject,
            ticketId: packet.ticketId,
            operation: 'retest',
            preparation: packet,
            body: JSON.stringify(body),
            ...body,
          });
          ownerState = { sent: false, uncertain: false, rejected: false };
          notify();
          clearPrivate();
          status.textContent =
            'Report associated. No retest result has been recorded. Choose Record the prepared retest result.';
          return;
        }
        const value = await ownedRequest(
          () =>
            request(path(selected, packet.operation), {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'X-Pegma-CSRF': session.csrfToken,
              },
              body: packet.body,
            }),
          async (response) => {
            ensure(token, selected);
            const closing = await readSession();
            ensure(token, selected);
            if (
              !sameSession(session, closing) ||
              response?.csrfToken !== closing.csrfToken ||
              !ack(response, packet)
            )
              throw new Error('unconfirmed_exact_command');
            return response;
          },
        );
        owner = null;
        ownerState = null;
        notify();
        clearPrivate();
        status.textContent =
          packet.operation === 'retest'
            ? value.result.outcome === 'held'
              ? 'Retest result held. No new result was recorded.'
              : 'Retest ' + value.result.result + ' result acknowledged.'
            : 'The exact command was acknowledged. Reloading current ticket state.';
        await options.onSettled?.();
        if (
          packet.operation === 'retest' &&
          context?.ticketId === packet.ticketId &&
          context?.actorSubject === packet.actorSubject
        )
          status.textContent =
            value.result.outcome === 'held'
              ? 'Retest result held. No new result was recorded.'
              : 'Retest ' + value.result.result + ' result acknowledged.';
      } catch (error) {
        if (epoch !== token) return;
        if (error.local === true && owner === null) {
          status.textContent = error.message;
          return;
        }
        clearPrivate();
        if (error.status === 429 && !(terminalPreparationRefusal(error) && canDiscard()))
          retryAt = Math.max(retryAt, error.retryAt ?? now() + 30_000);
        status.textContent =
          owner === null
            ? 'Follow-up is unavailable. Check current access and retry the read.'
            : canDiscard()
              ? 'The command was rejected. Discard it locally, then reload current follow-up state.'
              : 'The original command may have completed. Restore current access, then retry its exact packet.';
        if ([401, 403].includes(error.status)) {
          suspend();
          options.onAccessLost?.({ status: error.status });
        }
      } finally {
        busy = false;
        options.onBusyChange?.(false);
        render();
      }
    }
    render();
    return Object.freeze({
      showTicket(value) {
        ++epoch;
        clearPrivate();
        cursor = null;
        context = Object.freeze({
          ticketId: value.ticketId,
          actorSubject: value.actorSubject,
        });
        if (
          owner !== null &&
          (owner.ticketId !== context.ticketId ||
            owner.actorSubject !== context.actorSubject)
        )
          status.textContent =
            'Return to the original account and ticket to recover its pending command.';
        else
          status.textContent =
            owner === null
              ? 'Check the optional release-follow-up controls.'
              : canDiscard()
                ? 'The original command is unsent or rejected. Discard it locally to reload current follow-up state.'
                : 'Current ticket loaded. Retry the exact previous command.';
        root.hidden = false;
        render();
      },
      suspend,
      hasPending: () => owner !== null,
      perform,
    });
  }
  global.PegmaSupportFollowup = Object.freeze({ createPanel });
})(globalThis);
