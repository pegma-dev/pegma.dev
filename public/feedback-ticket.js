const statusNode = document.querySelector('#ticket-status');
const signedOut = document.querySelector('#ticket-signed-out');
const detail = document.querySelector('#ticket-detail');
const heading = document.querySelector('#ticket-heading');
const meta = document.querySelector('#ticket-meta');
const messageList = document.querySelector('#message-list');
const replyForm = document.querySelector('#reply-form');
const ticketId =
  typeof window.__PEGMA_TICKET_ID__ === 'string' &&
  window.__PEGMA_TICKET_ID__.length > 0
    ? window.__PEGMA_TICKET_ID__
    : decodeURIComponent(
        window.location.pathname.replace(/^\/feedback\//u, '').replace(/\/$/u, ''),
      );

let csrfToken = '';

function showStatus(message, isError = false) {
  statusNode.textContent = message;
  statusNode.dataset.tone = isError ? 'error' : 'neutral';
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

function renderMessages(messages) {
  messageList.replaceChildren();
  for (const message of messages) {
    const item = document.createElement('li');
    const who = document.createElement('strong');
    who.textContent =
      message.authorKind === 'customer'
        ? 'You'
        : message.authorKind === 'staff'
          ? 'Pegma'
          : 'System';
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
  heading.textContent = `${view.ticket.marker} ${view.ticket.subject}`;
  meta.textContent = `${view.ticket.status} · ${view.ticket.category ?? 'uncategorized'}`;
  renderMessages(view.messages);
}

async function loadTicket() {
  if (ticketId === '') {
    showStatus('Missing ticket id.', true);
    return;
  }
  try {
    await api('/api/identity/account');
  } catch (error) {
    if (error.status === 401) {
      signedOut.hidden = false;
      detail.hidden = true;
      showStatus('Sign in to view this ticket.');
      return;
    }
    throw error;
  }

  try {
    const view = await api(
      `/api/support/tickets/${encodeURIComponent(ticketId)}`,
    );
    if (typeof view.csrfToken === 'string') {
      csrfToken = view.csrfToken;
    }
    signedOut.hidden = true;
    detail.hidden = false;
    renderTicket(view);
    showStatus('Ticket loaded.');
  } catch (error) {
    signedOut.hidden = true;
    detail.hidden = true;
    if (error.status === 401) {
      signedOut.hidden = false;
      showStatus('Sign in to view this ticket.');
      return;
    }
    if (error.status === 404) {
      showStatus('Ticket not found.', true);
      return;
    }
    showStatus(`Could not load ticket: ${error.message}`, true);
  }
}

replyForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const form = new FormData(replyForm);
    showStatus('Sending reply…');
    const view = await api(
      `/api/support/tickets/${encodeURIComponent(ticketId)}/replies`,
      {
        method: 'POST',
        body: JSON.stringify({ body: form.get('body') }),
      },
    );
    replyForm.reset();
    renderTicket(view);
    showStatus('Reply sent.');
  } catch (error) {
    showStatus(`Could not send reply: ${error.message}`, true);
  }
});

loadTicket();
