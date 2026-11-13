const statusNode = document.querySelector('#staff-queue-status');
const signedOut = document.querySelector('#staff-queue-signed-out');
const forbidden = document.querySelector('#staff-queue-forbidden');
const panel = document.querySelector('#staff-queue-panel');
const emailNode = document.querySelector('#staff-queue-email');
const queueList = document.querySelector('#queue-list');
const filterForm = document.querySelector('#queue-filters');

let csrfToken = '';
let viewerSubject = '';
let reviewInbox = null;
let queueGeneration = 0;
let suspended = false;
const requests = new Set();
const requestTimeoutMs = 15_000;

function showStatus(message, isError = false) {
  statusNode.textContent = message;
  statusNode.dataset.tone = isError ? 'error' : 'neutral';
}

function hideAll() {
  ++queueGeneration;
  reviewInbox?.clear();
  viewerSubject = '';
  signedOut.hidden = true;
  forbidden.hidden = true;
  panel.hidden = true;
  queueList.replaceChildren();
  emailNode.textContent = '';
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
function renderQueue(items) {
  queueList.replaceChildren();
  if (items.length === 0) {
    const empty = document.createElement('li');
    empty.textContent = 'No tickets match these filters.';
    queueList.append(empty);
    return;
  }
  for (const item of items) {
    const li = document.createElement('li');
    const link = document.createElement('a');
    link.href = `/staff/support/ticket/?id=${encodeURIComponent(item.ticketId)}`;
    link.textContent = item.ticketId;
    const meta = document.createElement('span');
    meta.className = 'form-note';
    const parts = [
      item.status,
      item.handling === 'human-active'
        ? 'Human support active'
        : item.handling === 'assistant'
          ? 'Assistant handling'
          : item.handling === 'human-pending'
            ? 'Waiting for human support'
            : 'Handling unavailable',
      item.priority,
      item.category ?? 'uncategorized',
      item.requesterAssociation,
      item.assignedTo ? `assigned:${item.assignedTo}` : 'unassigned',
      new Date(item.updatedAt).toLocaleString(),
    ];
    meta.textContent = parts.join(' · ');
    li.append(link, meta);
    queueList.append(li);
  }
}

function filterQuery() {
  const form = new FormData(filterForm);
  const params = new URLSearchParams();
  const handling = form.get('handling');
  if (handling === 'assistant' || handling === 'all')
    params.set('handling', handling);
  const status = form.get('status');
  const sort = form.get('sort');
  if (typeof status === 'string' && status !== '') {
    params.set('status', status);
  }
  if (typeof sort === 'string' && sort !== '') {
    params.set('sort', sort);
  }
  const query = params.toString();
  return query === ''
    ? '/api/support/admin/queue'
    : `/api/support/admin/queue?${query}`;
}

async function refreshQueue() {
  if (suspended) return false;
  const generation = ++queueGeneration;
  reviewInbox?.clear();
  const handling = new FormData(filterForm).get('handling');
  for (const controller of requests) controller.abort();
  requests.clear();
  let result;
  try {
    result = await api(filterQuery());
  } catch (error) {
    if (generation !== queueGeneration) error.stale = true;
    throw error;
  }
  if (generation !== queueGeneration) return false;
  if (typeof result.csrfToken === 'string') {
    csrfToken = result.csrfToken;
  }
  const heading = document.querySelector('#queue-heading');
  if (heading)
    heading.textContent =
      handling === 'assistant'
        ? 'Assistant supervision'
        : handling === 'all'
          ? 'All support work'
          : 'Human queue';
  renderQueue(result.items);
  return true;
}

async function start() {
  suspended = false;
  hideAll();
  const generation = queueGeneration;
  try {
    const account = await api('/api/identity/account');
    if (generation !== queueGeneration || suspended) return;
    csrfToken = account.csrfToken;
    viewerSubject = account.account.subject;
    emailNode.textContent = account.account.email;
  } catch (error) {
    if (generation !== queueGeneration || suspended) return;
    if (error.status === 401) {
      signedOut.hidden = false;
      showStatus('Sign in to use the staff queue.');
      return;
    }
    showStatus(`Staff queue unavailable: ${error.message}`, true);
    return;
  }

  try {
    if (!(await refreshQueue())) return;
    panel.hidden = false;
    showStatus('Queue loaded.');
  } catch (error) {
    if (error.stale) return;
    if (error.status === 401) {
      hideAll();
      signedOut.hidden = false;
      showStatus('Sign in to use the staff queue.');
      return;
    }
    if (error.status === 403) {
      hideAll();
      forbidden.hidden = false;
      showStatus('You do not have staff access.', true);
      return;
    }
    showStatus(`Could not load queue: ${error.message}`, true);
  }
}

filterForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    showStatus('Refreshing queue…');
    if (!(await refreshQueue())) return;
    showStatus('Queue updated.');
  } catch (error) {
    if (error.stale) return;
    if (error.status === 401 || error.status === 403) {
      hideAll();
      forbidden.hidden = error.status !== 403;
      signedOut.hidden = error.status !== 401;
      showStatus(
        error.status === 401
          ? 'Sign in to use the staff queue.'
          : 'You do not have staff access.',
        error.status !== 401,
      );
      return;
    }
    showStatus(`Could not load queue: ${error.message}`, true);
  }
});

const inboxRoot = document.querySelector('#engineering-review-inbox');
if (
  inboxRoot &&
  typeof globalThis.PegmaSupportReviewInbox?.createReviewInbox === 'function'
) {
  reviewInbox = globalThis.PegmaSupportReviewInbox.createReviewInbox({
    host: inboxRoot,
    request: async (path) => {
      try {
        return { status: 200, body: await api(path) };
      } catch (error) {
        if (error.status === 429)
          return {
            status: 429,
            headers: {
              'retry-after': String(
                Math.max(1, Math.ceil((error.retryAt - Date.now()) / 1000)),
              ),
            },
          };
        if (error.status) return { status: error.status };
        throw error;
      }
    },
    session: async () => {
      const subject = viewerSubject;
      if (!subject || suspended) return null;
      const latest = await api('/api/identity/session');
      return latest.account?.subject === subject
        ? { accountId: subject }
        : null;
    },
    capture: () => {
      const generation = queueGeneration;
      return () =>
        generation === queueGeneration && !suspended && !panel.hidden;
    },
    openTicket: (id) => {
      window.location.href =
        '/staff/support/ticket/?id=' + encodeURIComponent(id);
    },
    denied: (status) => {
      hideAll();
      signedOut.hidden = status !== 401;
      forbidden.hidden = status !== 403;
      showStatus(
        status === 401
          ? 'Sign in to use the staff queue.'
          : 'You do not have staff access.',
        status !== 401,
      );
    },
  });
}
function invalidate() {
  suspended = true;
  for (const controller of requests) controller.abort();
  requests.clear();
  csrfToken = '';
  hideAll();
  showStatus('Queue view cleared. Reload to check current access.');
}
window.addEventListener('pagehide', invalidate);
window.addEventListener('popstate', invalidate);
window.addEventListener('pageshow', () => {
  if (suspended) void start();
});
void start();
