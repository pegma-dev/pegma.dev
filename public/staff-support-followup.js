(function (global) {
  'use strict';
  const sameSession = (a, b) =>
    a?.subject === b?.subject && a?.csrfToken === b?.csrfToken;
  function createPanel(options) {
    const { root, request, readSession, readCurrentTicket } = options;
    let context = null;
    let work = null;
    let owner = null;
    let epoch = 0;
    let busy = false;
    let retryAt = 0;
    let timer = null;
    let cursor = null;
    let associations = [];
    let mappingView = null;
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
      labelled('Public facts JSON: one to four unique {reference,text} entries', facts),
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
    add('exact-retry', 'Retry the exact previous command');
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
          (action === 'exact-retry' ? !owns : owner !== null) ||
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
    function clearPrivate() {
      work = null;
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
        (action !== 'exact-retry' ||
          owner.actorSubject !== selected.actorSubject ||
          owner.ticketId !== selected.ticketId)
      )
        return;
      busy = true;
      options.onBusyChange?.(true);
      render();
      try {
        const session = await authority(token, selected);
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
          if (action === 'verify-mapping' || action === 'withdraw-mapping') {
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
              if (new Set(publicFacts.map((fact) => fact.reference)).size !== publicFacts.length)
                throw Object.assign(new Error('Each public fact needs a unique reference.'), {local:true});
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
          notify();
        }
        const packet = owner;
        const value = await request(path(selected, packet.operation), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Pegma-CSRF': session.csrfToken,
          },
          body: packet.body,
        });
        ensure(token, selected);
        const closing = await readSession();
        ensure(token, selected);
        if (
          !sameSession(session, closing) ||
          value?.csrfToken !== closing.csrfToken ||
          !ack(value, packet)
        )
          throw new Error('unconfirmed_exact_command');
        owner = null;
        notify();
        clearPrivate();
        status.textContent =
          'The exact command was acknowledged. Reloading current ticket state.';
        await options.onSettled?.();
      } catch (error) {
        if (epoch !== token) return;
        if (error.local === true && owner === null) {
          status.textContent = error.message;
          return;
        }
        clearPrivate();
        if (error.status === 429)
          retryAt = Math.max(retryAt, error.retryAt ?? now() + 30_000);
        status.textContent =
          owner === null
            ? 'Follow-up is unavailable. Check current access and retry the read.'
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
