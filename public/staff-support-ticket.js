const statusNode = document.querySelector('#staff-ticket-status');
const signedOut = document.querySelector('#staff-ticket-signed-out');
const forbidden = document.querySelector('#staff-ticket-forbidden');
const detail = document.querySelector('#staff-ticket-detail');
const heading = document.querySelector('#staff-ticket-heading');
const meta = document.querySelector('#staff-ticket-meta');
const requesterNode = document.querySelector('#staff-ticket-requester');
const messageList = document.querySelector('#staff-message-list');
const composeForm = document.querySelector('#staff-compose-form');
const composeBody = document.querySelector('#compose-body');
const composeSubmit = document.querySelector('#compose-submit');
const prioritySelect = document.querySelector('#priority-select');
const ticketId = new URL(window.location.href).searchParams.get('id') ?? '';

let csrfToken = '';
let currentView = null;

function showStatus(message, isError = false) {
  statusNode.textContent = message;
  statusNode.dataset.tone = isError ? 'error' : 'neutral';
}

function hideAll() {
  signedOut.hidden = true;
  forbidden.hidden = true;
  detail.hidden = true;
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

function authorLabel(message) {
  if (message.visibility === 'internal') {
    return 'Internal note';
  }
  if (message.authorKind === 'customer') {
    return 'Customer';
  }
  if (message.authorKind === 'staff') {
    return 'Staff (public)';
  }
  return 'System';
}

function renderMessages(messages) {
  messageList.replaceChildren();
  for (const message of messages) {
    const item = document.createElement('li');
    if (message.visibility === 'internal') {
      item.className = 'staff-message-internal';
    } else if (message.authorKind === 'staff') {
      item.className = 'staff-message-public-staff';
    } else if (message.authorKind === 'customer') {
      item.className = 'staff-message-customer';
    }

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
}

function renderTicket(view) {
  currentView = view;
  const marker =
    typeof view.ticket.marker === 'string'
      ? view.ticket.marker
      : `[PEG-${view.ticket.number}]`;
  heading.textContent = `${marker} ${view.ticket.subject}`;
  meta.textContent = [
    view.ticket.status,
    view.ticket.priority,
    view.ticket.category ?? 'uncategorized',
    view.ticket.channel,
    `rev ${view.ticket.revision}`,
    view.ticket.assignedTo
      ? `assigned:${view.ticket.assignedTo}`
      : 'unassigned',
  ].join(' · ');

  const requester = view.ticket.requester ?? {};
  const requesterParts = [
    `association: ${requester.association ?? 'unknown'}`,
  ];
  if (typeof requester.email === 'string') {
    requesterParts.push(`email: ${requester.email}`);
  }
  if (typeof requester.principalId === 'string') {
    requesterParts.push(`principal: ${requester.principalId}`);
  }
  requesterNode.textContent = requesterParts.join(' · ');

  if (prioritySelect) {
    prioritySelect.value = view.ticket.priority;
  }

  renderMessages(view.messages);
  updateComposeEnabled();
}

function selectedComposeMode() {
  const selected = composeForm.querySelector(
    'input[name="composeMode"]:checked',
  );
  return selected ? selected.value : '';
}

function updateComposeEnabled() {
  const mode = selectedComposeMode();
  const body = composeBody.value.trim();
  composeSubmit.disabled = mode === '' || body === '';
  composeForm.dataset.mode = mode === '' ? 'unset' : mode;
}

async function patchTicket(action, extra = {}) {
  showStatus(`Applying ${action}…`);
  const view = await api(
    `/api/support/admin/tickets/${encodeURIComponent(ticketId)}`,
    {
      method: 'PATCH',
      body: JSON.stringify({ action, ...extra }),
    },
  );
  if (typeof view.csrfToken === 'string') {
    csrfToken = view.csrfToken;
  }
  renderTicket(view);
  showStatus(`Action ${action} applied.`);
}

async function loadTicket() {
  if (ticketId === '') {
    showStatus('Missing ticket id.', true);
    return;
  }
  const idDisplay = document.querySelector('#staff-ticket-id-display');
  if (idDisplay) idDisplay.textContent = ticketId;

  hideAll();
  try {
    await api('/api/identity/account');
  } catch (error) {
    if (error.status === 401) {
      signedOut.hidden = false;
      showStatus('Sign in to view this ticket.');
      return;
    }
    showStatus(`Staff ticket unavailable: ${error.message}`, true);
    return;
  }

  try {
    const view = await api(
      `/api/support/admin/tickets/${encodeURIComponent(ticketId)}`,
    );
    if (typeof view.csrfToken === 'string') {
      csrfToken = view.csrfToken;
    }
    detail.hidden = false;
    renderTicket(view);
    showStatus('Ticket loaded.');
  } catch (error) {
    if (error.status === 401) {
      signedOut.hidden = false;
      showStatus('Sign in to view this ticket.');
      return;
    }
    if (error.status === 403) {
      forbidden.hidden = false;
      showStatus('You do not have staff access.', true);
      return;
    }
    if (error.status === 404) {
      showStatus('Ticket not found.', true);
      return;
    }
    showStatus(`Could not load ticket: ${error.message}`, true);
  }
}

function bindLifecycle() {
  document
    .querySelector('#action-assign')
    ?.addEventListener('click', async () => {
      try {
        await patchTicket('assign');
      } catch (error) {
        showStatus(`Assign failed: ${error.message}`, true);
      }
    });
  document
    .querySelector('#action-unassign')
    ?.addEventListener('click', async () => {
      try {
        await patchTicket('unassign');
      } catch (error) {
        showStatus(`Unassign failed: ${error.message}`, true);
      }
    });
  document
    .querySelector('#action-priority')
    ?.addEventListener('click', async () => {
      try {
        await patchTicket('change_priority', {
          priority: prioritySelect.value,
        });
      } catch (error) {
        showStatus(`Priority change failed: ${error.message}`, true);
      }
    });
  document
    .querySelector('#action-resolve')
    ?.addEventListener('click', async () => {
      try {
        await patchTicket('resolve');
      } catch (error) {
        showStatus(`Resolve failed: ${error.message}`, true);
      }
    });
  document
    .querySelector('#action-close')
    ?.addEventListener('click', async () => {
      try {
        await patchTicket('close');
      } catch (error) {
        showStatus(`Close failed: ${error.message}`, true);
      }
    });
  document
    .querySelector('#action-reopen')
    ?.addEventListener('click', async () => {
      try {
        await patchTicket('reopen');
      } catch (error) {
        showStatus(`Reopen failed: ${error.message}`, true);
      }
    });
}

composeForm.addEventListener('change', updateComposeEnabled);
composeForm.addEventListener('input', updateComposeEnabled);

composeForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const mode = selectedComposeMode();
  const body = composeBody.value.trim();
  if (mode === '' || body === '') {
    showStatus('Select Public reply or Internal note, and enter a body.', true);
    return;
  }

  const path =
    mode === 'public'
      ? `/api/support/admin/tickets/${encodeURIComponent(ticketId)}/messages`
      : `/api/support/admin/tickets/${encodeURIComponent(ticketId)}/notes`;

  try {
    showStatus(mode === 'public' ? 'Sending public reply…' : 'Saving note…');
    const view = await api(path, {
      method: 'POST',
      body: JSON.stringify({ body }),
    });
    composeForm.reset();
    updateComposeEnabled();
    renderTicket(view);
    showStatus(mode === 'public' ? 'Public reply sent.' : 'Internal note saved.');
  } catch (error) {
    showStatus(`Compose failed: ${error.message}`, true);
  }
});

bindLifecycle();
updateComposeEnabled();
loadTicket();
