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
    const now = options.now ?? Date.now;
    const commandId = options.commandId ?? (() => global.crypto.randomUUID());
    const create = (tag, text) => {
      const node = document.createElement(tag);
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
          if (action === 'observe')
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
