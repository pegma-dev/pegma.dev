const select = (selector) => document.querySelector(selector);
const statusNode = select('#ticket-status');
const signedOut = select('#ticket-signed-out');
const detail = select('#ticket-detail');
const heading = select('#ticket-heading');
const meta = select('#ticket-meta');
const messageList = select('#message-list');
const replyForm = select('#reply-form');
const humanControls = select('#ticket-human-controls');
const humanStatus = select('#ticket-human-status');
const personButton = select('#request-person');
const ticketId = new URL(window.location.href).searchParams.get('id') ?? '';
let csrfToken = '';
let viewer = null;
let authorityReloadRequired = false;
let currentView = null;
let readGeneration = 0;
let busy = null;
let personPacket = null;
let packetOutcome = 'unconfirmed';
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
    updateHumanControl();
  }
}
function clearTicket() {
  currentView = null;
  detail.hidden = true;
  heading.textContent = 'Ticket';
  meta.textContent = '';
  messageList.replaceChildren();
  humanControls.hidden = true;
  humanStatus.textContent = '';
  personButton.disabled = true;
  for (const button of replyForm.querySelectorAll('button'))
    button.disabled = true;
  // Unsent reply text stays in the form when the private view is cleared.
}
function invalidate() {
  ++readGeneration;
  suspended = true;
  cancelRequests();
  busy = null;
  viewer = null;
  csrfToken = '';
  if (!onThisTicket()) personPacket = null;
  if (retryTimer !== null) clearTimeout(retryTimer);
  retryTimer = null;
  clearTicket();
  showStatus(
    onThisTicket()
      ? 'Ticket view cleared. Reload to check current access and state.'
      : 'The ticket address changed. Reload this page to open it.',
  );
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
      updateHumanControl();
    },
    Math.min(1000, Math.max(1, retryAt - Date.now())),
  );
}
function updateHumanControl() {
  const ticket = currentView?.ticket;
  const terminal = ticket?.status === 'resolved' || ticket?.status === 'closed';
  const state = ticket?.handling;
  const seconds = retrySeconds();
  humanControls.hidden =
    viewer === null ||
    authorityReloadRequired ||
    (ticket === undefined && personPacket === null);
  humanStatus.textContent = humanControls.hidden
    ? ''
    : personPacket !== null
      ? packetOutcome === 'rate_limited'
        ? seconds > 0
          ? `The server rate limited this request. Wait at least ${seconds} seconds before retrying the same request.`
          : 'Retry the same human-support request when ready.'
        : 'The previous human-support request has no confirmed acknowledgement. Retry that same request.'
      : terminal
        ? `This ticket is ${ticket.status}. Request human support to reopen it.`
        : state === 'assistant'
          ? 'You can ask for human support at any time.'
          : state === 'human-active'
            ? 'Human support is active on this ticket.'
            : state === 'human-pending'
              ? 'This ticket is waiting for human support.'
              : 'Human support handles this ticket.';
  personButton.hidden =
    personPacket === null && !terminal && state !== 'assistant';
  personButton.disabled =
    busy !== null ||
    viewer === null ||
    authorityReloadRequired ||
    suspended ||
    seconds > 0 ||
    (ticket === undefined && personPacket === null);
  personButton.textContent =
    seconds > 0
      ? `Retry in ${seconds}s`
      : personPacket === null
        ? 'Request human support'
        : 'Retry human-support request';
  for (const button of replyForm.querySelectorAll('button'))
    button.disabled =
      busy !== null ||
      currentView === null ||
      personPacket !== null ||
      authorityReloadRequired ||
      suspended ||
      seconds > 0;
  armRetryTimer();
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
  if (personPacket !== null && next.subject !== personPacket.subject) {
    personPacket = null;
    throw Object.assign(new Error('session_changed'), { status: 401 });
  }
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
    !Array.isArray(view.messages) ||
    (view.ticket.handling !== undefined &&
      !['assistant', 'human-pending', 'human-active'].includes(
        view.ticket.handling,
      )) ||
    view.messages.some(
      (message) =>
        message.ticketId !== ticketId || message.visibility !== 'public',
    ) ||
    view.csrfToken !== viewer?.csrfToken
  )
    throw Object.assign(new Error('invalid_response'), { status: 502 });
  return view;
}
function renderTicket(view) {
  currentView = validateView(view);
  heading.textContent = `${view.ticket.marker} ${view.ticket.subject}`;
  meta.textContent = `${view.ticket.status} · ${view.ticket.category ?? 'uncategorized'}`;
  messageList.replaceChildren();
  for (const message of view.messages) {
    const item = document.createElement('li');
    const who = document.createElement('strong');
    who.textContent =
      message.authorKind === 'customer'
        ? 'You'
        : message.authorKind === 'staff'
          ? 'Pegma'
          : message.authorKind === 'assistant'
            ? 'Assistant'
            : 'System';
    const when = document.createElement('span');
    when.className = 'form-note';
    when.textContent = new Date(message.createdAt).toLocaleString();
    const body = document.createElement('p');
    body.textContent = message.body;
    item.append(who, ' · ', when, body);
    messageList.append(item);
  }
  signedOut.hidden = true;
  detail.hidden = false;
  updateHumanControl();
}
function failure(error, action, generation) {
  if (!isCurrent(generation) || error.stale) return;
  clearTicket();
  if ([400, 404].includes(error.status)) personPacket = null;
  if (error.status === 401 || error.status === 403) {
    // A denied ACK may follow a real commit. Retain exact JSON for its owner,
    // but require a complete fresh ticket read before enabling another write.
    authorityReloadRequired = true;
    viewer = null;
    csrfToken = '';
  }
  signedOut.hidden = error.status !== 401;
  if (error.status === 429) {
    retryAt = Math.max(retryAt, error.retryAt);
    if (action === 'Human-support request') packetOutcome = 'rate_limited';
    retryNotice = `${action} was rate limited.`;
    paintRetryNotice();
  } else {
    if (action === 'Human-support request') packetOutcome = 'unconfirmed';
    showStatus(
      error.status === 401
        ? 'Sign in, then reload this ticket. Any request already sent may have completed.'
        : error.status === 403
          ? 'Current account access could not be confirmed. Any request already sent may have completed.'
          : error.status === 404
            ? 'Ticket not found.'
            : `Could not confirm the ${action.toLowerCase()} result${error.timedOut ? ' before the request deadline' : ''}. ${action === 'Human-support request' && personPacket !== null ? 'Retry the same human-support request.' : 'Reload the ticket before another action.'}`,
      error.status !== 401,
    );
  }
  updateHumanControl();
}
async function loadTicket() {
  const operation = beginOperation();
  const generation = operation.generation;
  clearTicket();
  updateHumanControl();
  if (ticketId === '' || !onThisTicket()) {
    showStatus('Missing or changed ticket id. Reload this page.', true);
    finishOperation(operation);
    return { generation, loaded: false };
  }
  select('#ticket-id-display').textContent = ticketId;
  showStatus('Loading ticket…');
  try {
    await readViewer(generation);
    const view = await api(
      `/api/support/tickets/${encodeURIComponent(ticketId)}`,
    );
    guard(generation);
    validateView(view);
    await readViewer(generation);
    authorityReloadRequired = false;
    renderTicket(view);
    showStatus('Ticket loaded.');
    return { generation, loaded: true };
  } catch (error) {
    failure(error, 'Ticket read', generation);
    return { generation, loaded: false };
  } finally {
    finishOperation(operation);
  }
}
personButton.addEventListener('click', async () => {
  if (
    busy !== null ||
    retrySeconds() > 0 ||
    suspended ||
    !onThisTicket() ||
    authorityReloadRequired ||
    viewer === null
  )
    return;
  const ticket = currentView?.ticket;
  if (
    personPacket === null &&
    (!ticket ||
      (ticket.handling !== 'assistant' &&
        ticket.status !== 'resolved' &&
        ticket.status !== 'closed'))
  )
    return;
  personPacket ??= Object.freeze({
    subject: viewer.subject,
    body: JSON.stringify(Object.freeze({ commandId: crypto.randomUUID() })),
  });
  const packet = personPacket;
  const expectedViewer = viewer;
  const operation = beginOperation();
  const generation = operation.generation;
  updateHumanControl();
  try {
    await readViewer(generation, expectedViewer);
    const ack = await api(
      `/api/support/tickets/${encodeURIComponent(ticketId)}/request-person`,
      { method: 'POST', body: packet.body },
    );
    guard(generation);
    validateView(ack);
    await readViewer(generation, expectedViewer);
    personPacket = null;
    // An exact command replay may acknowledge a historical view; do not render it.
    const refreshed = await loadTicket();
    if (isCurrent(refreshed.generation))
      showStatus(
        refreshed.loaded
          ? 'Human support requested. Your unsent reply is kept.'
          : 'Human-support request accepted. Current ticket refresh failed; reload before another action. Your unsent reply is kept.',
        !refreshed.loaded,
      );
  } catch (error) {
    if (!isCurrent(generation) || error.stale) return;
    if (error.status === 409) {
      personPacket = null;
      const refreshed = await loadTicket();
      if (refreshed.loaded && isCurrent(refreshed.generation))
        showStatus(
          'The ticket changed. Review it before making a new request.',
          true,
        );
    } else failure(error, 'Human-support request', generation);
  } finally {
    finishOperation(operation);
  }
});
replyForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (
    busy !== null ||
    retrySeconds() > 0 ||
    suspended ||
    authorityReloadRequired ||
    personPacket !== null ||
    currentView === null ||
    !onThisTicket()
  )
    return;
  const body = new FormData(replyForm).get('body');
  const operation = beginOperation();
  const generation = operation.generation;
  updateHumanControl();
  try {
    await readViewer(generation);
    showStatus('Sending reply…');
    const view = await api(
      `/api/support/tickets/${encodeURIComponent(ticketId)}/replies`,
      { method: 'POST', body: JSON.stringify({ body }) },
    );
    guard(generation);
    validateView(view);
    await readViewer(generation);
    if (new FormData(replyForm).get('body') === body) replyForm.reset();
    renderTicket(view);
    showStatus('Reply sent.');
  } catch (error) {
    failure(error, 'Reply', generation);
  } finally {
    finishOperation(operation);
  }
});
select('#ticket-reload').addEventListener('click', () => {
  if (!onThisTicket()) window.location.reload();
  else void loadTicket();
});
window.addEventListener('pagehide', invalidate);
window.addEventListener('popstate', invalidate);
window.addEventListener('pageshow', () => {
  if (suspended && onThisTicket()) void loadTicket();
});
void loadTicket();
