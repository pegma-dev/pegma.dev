const select = (selector) => document.querySelector(selector);
const statusNode = select('#staff-ticket-status');
const signedOut = select('#staff-ticket-signed-out');
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
const ticketId = new URL(window.location.href).searchParams.get('id') ?? '';
let csrfToken = '';
let viewer = null;
let currentView = null;
let readGeneration = 0;
let handoffGeneration = 0;
let busy = false;
let takeoverPacket = null;

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
function clearHandoff() {
  ++handoffGeneration;
  handoffList.replaceChildren();
  handoffStatus.textContent = '';
  handoffPanel.hidden = true;
}
function hideAll() {
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
  viewer = null;
  csrfToken = '';
  takeoverPacket = null;
  hideAll();
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
  const ticket = currentView?.ticket;
  const terminal = ticket?.status === 'resolved' || ticket?.status === 'closed';
  const state = ticket === undefined ? '' : effectiveHandling(ticket).state;
  takeoverButton.textContent =
    takeoverPacket === null ? 'Take over' : 'Retry take over';
  takeoverButton.disabled =
    busy ||
    (takeoverPacket === null &&
      (ticket === undefined || terminal || state === 'human-active'));
  for (const button of select('#staff-lifecycle').querySelectorAll('button')) {
    if (button !== takeoverButton)
      button.disabled = busy || ticket === undefined;
  }
  composeSubmit.disabled =
    busy ||
    ticket === undefined ||
    !['public', 'internal'].includes(selectedComposeMode()) ||
    composeBody.value.trim() === '';
  composeForm.dataset.mode = selectedComposeMode() || 'unset';
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
    !Number.isSafeInteger(view.ticket.revision) ||
    view.ticket.revision < 1 ||
    !Array.isArray(view.messages) ||
    view.messages.some((message) => message.ticketId !== ticketId) ||
    view.csrfToken !== viewer?.csrfToken
  )
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
  updateControls();
}
function failure(error) {
  if (error.stale) {
    if (!onThisTicket()) invalidate();
    return;
  }
  clearHandoff();
  if (
    [401, 403, 404].includes(error.status) ||
    error.message === 'invalid_response'
  ) {
    ++readGeneration;
    hideAll();
  }
  if (error.status === 401 || error.status === 403) {
    takeoverPacket = null;
    viewer = null;
    csrfToken = '';
  }
  if (error.status === 400 || error.status === 404) takeoverPacket = null;
  signedOut.hidden = error.status !== 401;
  forbidden.hidden = error.status !== 403;
  showStatus(
    error.status === 401
      ? 'Sign in, then reload this ticket.'
      : error.status === 403
        ? 'You do not have staff access.'
        : error.status === 404
          ? 'Ticket not found.'
          : takeoverPacket !== null
            ? 'Could not confirm the result. Reload or retry the same take-over request.'
            : 'Could not confirm the result. Reload the ticket before another action.',
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
    if ([401, 403, 404].includes(error.status) || error.stale) failure(error);
    else {
      handoffPanel.hidden = false;
      handoffStatus.textContent =
        'Private handoff is unavailable. Retry the read.';
    }
  }
}
async function loadTicket() {
  if (busy) return false;
  const generation = ++readGeneration;
  hideAll();
  if (ticketId === '' || !onThisTicket()) {
    showStatus('Missing or changed ticket id.', true);
    return false;
  }
  select('#staff-ticket-id-display').textContent = ticketId;
  try {
    await readViewer(generation);
    const view = await api(
      `/api/support/admin/tickets/${encodeURIComponent(ticketId)}`,
    );
    guard(generation);
    validateView(view);
    await readViewer(generation);
    renderTicket(view);
    showStatus('Ticket loaded.');
    await loadHandoff();
    return (
      generation === readGeneration && onThisTicket() && currentView !== null
    );
  } catch (error) {
    failure(error);
    return false;
  }
}
async function patchTicket(action, extra = {}) {
  if (busy || currentView === null || !onThisTicket()) return;
  const generation = ++readGeneration;
  busy = true;
  clearHandoff();
  updateControls();
  try {
    await readViewer(generation);
    const view = await api(
      `/api/support/admin/tickets/${encodeURIComponent(ticketId)}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ action, ...extra }),
      },
    );
    guard(generation);
    validateView(view);
    await readViewer(generation);
    renderTicket(view);
    showStatus(`Action ${action} applied.`);
    await loadHandoff();
  } catch (error) {
    failure(error);
  } finally {
    busy = false;
    updateControls();
  }
}
takeoverButton.addEventListener('click', async () => {
  if (busy || viewer === null || !onThisTicket()) return;
  if (takeoverPacket === null) {
    if (
      currentView === null ||
      ['resolved', 'closed'].includes(currentView.ticket.status)
    )
      return;
    const handling = effectiveHandling(currentView.ticket);
    if (handling.state === 'human-active') return;
    takeoverPacket = Object.freeze({
      viewer,
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
  const generation = ++readGeneration;
  busy = true;
  clearHandoff();
  updateControls();
  try {
    await readViewer(generation, packet.viewer);
    const ack = await api(
      `/api/support/admin/tickets/${encodeURIComponent(ticketId)}/take-over`,
      { method: 'POST', body: packet.body },
    );
    guard(generation);
    validateView(ack);
    await readViewer(generation, packet.viewer);
    takeoverPacket = null;
    busy = false;
    // Exact SDK replay can acknowledge a historical view. Always read current state.
    if (await loadTicket())
      showStatus('Take over accepted. Assignment is unchanged.');
  } catch (error) {
    if (generation !== readGeneration || !onThisTicket()) {
      failure({ stale: true });
      return;
    }
    if (error.status === 409) {
      takeoverPacket = null;
      busy = false;
      if (await loadTicket())
        showStatus(
          'The ticket changed. Review it before choosing Take over again.',
          true,
        );
    } else failure(error);
  } finally {
    busy = false;
    updateControls();
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
    busy ||
    currentView === null ||
    !onThisTicket() ||
    !body ||
    !['public', 'internal'].includes(mode)
  )
    return;
  const generation = ++readGeneration;
  busy = true;
  clearHandoff();
  updateControls();
  try {
    await readViewer(generation);
    const suffix = mode === 'public' ? 'messages' : 'notes';
    const view = await api(
      `/api/support/admin/tickets/${encodeURIComponent(ticketId)}/${suffix}`,
      {
        method: 'POST',
        body: JSON.stringify({ body }),
      },
    );
    guard(generation);
    validateView(view);
    await readViewer(generation);
    if (composeBody.value.trim() === body && selectedComposeMode() === mode)
      composeForm.reset();
    renderTicket(view);
    showStatus(
      mode === 'public' ? 'Public reply sent.' : 'Internal note saved.',
    );
    await loadHandoff();
  } catch (error) {
    failure(error);
  } finally {
    busy = false;
    updateControls();
  }
});
select('#staff-ticket-reload').addEventListener('click', () => {
  void loadTicket();
});
select('#staff-handoff-reload').addEventListener('click', () => {
  void loadHandoff();
});
window.addEventListener('pagehide', invalidate);
window.addEventListener('popstate', invalidate);
updateControls();
void loadTicket();
