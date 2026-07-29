const statusNode = document.querySelector('#staff-queue-status');
const signedOut = document.querySelector('#staff-queue-signed-out');
const forbidden = document.querySelector('#staff-queue-forbidden');
const panel = document.querySelector('#staff-queue-panel');
const emailNode = document.querySelector('#staff-queue-email');
const queueList = document.querySelector('#queue-list');
const filterForm = document.querySelector('#queue-filters');

let csrfToken = '';

function showStatus(message, isError = false) {
  statusNode.textContent = message;
  statusNode.dataset.tone = isError ? 'error' : 'neutral';
}

function hideAll() {
  signedOut.hidden = true;
  forbidden.hidden = true;
  panel.hidden = true;
}

async function api(path, init = {}) {
  const headers = new Headers(init.headers);
  if (init.body !== undefined) {
    headers.set('Content-Type', 'application/json');
  }
  if (csrfToken !== '') {
    headers.set('X-Pegma-CSRF', csrfToken);
  }
  const response = await fetch(path, {
    ...init,
    headers,
    credentials: 'same-origin',
  });
  const body = await response.json();
  if (!response.ok) {
    const error = new Error(
      typeof body.error === 'string' ? body.error : 'request_failed',
    );
    error.status = response.status;
    throw error;
  }
  return body;
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
  const result = await api(filterQuery());
  if (typeof result.csrfToken === 'string') {
    csrfToken = result.csrfToken;
  }
  renderQueue(result.items);
}

async function start() {
  hideAll();
  try {
    const account = await api('/api/identity/account');
    csrfToken = account.csrfToken;
    emailNode.textContent = account.account.email;
  } catch (error) {
    if (error.status === 401) {
      signedOut.hidden = false;
      showStatus('Sign in to use the staff queue.');
      return;
    }
    showStatus(`Staff queue unavailable: ${error.message}`, true);
    return;
  }

  try {
    await refreshQueue();
    panel.hidden = false;
    showStatus('Queue loaded.');
  } catch (error) {
    if (error.status === 401) {
      signedOut.hidden = false;
      showStatus('Sign in to use the staff queue.');
      return;
    }
    if (error.status === 403) {
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
    await refreshQueue();
    showStatus('Queue updated.');
  } catch (error) {
    if (error.status === 403) {
      hideAll();
      forbidden.hidden = false;
      showStatus('You do not have staff access.', true);
      return;
    }
    showStatus(`Could not load queue: ${error.message}`, true);
  }
});

start();
