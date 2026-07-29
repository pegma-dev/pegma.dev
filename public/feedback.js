const statusNode = document.querySelector('#feedback-status');
const signedOut = document.querySelector('#feedback-signed-out');
const signedIn = document.querySelector('#feedback-signed-in');
const emailNode = document.querySelector('#feedback-email');
const ticketList = document.querySelector('#ticket-list');
const createForm = document.querySelector('#create-ticket');

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
    link.href = `/feedback/${encodeURIComponent(ticket.id)}`;
    link.textContent = `${ticket.marker} ${ticket.subject}`;
    const meta = document.createElement('span');
    meta.className = 'form-note';
    meta.textContent = `${ticket.status} · ${ticket.category ?? 'uncategorized'}`;
    item.append(link, meta);
    ticketList.append(item);
  }
}

async function refreshTickets() {
  const result = await api('/api/support/tickets');
  if (typeof result.csrfToken === 'string') {
    csrfToken = result.csrfToken;
  }
  renderTickets(result.tickets);
}

async function start() {
  try {
    const account = await api('/api/identity/account');
    csrfToken = account.csrfToken;
    emailNode.textContent = account.account.email;
    signedOut.hidden = true;
    signedIn.hidden = false;
    await refreshTickets();
    showStatus('You can submit private feedback.');
  } catch (error) {
    if (error.status === 401) {
      csrfToken = '';
      signedIn.hidden = true;
      signedOut.hidden = false;
      showStatus('Sign in to submit or track feedback.');
      return;
    }
    showStatus(`Feedback is unavailable: ${error.message}`, true);
  }
}

createForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const form = new FormData(createForm);
    showStatus('Submitting ticket…');
    const created = await api('/api/support/tickets', {
      method: 'POST',
      body: JSON.stringify({
        subject: form.get('subject'),
        body: form.get('body'),
        category: form.get('category'),
      }),
    });
    createForm.reset();
    await refreshTickets();
    showStatus(
      `Ticket ${created.ticket.marker} created. Open it from the list below.`,
    );
  } catch (error) {
    showStatus(`Could not create ticket: ${error.message}`, true);
  }
});

start();
