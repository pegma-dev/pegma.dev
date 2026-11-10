const select = (selector) => document.querySelector(selector);
const statusNode = select('#staff-ticket-status');
const signedOut = select('#staff-ticket-signed-out');
const signInLinks = [...signedOut.querySelectorAll('a')].map((node) => ({
  node, target: node.target ?? '', rel: node.rel ?? '',
}));
const forbidden = select('#staff-ticket-forbidden');
const detail = select('#staff-ticket-detail');
const heading = select('#staff-ticket-heading');
const meta = select('#staff-ticket-meta');
const requesterNode = select('#staff-ticket-requester');
const messageList = select('#staff-message-list');
const composeForm = select('#staff-compose-form');
const composeBody = select('#compose-body');
const composeSubmit = select('#compose-submit');
const prioritySelect = select('#priority-select');
const takeoverButton = select('#action-take-over');
const handlingNode = select('#staff-ticket-handling');
const handoffPanel = select('#staff-handoff');
const handoffStatus = select('#staff-handoff-status');
const handoffList = select('#staff-handoff-list');
const learningRoot = select('#staff-learning-panel');
const ticketId = new URL(window.location.href).searchParams.get('id') ?? '';
let learning = null;
let learningRequests = 0;
let csrfToken = '';
let viewer = null;
let authorityReloadRequired = false;
let currentView = null;
let readGeneration = 0;
let handoffGeneration = 0;
let busy = null;
let takeoverPacket = null;
let ordinaryPacket = null;
let ordinaryAcknowledged = false;
let retryAt = 0;
let retryTimer = null;
let retryNotice = null;
let suspended = false;
const requests = new Set();
const requestTimeoutMs = 15_000;

function paintStatus(message, error = false) {
  statusNode.textContent = message;
  statusNode.dataset.tone = error ? 'error' : 'neutral';
}
function showStatus(message, error = false) {
  retryNotice = null;
  paintStatus(message, error);
}
function onThisTicket() {
  return new URL(window.location.href).searchParams.get('id') === ticketId;
}
function isCurrent(generation) {
  return generation === readGeneration && onThisTicket() && !suspended;
}
function guard(generation) {
  if (!isCurrent(generation))
    throw Object.assign(new Error('stale_view'), { stale: true });
}
function cancelRequests() {
  for (const controller of requests) controller.abort();
  requests.clear();
}
function beginOperation() {
  suspended = false;
  const operation = { generation: ++readGeneration };
  cancelRequests();
  busy = operation;
  return operation;
}
function finishOperation(operation) {
  if (busy === operation) {
    busy = null;
    updateControls();
  }
}
function clearHandoff() {
  ++handoffGeneration;
  handoffList.replaceChildren();
  handoffStatus.textContent = '';
  handoffPanel.hidden = true;
}
function hideAll() {
  learning?.suspend();
  if (learningRoot !== null) learningRoot.hidden = true;
  currentView = null;
  signedOut.hidden = true;
  forbidden.hidden = true;
  detail.hidden = true;
  heading.textContent = 'Staff ticket';
  meta.textContent = '';
  requesterNode.textContent = '';
  handlingNode.textContent = '';
  messageList.replaceChildren();
  clearHandoff();
  updateControls();
  // Compose text and its selected public/internal mode are unsent local drafts.
}
function invalidate() {
  ++readGeneration;
  suspended = true;
  cancelRequests();
  busy = null;
  viewer = null;
  csrfToken = '';
  if (!onThisTicket()) takeoverPacket = null;
  if (retryTimer !== null) clearTimeout(retryTimer);
  retryTimer = null;
  hideAll();
  showStatus(
    onThisTicket()
      ? 'Ticket view cleared. Reload to check current access and state.'
      : 'The ticket address changed. Reload this page to open it.',
  );
}
function effectiveHandling(ticket) {
  const handling = ticket.handling ?? { state: 'human-pending', generation: 0 };
  if (
    !['assistant', 'human-pending', 'human-active'].includes(handling.state) ||
    !Number.isSafeInteger(handling.generation) ||
    handling.generation < 0
  )
    throw Object.assign(new Error('invalid_response'), { status: 502 });
  return handling;
}
function selectedComposeMode() {
  return (
    composeForm.querySelector('input[name="composeMode"]:checked')?.value ?? ''
  );
}
function updateControls() {
  composeForm.noValidate = ordinaryPacket !== null && ordinaryPacket.kind !== 'patch';
  for (const link of signInLinks) {
    link.node.target = ordinaryPacket === null && !learningPending() ? link.target : '_blank';
    link.node.rel = ordinaryPacket === null && !learningPending() ? link.rel : 'noopener noreferrer';
  }
  const ticket = currentView?.ticket;
  const terminal = ticket?.status === 'resolved' || ticket?.status === 'closed';
  const state = ticket === undefined ? '' : effectiveHandling(ticket).state;
  const seconds = retrySeconds();
  const blocked =
    learningOccupied() ||
    busy !== null ||
    viewer === null ||
    authorityReloadRequired ||
    suspended ||
    seconds > 0;
  takeoverButton.textContent =
    seconds > 0
      ? `Retry take over in ${seconds}s`
      : takeoverPacket === null
        ? 'Take over'
        : 'Retry take over';
  takeoverButton.disabled =
    blocked ||
    ordinaryPacket !== null ||
    (takeoverPacket === null &&
      (ticket === undefined || terminal || state === 'human-active'));
  const ordinaryBlocked =
    blocked || ticket === undefined || takeoverPacket !== null;
  for (const button of select('#staff-lifecycle').querySelectorAll('button'))
    if (button !== takeoverButton)
      button.disabled =
        ordinaryBlocked ||
        ordinaryAcknowledged ||
        (ordinaryPacket !== null &&
          (ordinaryPacket.kind !== 'patch' ||
            button !== select(ordinaryPacket.button)));
  prioritySelect.disabled = ordinaryBlocked || ordinaryPacket !== null;
  composeSubmit.textContent =
    ordinaryPacket?.kind === 'public'
      ? 'Retry previous public reply'
      : ordinaryPacket?.kind === 'internal'
        ? 'Retry previous internal note'
        : 'Send';
  composeSubmit.disabled =
    ordinaryBlocked ||
    ordinaryAcknowledged ||
    ordinaryPacket?.kind === 'patch' ||
    (ordinaryPacket === null &&
      (!['public', 'internal'].includes(selectedComposeMode()) ||
        composeBody.value.trim() === ''));
  composeForm.dataset.mode = selectedComposeMode() || 'unset';
  armRetryTimer();
}
function retrySeconds() {
  return Math.max(0, Math.ceil((retryAt - Date.now()) / 1000));
}
function paintRetryNotice() {
  if (retryNotice === null) return;
  const seconds = retrySeconds();
  paintStatus(
    seconds > 0
      ? `${retryNotice} Wait at least ${seconds} seconds before retrying.`
      : `${retryNotice} The retry delay has elapsed; you can retry the same request.`,
    true,
  );
  if (seconds === 0) retryNotice = null;
}
function armRetryTimer() {
  if (suspended || retryTimer !== null || retrySeconds() === 0) return;
  retryTimer = setTimeout(
    () => {
      retryTimer = null;
      paintRetryNotice();
      updateControls();
    },
    Math.min(1000, Math.max(1, retryAt - Date.now())),
  );
}
function retryDeadline(value) {
  if (value !== null) {
    const trimmed = value.trim();
    const now = Date.now();
    const seconds = /^\d+$/u.test(trimmed) ? Number(trimmed) : null;
    const deadline =
      seconds === null ? Date.parse(trimmed) : now + seconds * 1000;
    if (Number.isSafeInteger(deadline)) return Math.max(now, deadline);
  }
  // A missing or malformed server hint never triggers a tight retry loop.
  return Date.now() + 30_000;
}
async function api(path, init = {}) {
  const headers = new Headers(init.headers);
  if (init.body !== undefined) headers.set('Content-Type', 'application/json');
  if (csrfToken !== '') headers.set('X-Pegma-CSRF', csrfToken);
  const controller = new AbortController();
  requests.add(controller);
  let timedOut = false;
  let rejectAbort;
  const aborted = new Promise((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () =>
    rejectAbort(
      Object.assign(
        new Error(timedOut ? 'request_timeout' : 'request_aborted'),
        { timedOut },
      ),
    );
  controller.signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, requestTimeoutMs);
  try {
    return await Promise.race([
      (async () => {
        const response = await fetch(path, {
          ...init,
          headers,
          signal: controller.signal,
          credentials: 'same-origin',
          cache: 'no-store',
          referrerPolicy: 'no-referrer',
        });
        if (!response.ok)
          throw Object.assign(new Error('request_failed'), {
            status: response.status,
            ...(response.status === 429
              ? { retryAt: retryDeadline(response.headers.get('Retry-After')) }
              : {}),
          });
        return await response.json();
      })(),
      aborted,
    ]);
  } finally {
    clearTimeout(timer);
    controller.signal.removeEventListener('abort', onAbort);
    requests.delete(controller);
  }
}
async function readViewer(generation, expected = viewer) {
  const result = await api('/api/identity/session');
  guard(generation);
  if (
    typeof result.account?.subject !== 'string' ||
    typeof result.csrfToken !== 'string' ||
    result.csrfToken === ''
  )
    throw Object.assign(new Error('invalid_response'), { status: 502 });
  const next = Object.freeze({
    subject: result.account.subject,
    csrfToken: result.csrfToken,
  });
  // An unresolved command belongs to its original principal, not old credentials.
  if (takeoverPacket !== null && next.subject !== takeoverPacket.subject) {
    takeoverPacket = null;
    throw Object.assign(new Error('session_changed'), { status: 401 });
  }
  if (ordinaryPacket !== null && next.subject !== ordinaryPacket.subject)
    // Retain the original owner's unknown intent without exposing it here.
    throw Object.assign(new Error('session_changed'), { status: 401 });
  if (
    expected !== null &&
    (next.subject !== expected.subject || next.csrfToken !== expected.csrfToken)
  )
    throw Object.assign(new Error('session_changed'), { status: 401 });
  viewer = next;
  csrfToken = next.csrfToken;
  return next;
}
function validateView(view) {
  if (
    view?.ticket?.id !== ticketId ||
    !Number.isSafeInteger(view.ticket.revision) ||
    view.ticket.revision < 1 ||
    !Array.isArray(view.messages) ||
    view.messages.some((message) => message.ticketId !== ticketId) ||
    view.csrfToken !== viewer?.csrfToken
  )
    throw Object.assign(new Error('invalid_response'), { status: 502 });
  if (view.learningEnabled !== undefined && typeof view.learningEnabled !== 'boolean')
    throw Object.assign(new Error('invalid_response'), { status: 502 });
  effectiveHandling(view.ticket);
  return view;
}
function authorLabel(message) {
  if (message.visibility === 'internal') return 'Internal note';
  if (message.authorKind === 'customer') return 'Customer';
  if (message.authorKind === 'staff') return 'Staff (public)';
  if (message.authorKind === 'assistant') return 'Assistant';
  return 'System';
}
function renderTicket(view) {
  validateView(view);
  clearHandoff();
  currentView = view;
  const ticket = view.ticket;
  const handling = effectiveHandling(ticket);
  heading.textContent = `${ticket.marker ?? `[PEG-${ticket.number}]`} ${ticket.subject}`;
  meta.textContent = [
    ticket.status,
    ticket.priority,
    ticket.category ?? 'uncategorized',
    ticket.channel,
    `rev ${ticket.revision}`,
    ticket.assignedTo ? `assigned:${ticket.assignedTo}` : 'unassigned',
  ].join(' · ');
  const requester = ticket.requester ?? {};
  requesterNode.textContent = [
    `association: ${requester.association ?? 'unknown'}`,
    ...(typeof requester.email === 'string'
      ? [`email: ${requester.email}`]
      : []),
    ...(typeof requester.principalId === 'string'
      ? [`principal: ${requester.principalId}`]
      : []),
  ].join(' · ');
  handlingNode.textContent =
    ticket.status === 'closed' || ticket.status === 'resolved'
      ? 'Reopen this ticket before taking over.'
      : handling.state === 'human-active'
        ? 'Human support is active.'
        : handling.state === 'assistant'
          ? 'Assistant handling; take over to begin human handling.'
          : 'Waiting for human support.';
  prioritySelect.value = ticket.priority;
  messageList.replaceChildren();
  for (const message of view.messages) {
    const item = document.createElement('li');
    item.className =
      message.visibility === 'internal'
        ? 'staff-message-internal'
        : message.authorKind === 'staff'
          ? 'staff-message-public-staff'
          : message.authorKind === 'customer'
            ? 'staff-message-customer'
            : '';
    const who = document.createElement('strong');
    who.textContent = authorLabel(message);
    const when = document.createElement('span');
    when.className = 'form-note';
    when.textContent = new Date(message.createdAt).toLocaleString();
    const body = document.createElement('p');
    body.textContent = message.body;
    item.append(who, ' · ', when, body);
    messageList.append(item);
  }
  signedOut.hidden = true;
  forbidden.hidden = true;
  detail.hidden = false;
  syncLearning(view);
  updateControls();
}
function failure(error, action, generation) {
  if (!isCurrent(generation) || error.stale) return;
  // A failed/unknown mutation is not a fresh basis for another staff write.
  hideAll();
  if ([400, 404].includes(error.status)) takeoverPacket = null;
  if (
    error.status === 401 || error.status === 403 ||
    (error.status === 404 && ordinaryPacket !== null)
  ) {
    // A denied ACK may follow a real commit. Retain exact JSON for its owner,
    // including a not-found read under raced cookies. Neither 404 nor GET can
    // settle it; require a complete fresh owner read before another write.
    authorityReloadRequired = true;
    viewer = null;
    csrfToken = '';
  }
  signedOut.hidden = error.status !== 401;
  forbidden.hidden = error.status !== 403;
  if (error.status === 429) {
    retryAt = Math.max(retryAt, error.retryAt);
    retryNotice = `${action} was rate limited.`;
    paintRetryNotice();
  } else
    showStatus(
      error.status === 401
        ? ordinaryPacket !== null || learningPending()
          ? 'Sign in to the original account in another tab, then return here and reload this ticket. The action already sent may have completed.'
          : 'Sign in, then reload this ticket. Any request already sent may have completed.'
        : error.status === 403
          ? 'Current staff access could not be confirmed. Any request already sent may have completed.'
          : error.status === 404
            ? 'Ticket not found.'
            : `Could not confirm the ${action.toLowerCase()} result${error.timedOut ? ' before the request deadline' : ''}. ${action === 'Take over' && takeoverPacket !== null ? 'Reload or retry the same take-over request.' : ordinaryPacket !== null ? 'Reload, then retry the same action. Your current draft is kept.' : 'Reload the ticket before another action.'}`,
      error.status !== 401,
    );
  updateControls();
}
function validateHandoff(result) {
  if (
    !Array.isArray(result.handoff) ||
    result.csrfToken !== viewer?.csrfToken ||
    result.handoff.some(
      (work) =>
        work.ticketId !== ticketId ||
        typeof work.workId !== 'string' ||
        typeof work.reason !== 'string' ||
        work.status !== 'pending' ||
        (work.summary !== undefined && typeof work.summary !== 'string') ||
        !Array.isArray(work.attemptedGuideIds) ||
        work.attemptedGuideIds.some((id) => typeof id !== 'string') ||
        work.transcript?.ticketId !== ticketId ||
        !Number.isSafeInteger(work.transcript.throughRevision) ||
        work.transcript.throughRevision < 1 ||
        typeof work.transcript.lastVisibleMessageId !== 'string' ||
        !Number.isSafeInteger(work.handlingGeneration) ||
        work.handlingGeneration < 0 ||
        typeof work.createdAt !== 'string',
    )
  )
    throw Object.assign(new Error('invalid_response'), { status: 502 });
}
async function loadHandoff() {
  if (currentView === null || !onThisTicket()) return;
  const generation = readGeneration;
  clearHandoff();
  const handoffRead = handoffGeneration;
  handoffPanel.hidden = false;
  handoffStatus.textContent = 'Loading private handoff…';
  try {
    await readViewer(generation);
    if (handoffRead !== handoffGeneration) return;
    const result = await api(
      `/api/support/admin/tickets/${encodeURIComponent(ticketId)}/handoff`,
    );
    guard(generation);
    if (handoffRead !== handoffGeneration) return;
    validateHandoff(result);
    await readViewer(generation);
    if (handoffRead !== handoffGeneration) return;
    for (const work of result.handoff) {
      const item = document.createElement('li');
      const reason = document.createElement('strong');
      reason.textContent = `${work.reason} · ${work.status}`;
      const summary = document.createElement('p');
      summary.textContent = work.summary ?? 'No additional summary.';
      const guides = document.createElement('p');
      guides.textContent = `Attempted guide references: ${work.attemptedGuideIds.join(', ') || 'None'}`;
      const transcript = document.createElement('p');
      transcript.textContent = `Through revision ${work.transcript.throughRevision}; last visible message ${work.transcript.lastVisibleMessageId}`;
      item.append(reason, summary, guides, transcript);
      handoffList.append(item);
    }
    handoffStatus.textContent =
      result.handoff.length === 0
        ? 'No handoff records for this ticket.'
        : 'Private handoff loaded.';
  } catch (error) {
    if (generation !== readGeneration || handoffRead !== handoffGeneration)
      return;
    clearHandoff();
    if ([401, 403, 404].includes(error.status) || error.stale)
      failure(error, 'Private handoff read', generation);
    else {
      handoffPanel.hidden = false;
      handoffStatus.textContent =
        'Private handoff is unavailable. Retry the read.';
    }
  }
}
async function loadTicket() {
  const operation = beginOperation();
  const generation = operation.generation;
  hideAll();
  if (ticketId === '' || !onThisTicket()) {
    showStatus('Missing or changed ticket id. Reload this page.', true);
    finishOperation(operation);
    return { generation, loaded: false };
  }
  select('#staff-ticket-id-display').textContent = ticketId;
  showStatus('Loading ticket…');
  try {
    // A new read may use current credentials for the retained packet owner.
    await readViewer(generation, null);
    const view = await api(
      `/api/support/admin/tickets/${encodeURIComponent(ticketId)}`,
    );
    guard(generation);
    validateView(view);
    await readViewer(generation);
    authorityReloadRequired = false;
    if (ordinaryPacket !== null && ordinaryAcknowledged) {
      if (
        ordinaryPacket.kind !== 'patch' &&
        composeBody.value.trim() === ordinaryPacket.draft &&
        selectedComposeMode() === ordinaryPacket.kind
      )
        composeForm.reset();
      ordinaryPacket = null;
      ordinaryAcknowledged = false;
    }
    renderTicket(view);
    showStatus('Ticket loaded.');
    // Private handoff availability does not lock a fully refreshed ticket view.
    finishOperation(operation);
    await loadHandoff();
    return {
      generation,
      loaded: isCurrent(generation) && currentView !== null,
    };
  } catch (error) {
    failure(error, 'Ticket read', generation);
    return { generation, loaded: false };
  } finally {
    finishOperation(operation);
  }
}
function commandIdentity(includeMessage = false) {
  if (viewer === null) return null;
  const expectedAccountId = viewer.subject;
  const commandId = `${expectedAccountId}~${crypto.randomUUID()}`;
  const messageId = includeMessage
    ? `${expectedAccountId}~${crypto.randomUUID()}`
    : null;
  if (
    ![commandId, ...(messageId === null ? [] : [messageId])].every((id) =>
      /^[A-Za-z0-9._~-]{1,128}$/u.test(id),
    )
  ) {
    showStatus('Could not prepare a retry-safe action for this account.', true);
    return null;
  }
  return Object.freeze({
    version: 1,
    expectedAccountId,
    commandId,
    ...(messageId === null ? {} : { messageId }),
  });
}
async function sendOrdinaryPacket(packet, label) {
  const expectedViewer = viewer;
  const operation = beginOperation();
  const generation = operation.generation;
  clearHandoff();
  updateControls();
  try {
    await readViewer(generation, expectedViewer);
    const ack = await api(packet.path, {
      method: packet.method,
      headers: packet.headers,
      body: packet.body,
    });
    guard(generation);
    validateView(ack);
    await readViewer(generation, expectedViewer);
    ordinaryAcknowledged = true;
    // A historical receipt is not a current view. An arbitrary earlier GET
    // cannot settle an unknown write; this read follows its confirmed ACK.
    const refreshed = await loadTicket();
    if (isCurrent(refreshed.generation))
      showStatus(
        refreshed.loaded
          ? packet.kind === 'patch'
            ? `Action ${packet.action} applied.`
            : packet.kind === 'public'
              ? 'Public reply sent.'
              : 'Internal note saved.'
          : `${label} accepted. Current ticket refresh failed; reload before another action.`,
        !refreshed.loaded,
      );
  } catch (error) {
    failure(error, label, generation);
  } finally {
    finishOperation(operation);
  }
}
async function patchTicket(action, extra = {}) {
  if (
    learningOccupied() ||
    busy !== null ||
    retrySeconds() > 0 ||
    suspended ||
    authorityReloadRequired ||
    takeoverPacket !== null ||
    ordinaryAcknowledged ||
    viewer === null ||
    currentView === null ||
    !onThisTicket() ||
    (ordinaryPacket !== null &&
      (ordinaryPacket.kind !== 'patch' || ordinaryPacket.action !== action))
  )
    return;
  if (ordinaryPacket === null) {
    const command = commandIdentity();
    if (command === null) return;
    ordinaryPacket = Object.freeze({
      subject: viewer.subject,
      kind: 'patch',
      action,
      button: action === 'change_priority' ? '#action-priority' : `#action-${action}`,
      path: `/api/support/admin/tickets/${encodeURIComponent(ticketId)}`,
      method: 'PATCH',
      headers: Object.freeze({ 'X-Pegma-Support-Command': '1' }),
      body: JSON.stringify({ action, ...extra, command }),
    });
  }
  await sendOrdinaryPacket(ordinaryPacket, `Action ${ordinaryPacket.action}`);
}
takeoverButton.addEventListener('click', async () => {
  if (
    learningOccupied() ||
    busy !== null ||
    retrySeconds() > 0 ||
    suspended ||
    authorityReloadRequired ||
    ordinaryPacket !== null ||
    viewer === null ||
    !onThisTicket()
  )
    return;
  if (takeoverPacket === null) {
    if (
      currentView === null ||
      ['resolved', 'closed'].includes(currentView.ticket.status)
    )
      return;
    const handling = effectiveHandling(currentView.ticket);
    if (handling.state === 'human-active') return;
    takeoverPacket = Object.freeze({
      subject: viewer.subject,
      body: JSON.stringify(
        Object.freeze({
          commandId: crypto.randomUUID(),
          expectedRevision: currentView.ticket.revision,
          expectedHandlingGeneration: handling.generation,
        }),
      ),
    });
  }
  const packet = takeoverPacket;
  const expectedViewer = viewer;
  const operation = beginOperation();
  const generation = operation.generation;
  clearHandoff();
  updateControls();
  try {
    await readViewer(generation, expectedViewer);
    const ack = await api(
      `/api/support/admin/tickets/${encodeURIComponent(ticketId)}/take-over`,
      { method: 'POST', body: packet.body },
    );
    guard(generation);
    validateView(ack);
    await readViewer(generation, expectedViewer);
    takeoverPacket = null;
    // Exact SDK replay can acknowledge a historical view. Always read current state.
    const refreshed = await loadTicket();
    if (isCurrent(refreshed.generation))
      showStatus(
        refreshed.loaded
          ? 'Take over accepted. Assignment is unchanged.'
          : 'Take over accepted. Current ticket refresh failed; reload before another action.',
        !refreshed.loaded,
      );
  } catch (error) {
    if (!isCurrent(generation) || error.stale) return;
    if (error.status === 409) {
      takeoverPacket = null;
      const refreshed = await loadTicket();
      if (refreshed.loaded && isCurrent(refreshed.generation))
        showStatus(
          'The ticket changed. Review it before choosing Take over again.',
          true,
        );
    } else failure(error, 'Take over', generation);
  } finally {
    finishOperation(operation);
  }
});
for (const action of ['assign', 'unassign', 'resolve', 'close', 'reopen'])
  select(`#action-${action}`).addEventListener('click', () => {
    void patchTicket(action);
  });
select('#action-priority').addEventListener('click', () => {
  void patchTicket('change_priority', { priority: prioritySelect.value });
});
composeForm.addEventListener('change', updateControls);
composeForm.addEventListener('input', updateControls);
composeForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const mode = selectedComposeMode();
  const body = composeBody.value.trim();
  if (
    learningOccupied() ||
    busy !== null ||
    retrySeconds() > 0 ||
    suspended ||
    authorityReloadRequired ||
    takeoverPacket !== null ||
    ordinaryAcknowledged ||
    viewer === null ||
    currentView === null ||
    !onThisTicket() ||
    ordinaryPacket?.kind === 'patch' ||
    (ordinaryPacket === null &&
      (!body || !['public', 'internal'].includes(mode)))
  )
    return;
  if (ordinaryPacket === null) {
    if (
      body.length > 20_000 ||
      /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u.test(body)
    ) {
      showStatus('Check the message. Remove unsupported control characters and stay within the field limit.', true);
      return;
    }
    const command = commandIdentity(true);
    if (command === null) return;
    const suffix = mode === 'public' ? 'messages' : 'notes';
    ordinaryPacket = Object.freeze({
      subject: viewer.subject,
      kind: mode,
      path: `/api/support/admin/tickets/${encodeURIComponent(ticketId)}/${suffix}`,
      method: 'POST',
      headers: Object.freeze({ 'X-Pegma-Support-Command': '1' }),
      body: JSON.stringify({ body, command }),
      draft: body,
    });
  }
  await sendOrdinaryPacket(
    ordinaryPacket,
    ordinaryPacket.kind === 'public' ? 'Public reply' : 'Internal note',
  );
});
select('#staff-ticket-reload').addEventListener('click', () => {
  if (!onThisTicket() && learningPending()) {
    invalidate();
    showStatus('Return to the original ticket address before reloading. An earlier learning action may have completed.', true);
  } else if (!onThisTicket()) window.location.reload();
  else void loadTicket();
});
select('#staff-handoff-reload').addEventListener('click', () => {
  void loadHandoff();
});
function learningPending() {
  return learning?.hasPending() === true;
}
function learningOccupied() {
  return learningRequests > 0 || learningPending();
}
async function learningRequest(run) {
  ++learningRequests;
  updateControls();
  try { return await run(); }
  finally { --learningRequests; updateControls(); }
}
function syncLearning(view) {
  if (learning === null || learningRoot === null) return;
  if (view.learningEnabled !== true || ordinaryPacket !== null || takeoverPacket !== null) {
    learning.suspend();
    learningRoot.hidden = true;
    return;
  }
  learningRoot.hidden = false;
  void learning.showTicket({ ticketId: view.ticket.id, revision: view.ticket.revision,
    actorSubject: viewer.subject, status: view.ticket.status, resolvedAt: view.ticket.resolvedAt });
}
if (learningRoot !== null && typeof globalThis.PegmaSupportLearning?.createPanel === 'function') {
  // One closure owns all unresolved packets for the lifetime of this staff page.
  learning = globalThis.PegmaSupportLearning.createPanel({
    root: learningRoot,
    request: (path, init) => learningRequest(() => api(path, init)),
    readSession: () => learningRequest(async () => {
      const generation = readGeneration;
      const current = await readViewer(generation);
      guard(generation);
      return current;
    }),
    onPendingChange: () => updateControls(),
    onAccessLost: ({ status }) => {
      // Fence concurrent handoff/detail reads as well as the learning closure.
      ++readGeneration;
      cancelRequests();
      busy = null;
      viewer = null;
      csrfToken = '';
      authorityReloadRequired = true;
      hideAll();
      signedOut.hidden = status !== 401;
      forbidden.hidden = status !== 403;
      showStatus(status === 401 && learningPending()
        ? 'Sign in to the original account in another tab, then reload this ticket. The learning action may have completed.'
        : 'Current access could not be confirmed. Reload this ticket to check access again.', true);
      updateControls();
    },
  });
}
window.addEventListener('beforeunload', (event) => {
  if (!learningPending()) return;
  event.preventDefault();
  event.returnValue = '';
});
window.addEventListener('pagehide', invalidate);
window.addEventListener('popstate', invalidate);
window.addEventListener('pageshow', () => {
  if (suspended && onThisTicket()) void loadTicket();
});
updateControls();
void loadTicket();
