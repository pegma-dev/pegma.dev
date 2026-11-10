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
let currentView = null;
let readGeneration = 0;
let busy = false;
let personPacket = null;

function showStatus(message, error = false) {
  statusNode.textContent = message;
  statusNode.dataset.tone = error ? 'error' : 'neutral';
}
function onThisTicket() {
  return new URL(window.location.href).searchParams.get('id') === ticketId;
}
function guard(generation) {
  if (generation !== readGeneration || !onThisTicket())
    throw Object.assign(new Error('stale_view'), { stale: true });
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
  // Unsent reply text stays in the form when the private view is cleared.
}
function invalidate() {
  ++readGeneration;
  viewer = null;
  csrfToken = '';
  personPacket = null;
  clearTicket();
}
function updateHumanControl() {
  const ticket = currentView?.ticket;
  const terminal = ticket?.status === 'resolved' || ticket?.status === 'closed';
  const state = ticket?.handling ?? 'human-pending';
  humanControls.hidden = ticket === undefined && personPacket === null;
  humanStatus.textContent =
    personPacket !== null
      ? 'The previous request has no confirmed acknowledgement. Retry that same request.'
      : terminal
        ? `This ticket is ${ticket.status}. Request human support to reopen it.`
        : state === 'assistant'
          ? 'You can ask for human support at any time.'
          : state === 'human-active'
            ? 'Human support is active on this ticket.'
            : 'This ticket is waiting for human support.';
  personButton.hidden =
    personPacket === null && !terminal && state !== 'assistant';
  personButton.disabled =
    busy || (ticket === undefined && personPacket === null);
  personButton.textContent =
    personPacket === null
      ? 'Request human support'
      : 'Retry human-support request';
}
async function api(path, init = {}) {
  const headers = new Headers(init.headers);
  if (init.body !== undefined) headers.set('Content-Type', 'application/json');
  if (csrfToken !== '') headers.set('X-Pegma-CSRF', csrfToken);
  const response = await fetch(path, {
    ...init,
    headers,
    credentials: 'same-origin',
    cache: 'no-store',
    referrerPolicy: 'no-referrer',
  });
  if (!response.ok)
    throw Object.assign(new Error('request_failed'), {
      status: response.status,
    });
  return response.json();
}
async function readViewer(generation, expected = viewer) {
  const result = await api('/api/identity/account');
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
function failure(error) {
  if (error.stale) {
    if (!onThisTicket()) invalidate();
    return;
  }
  clearTicket();
  if ([400, 401, 403, 404].includes(error.status)) personPacket = null;
  if (error.status === 401 || error.status === 403) {
    viewer = null;
    csrfToken = '';
  }
  signedOut.hidden = error.status !== 401;
  showStatus(
    error.status === 401
      ? 'Sign in, then reload this ticket.'
      : error.status === 403
        ? 'This ticket is unavailable to your account.'
        : error.status === 404
          ? 'Ticket not found.'
          : personPacket !== null
            ? 'Could not confirm the result. Retry the same human-support request.'
            : 'Could not confirm the result. Reload the ticket before another action.',
    error.status !== 401,
  );
  updateHumanControl();
}
async function loadTicket() {
  if (busy) return false;
  const generation = ++readGeneration;
  clearTicket();
  if (ticketId === '' || !onThisTicket()) {
    showStatus('Missing or changed ticket id.', true);
    return false;
  }
  select('#ticket-id-display').textContent = ticketId;
  try {
    await readViewer(generation);
    const view = await api(
      `/api/support/tickets/${encodeURIComponent(ticketId)}`,
    );
    guard(generation);
    validateView(view);
    await readViewer(generation);
    renderTicket(view);
    showStatus('Ticket loaded.');
    return true;
  } catch (error) {
    failure(error);
    return false;
  }
}
personButton.addEventListener('click', async () => {
  if (busy || !onThisTicket() || viewer === null) return;
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
    viewer,
    body: JSON.stringify(Object.freeze({ commandId: crypto.randomUUID() })),
  });
  const packet = personPacket;
  const generation = ++readGeneration;
  busy = true;
  updateHumanControl();
  try {
    await readViewer(generation, packet.viewer);
    const view = await api(
      `/api/support/tickets/${encodeURIComponent(ticketId)}/request-person`,
      { method: 'POST', body: packet.body },
    );
    guard(generation);
    validateView(view);
    await readViewer(generation, packet.viewer);
    personPacket = null;
    renderTicket(view);
    showStatus('Human support requested. Your unsent reply is kept.');
  } catch (error) {
    if (generation !== readGeneration || !onThisTicket()) {
      failure({ stale: true });
      return;
    }
    if (error.status === 409) {
      personPacket = null;
      busy = false;
      if (await loadTicket())
        showStatus(
          'The ticket changed. Review it before making a new request.',
          true,
        );
    } else failure(error);
  } finally {
    busy = false;
    updateHumanControl();
  }
});
replyForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (busy || currentView === null || !onThisTicket()) return;
  const generation = ++readGeneration;
  const body = new FormData(replyForm).get('body');
  busy = true;
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
    failure(error);
  } finally {
    busy = false;
    updateHumanControl();
  }
});
select('#ticket-reload').addEventListener('click', () => {
  void loadTicket();
});
window.addEventListener('pagehide', invalidate);
window.addEventListener('popstate', invalidate);
void loadTicket();
