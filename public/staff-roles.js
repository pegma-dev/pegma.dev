const statusNode = document.querySelector('#roles-status');
const signedOut = document.querySelector('#roles-signed-out');
const forbidden = document.querySelector('#roles-forbidden');
const panel = document.querySelector('#roles-panel');
const bootstrapWarning = document.querySelector('#bootstrap-warning');
const lookupForm = document.querySelector('#lookup-form');
const principalInput = document.querySelector('#lookup-principal');
const principalCard = document.querySelector('#principal-card');
const principalEmail = document.querySelector('#principal-email');
const principalMeta = document.querySelector('#principal-meta');
const roleList = document.querySelector('#role-list');
const assignForm = document.querySelector('#assign-form');
const assignRole = document.querySelector('#assign-role');
const historyList = document.querySelector('#history-list');

let csrfToken = '';
let currentPrincipal = '';

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

const MUTATION_ERRORS = {
  last_administrator:
    'Refused: that is the last active administrator. Grant Admin to someone else first.',
  system_managed: 'Refused: that assignment is system-managed.',
  duplicate_role: 'That principal already holds the role.',
  already_revoked: 'That assignment is already revoked.',
  rate_limited: 'Rate limited — wait a moment and try again.',
};

function describeActor(actor) {
  return actor.kind === 'system'
    ? `system:${actor.systemId}`
    : actor.principalId;
}

function renderRoles(roles) {
  roleList.replaceChildren();
  if (roles.length === 0) {
    const empty = document.createElement('li');
    empty.textContent = 'No active roles.';
    roleList.append(empty);
    return;
  }
  for (const role of roles) {
    const li = document.createElement('li');
    const label = document.createElement('strong');
    label.textContent = role.role;
    const meta = document.createElement('span');
    meta.className = 'form-note';
    meta.textContent = ` granted by ${describeActor(role.grantedBy)} · ${
      role.managedBy === 'system' ? 'system-managed' : 'human-managed'
    } `;
    li.append(label, meta);
    if (role.managedBy !== 'system') {
      const revoke = document.createElement('button');
      revoke.type = 'button';
      revoke.className = 'secondary-button';
      revoke.textContent = 'Revoke';
      revoke.addEventListener('click', async () => {
        if (
          !window.confirm(
            `Revoke ${role.role} from this principal? The audited record stays.`,
          )
        ) {
          return;
        }
        try {
          const result = await api(
            `/api/admin/assignments/${encodeURIComponent(role.assignmentId)}`,
            { method: 'DELETE' },
          );
          showStatus(
            result.compensated
              ? 'Revoked — the guard restored the principal to keep an administrator.'
              : 'Revoked.',
          );
          await loadPrincipal(currentPrincipal);
        } catch (error) {
          showStatus(
            MUTATION_ERRORS[error.message] ?? `Revoke failed (${error.message}).`,
            true,
          );
        }
      });
      li.append(revoke);
    }
    roleList.append(li);
  }
}

function renderHistory(events) {
  historyList.replaceChildren();
  if (events.length === 0) {
    const empty = document.createElement('li');
    empty.textContent = 'No role history.';
    historyList.append(empty);
    return;
  }
  for (const event of events) {
    const li = document.createElement('li');
    const when = new Date(event.atEpochMs).toISOString();
    li.textContent = `${when} — ${event.kind} ${event.role} by ${describeActor(
      event.actor,
    )}${event.reason ? ` (${event.reason})` : ''}`;
    historyList.append(li);
  }
}

async function loadPrincipal(principalId) {
  const [detail, history] = await Promise.all([
    api(`/api/admin/principals/${encodeURIComponent(principalId)}`),
    api(`/api/admin/principals/${encodeURIComponent(principalId)}/history`),
  ]);
  currentPrincipal = principalId;
  principalEmail.textContent = detail.principal.email;
  principalMeta.textContent = `${detail.principal.principalId} · ${detail.principal.status} · created ${detail.principal.createdAt}`;
  renderRoles(detail.roles);
  renderHistory(history.events);
  principalCard.hidden = false;
}

lookupForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const principalId = principalInput.value.trim();
  if (principalId === '') {
    return;
  }
  showStatus('Loading principal…');
  try {
    await loadPrincipal(principalId);
    showStatus('Ready.');
  } catch (error) {
    principalCard.hidden = true;
    showStatus(
      error.status === 404
        ? 'No account with that principal id.'
        : `Lookup failed (${error.message}).`,
      true,
    );
  }
});

assignForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (currentPrincipal === '') {
    return;
  }
  const role = assignRole.value;
  if (
    role === 'Admin' &&
    !window.confirm('Grant the Admin role? Admins can change all role assignments.')
  ) {
    return;
  }
  try {
    await api(
      `/api/admin/principals/${encodeURIComponent(currentPrincipal)}/roles`,
      { method: 'POST', body: JSON.stringify({ role }) },
    );
    showStatus(`Assigned ${role}.`);
    await loadPrincipal(currentPrincipal);
  } catch (error) {
    showStatus(
      MUTATION_ERRORS[error.message] ?? `Assign failed (${error.message}).`,
      true,
    );
  }
});

async function boot() {
  hideAll();
  try {
    const state = await api('/api/admin/state');
    csrfToken = state.csrfToken;
    bootstrapWarning.hidden = state.bootstrapArmed !== true;
    panel.hidden = false;
    showStatus('Ready.');
  } catch (error) {
    if (error.status === 401) {
      signedOut.hidden = false;
      showStatus('Signed out.');
      return;
    }
    if (error.status === 403) {
      forbidden.hidden = false;
      showStatus('No admin access.');
      return;
    }
    showStatus(`Admin surface unavailable (${error.message}).`, true);
  }
}

boot();
