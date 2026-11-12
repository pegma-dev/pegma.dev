const statusNode = document.querySelector('#feedback-status');
const signedOut = document.querySelector('#feedback-signed-out');
const signInLinks = [...signedOut.querySelectorAll('a')].map((node) => ({
  node, target: node.target ?? '', rel: node.rel ?? '',
}));
const signedIn = document.querySelector('#feedback-signed-in');
const emailNode = document.querySelector('#feedback-email');
const ticketList = document.querySelector('#ticket-list');
const createForm = document.querySelector('#create-ticket');
const assistantChoice = document.querySelector('#assistant-choice');
const assistantPreference = document.querySelector('#assistant-preference');
const assistantStatus = document.querySelector('#assistant-status');
let assistantCapability = null;
const recoveryButton = document.createElement('button');
recoveryButton.type = 'button';
recoveryButton.textContent = 'Reload current access';
const pageUrl = new URL(window.location.href);
let csrfToken = '';
let viewer = null;
let createPacket = null;
let createAcknowledged = false;
let viewReady = false;
let authorityReloadRequired = false;
let readGeneration = 0;
let busy = null;
let suspended = false;
let retryAt = 0;
let retryTimer = null;
const requests = new Set();

function onThisPage() {
  const current = new URL(window.location.href);
  return current.origin === pageUrl.origin && current.pathname === pageUrl.pathname;
}
function isCurrent(generation) {
  return generation === readGeneration && !suspended && onThisPage();
}
function guard(generation) {
  if (!isCurrent(generation))
    throw Object.assign(new Error('stale_view'), { stale: true });
}
function showStatus(message, isError = false) {
  statusNode.textContent = message;
  statusNode.dataset.tone = isError ? 'error' : 'neutral';
  if (createPacket !== null || !viewReady) statusNode.append(' ', recoveryButton);
}
function clearPrivate() {
  assistantCapability = null;
  if (assistantChoice) assistantChoice.hidden = true;
  if (assistantPreference) assistantPreference.checked = false;
  if (assistantStatus) {
    assistantStatus.textContent = '';
    assistantStatus.hidden = true;
  }
  viewReady = false;
  signedIn.hidden = true;
  signedOut.hidden = true;
  emailNode.textContent = '';
  ticketList.replaceChildren();
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
  updateControls();
  return operation;
}
function finishOperation(operation) {
  if (busy === operation) {
    busy = null;
    updateControls();
  }
}
function updateControls() {
  if (assistantPreference) assistantPreference.disabled = busy !== null || createPacket !== null || !viewReady || suspended;
  createForm.noValidate = createPacket !== null;
  for (const link of signInLinks) {
    link.node.target = createPacket === null ? link.target : '_blank';
    link.node.rel = createPacket === null ? link.rel : 'noopener noreferrer';
  }
  const waiting = Math.max(0, Math.ceil((retryAt - Date.now()) / 1000));
  // A suspended/denied page still needs a local read action; this button never
  // dispatches a mutation and loadTickets rechecks the current page and actor.
  recoveryButton.disabled = busy !== null || waiting > 0;
  for (const button of createForm.querySelectorAll('button')) {
    button.disabled =
      busy !== null || suspended || viewer === null || !viewReady ||
      authorityReloadRequired || waiting > 0;
    button.textContent = createPacket === null ? 'Submit ticket' : 'Retry previous ticket';
  }
  if (waiting > 0 && retryTimer === null && !suspended)
    retryTimer = setTimeout(() => {
      retryTimer = null;
      updateControls();
    }, Math.min(1000, Math.max(1, retryAt - Date.now())));
}
function retryDeadline(value) {
  if (value !== null) {
    const text = value.trim();
    const now = Date.now();
    const deadline = /^\d+$/u.test(text) ? now + Number(text) * 1000 : Date.parse(text);
    if (Number.isSafeInteger(deadline)) return Math.max(now, deadline);
  }
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
  const aborted = new Promise((_resolve, reject) => { rejectAbort = reject; });
  const onAbort = () => rejectAbort(Object.assign(
    new Error(timedOut ? 'request_timeout' : 'request_aborted'), { timedOut },
  ));
  controller.signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 15_000);
  try {
    return await Promise.race([
      (async () => {
        const response = await fetch(path, {
          ...init, headers, signal: controller.signal, credentials: 'same-origin',
          cache: 'no-store', referrerPolicy: 'no-referrer',
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
  const result = await api('/api/identity/account');
  guard(generation);
  if (
    typeof result.account?.subject !== 'string' || result.account.subject === '' ||
    typeof result.csrfToken !== 'string' || result.csrfToken === '' ||
    typeof result.account.email !== 'string' ||
    result.account.email.trim() === '' || result.account.email.trim().length > 254 ||
    /[\u0000-\u001f\u007f]/u.test(result.account.email)
  )
    throw Object.assign(new Error('invalid_response'), { status: 502 });
  const next = Object.freeze({
    subject: result.account.subject,
    csrfToken: result.csrfToken,
    // The account DTO carries the authenticated active verified User.email.
    // Preserve its chosen value, with only the existing contact trim convention.
    email: result.account.email.trim(),
  });
  // Keep an unknown A-owned intent inaccessible to B. Returning to A must
  // recover this intent rather than mint a new command or create-ticket ID.
  if (createPacket !== null && next.subject !== createPacket.subject)
    throw Object.assign(new Error('session_changed'), { status: 401 });
  if (expected !== null &&
    (next.subject !== expected.subject || next.csrfToken !== expected.csrfToken))
    throw Object.assign(new Error('session_changed'), { status: 401 });
  viewer = next;
  csrfToken = next.csrfToken;
  return next;
}
function renderTickets(tickets) {
  ticketList.replaceChildren();
  if (tickets.length === 0) {
    const empty = document.createElement('li');
    empty.textContent = 'No tickets yet.';
    ticketList.append(empty);
    return;
  }
  for (const ticket of tickets) {
    const item = document.createElement('li');
    const link = document.createElement('a');
    link.href = `/feedback/ticket/?id=${encodeURIComponent(ticket.id)}`;
    link.textContent = `${ticket.marker} ${ticket.subject}`;
    const meta = document.createElement('span');
    meta.className = 'form-note';
    meta.textContent = `${ticket.status} · ${ticket.category ?? 'uncategorized'}`;
    item.append(link, meta);
    ticketList.append(item);
  }
}
function formDraft() {
  const form = new FormData(createForm);
  return { subject: form.get('subject'), body: form.get('body'), category: form.get('category') };
}
function failure(error, generation) {
  if (!isCurrent(generation) || error.stale) return;
  clearPrivate();
  if (error.status === 401 || error.status === 403) {
    viewer = null;
    csrfToken = '';
    authorityReloadRequired = true;
  }
  signedOut.hidden = error.status !== 401;
  if (error.status === 429) retryAt = Math.max(retryAt, error.retryAt);
  // A 404 or an absent/present list entry cannot settle an unknown create:
  // the original server call can still commit after the browser request ends.
  showStatus(
    error.status === 429
      ? `Ticket access was rate limited. Wait at least ${Math.max(1, Math.ceil((retryAt - Date.now()) / 1000))} seconds, then reload current access.`
      : error.status === 401
        ? createPacket !== null
          ? 'Sign in to the original account in another tab, then return here and reload current access. A ticket already submitted may have been created.'
          : 'Sign in, then reload current access.'
        : error.status === 403
          ? 'Current account access could not be confirmed. A ticket already submitted may have been created.'
          : createAcknowledged
            ? 'Ticket creation accepted. Current ticket refresh failed; reload before another submission.'
            : createPacket !== null
              ? 'Could not confirm ticket creation. Reload current access, then retry the same ticket. Your current draft is kept.'
              : 'Feedback is unavailable. Reload current access to retry.',
    error.status !== 401,
  );
  updateControls();
}
async function loadTickets() {
  if (!onThisPage()) { window.location.reload(); return { loaded: false }; }
  const operation = beginOperation();
  const generation = operation.generation;
  clearPrivate();
  showStatus('Checking current access…');
  let capabilityUnavailable = false;
  try {
    await readViewer(generation, null);
    const result = await api('/api/support/tickets');
    guard(generation);
    if (!Array.isArray(result.tickets) || result.csrfToken !== viewer?.csrfToken ||
      result.tickets.some((ticket) =>
        typeof ticket.id !== 'string' || typeof ticket.subject !== 'string' ||
        typeof ticket.marker !== 'string' || typeof ticket.status !== 'string'))
      throw Object.assign(new Error('invalid_response'), { status: 502 });
    if (assistantChoice && assistantPreference) {
      let capability;
      try { capability = await api('/api/support/assistant/capability'); }
      catch (error) {
        if (error.status === 401 || error.status === 403) throw error;
        capabilityUnavailable = true;
      }
      guard(generation);
      if (!capabilityUnavailable) {
        if (typeof capability?.enabled !== 'boolean' || capability.csrfToken !== viewer?.csrfToken)
          capabilityUnavailable = true;
        else if (capability.enabled) {
          const displayedVersion = assistantChoice.dataset.disclosureVersion;
          if (typeof displayedVersion !== 'string' || displayedVersion.length === 0 ||
            displayedVersion.length > 200 || /[\u0000-\u001f\u007f]/u.test(displayedVersion) ||
            capability.disclosureVersion !== displayedVersion)
            capabilityUnavailable = true;
          else assistantCapability = Object.freeze({ disclosureVersion: displayedVersion });
        }
      }
      assistantChoice.hidden = assistantCapability === null;
    }
    await readViewer(generation);
    if (createPacket !== null && createAcknowledged) {
      const current = formDraft();
      if (Object.keys(current).every((key) => current[key] === createPacket.draft[key]))
        createForm.reset();
      createPacket = null;
      createAcknowledged = false;
      if (assistantPreference) assistantPreference.checked = false;
    }
    authorityReloadRequired = false;
    if (assistantStatus) {
      assistantStatus.textContent = capabilityUnavailable
        ? createPacket !== null
          ? 'AI assistance is temporarily unavailable. Retry the original ticket request to confirm its result.'
          : 'AI assistance is temporarily unavailable. You can still submit a ticket for human support.'
        : '';
      assistantStatus.hidden = !capabilityUnavailable;
    }
    viewReady = true;
    renderTickets(result.tickets);
    emailNode.textContent = viewer.email;
    signedOut.hidden = true;
    signedIn.hidden = false;
    showStatus(createPacket === null
      ? 'You can submit private feedback.'
      : 'The previous ticket has no confirmed acknowledgement. Retry that same ticket; your current draft is separate.');
    return { generation, loaded: true };
  } catch (error) {
    failure(error, generation);
    return { generation, loaded: false };
  } finally { finishOperation(operation); }
}
createForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (busy !== null || suspended || !onThisPage() || Date.now() < retryAt) return;
  if (createAcknowledged) { await loadTickets(); return; }
  if (viewer === null || !viewReady || authorityReloadRequired) return;
  if (createPacket === null) {
    const draft = formDraft();
    if (
      Object.values(draft).some((value) => typeof value !== 'string' || value.trim() === '') ||
      draft.subject.length > 200 || draft.body.length > 20_000 ||
      /[\u0000-\u001F\u007F-\u009F]/u.test(draft.subject) ||
      /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u.test(draft.body) ||
      !['feedback', 'bug', 'feature_request', 'documentation', 'question'].includes(draft.category)
    ) {
      showStatus('Check the subject, details and category. Remove unsupported control characters and stay within the field limits.', true);
      return;
    }
    const expectedAccountId = viewer.subject;
    const expectedRequesterEmail = viewer.email;
    const commandId = `${expectedAccountId}~${crypto.randomUUID()}`;
    const messageId = `${expectedAccountId}~${crypto.randomUUID()}`;
    if (![commandId, messageId].every((id) => /^[A-Za-z0-9._~-]{1,128}$/u.test(id))) {
      showStatus('Could not prepare a retry-safe ticket for this account.', true);
      return;
    }
    const ticketId = crypto.randomUUID();
    const answering = assistantCapability !== null && assistantPreference?.checked === true;
    createPacket = Object.freeze({
      subject: expectedAccountId, ticketId,
      path: answering ? '/api/support/assistant/tickets' : '/api/support/tickets', method: 'POST',
      headers: Object.freeze({ 'X-Pegma-Support-Command': '1' }),
      body: JSON.stringify({ ...draft, command: { version: 1, expectedAccountId, expectedRequesterEmail, commandId, messageId, ticketId },
        ...(answering ? { preference: 'assistant_if_available', disclosureVersion: assistantCapability.disclosureVersion } : {}) }),
      answering,
      draft: Object.freeze(draft),
    });
  }
  const packet = createPacket;
  const expectedViewer = viewer;
  const operation = beginOperation();
  const generation = operation.generation;
  showStatus('Submitting ticket…');
  try {
    await readViewer(generation, expectedViewer);
    const ack = await api(packet.path, {
      method: packet.method, headers: packet.headers, body: packet.body,
    });
    guard(generation);
    if (ack?.ticket?.id !== packet.ticketId || !Number.isSafeInteger(ack.ticket.number) ||
      ack.ticket.number < 1 || !Array.isArray(ack.messages) ||
      ack.messages.some((message) => message.ticketId !== packet.ticketId || message.visibility !== 'customer') ||
      (ack.csrfToken !== undefined && ack.csrfToken !== expectedViewer.csrfToken) ||
      (packet.answering && !['human', 'assistant'].includes(ack.initialMode)))
      throw Object.assign(new Error('invalid_response'), { status: 502 });
    await readViewer(generation, expectedViewer);
    createAcknowledged = true;
    const refreshed = await loadTickets();
    if (isCurrent(refreshed.generation))
      showStatus(refreshed.loaded
        ? 'Ticket created. Open it from the list below. Your current draft is kept if it changed.'
        : 'Ticket creation accepted. Current ticket refresh failed; reload before another submission.', !refreshed.loaded);
  } catch (error) { failure(error, generation); }
  finally { finishOperation(operation); }
});
function invalidate() {
  ++readGeneration;
  suspended = true;
  cancelRequests();
  busy = null;
  viewer = null;
  csrfToken = '';
  if (retryTimer !== null) clearTimeout(retryTimer);
  retryTimer = null;
  clearPrivate();
  showStatus('Feedback view cleared. Reload current access before another action.');
  updateControls();
}
recoveryButton.addEventListener('click', () => { void loadTickets(); });
window.addEventListener('pagehide', invalidate);
window.addEventListener('popstate', invalidate);
window.addEventListener('pageshow', () => { if (suspended && onThisPage()) void loadTickets(); });
updateControls();
void loadTickets();
