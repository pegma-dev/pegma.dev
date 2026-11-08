const flow = document.querySelector('[data-agent-flow]').dataset.agentFlow;
const statusNode = document.querySelector('#agent-status');
const signedOut = document.querySelector('#agent-signed-out');
const panel = document.querySelector('#agent-panel');
const requestPanel = document.querySelector('#agent-request');
const consentForm = document.querySelector('#agent-consent');
const deviceForm = document.querySelector('#agent-device-code');
const userCodeInput = document.querySelector('#agent-user-code');
const grantInput = document.querySelector('#agent-grant-id');
const grantPanel = document.querySelector('#agent-grant');
const revokeButton = document.querySelector('#agent-revoke');
let csrfToken = '';
let approval = null;
let approvalUserCode = '';
let currentGrant = null;
let loadGeneration = 0;
let grantGeneration = 0;
let mutationPending = false;

const messages = {
  forbidden: 'Your current account does not have Admin access.',
  not_found: 'That request or grant is unavailable.',
  expired: 'That request has expired. Start a new connection in your agent.',
  invalid_request: 'Check the request or device code and try again.',
  unavailable: 'Agent access is not available right now.',
  rate_limited: 'Please wait before trying again.',
};

function status(message, error = false) {
  statusNode.textContent = message;
  statusNode.dataset.tone = error ? 'error' : 'neutral';
}

function failure(error) {
  if (error.status === 401) {
    csrfToken = '';
    approval = null;
    currentGrant = null;
    panel.hidden = true;
    signedOut.hidden = false;
    status('Sign in to continue.');
    return;
  }
  if (error.status === 403) {
    approval = null;
    currentGrant = null;
    panel.hidden = true;
  }
  status(
    messages[error.message] ??
      (error.status === 403
        ? messages.forbidden
        : 'The request could not be completed. Refresh and try again.'),
    true,
  );
}

async function api(path, init = {}) {
  const headers = new Headers(init.headers);
  if (init.body !== undefined) headers.set('Content-Type', 'application/json');
  if (csrfToken) headers.set('X-Pegma-CSRF', csrfToken);
  const response = await fetch(path, {
    ...init,
    headers,
    credentials: 'same-origin',
    cache: 'no-store',
    referrerPolicy: 'no-referrer',
  });
  const body = response.status === 204 ? null : await response.json();
  if (!response.ok) {
    const error = new Error(
      typeof body?.error === 'string' ? body.error : 'unavailable',
    );
    error.status = response.status;
    throw error;
  }
  return body;
}

function details(node, entries) {
  node.replaceChildren();
  for (const [label, value] of entries) {
    const term = document.createElement('dt');
    const description = document.createElement('dd');
    term.textContent = label;
    description.textContent = String(value);
    node.append(term, description);
  }
}

function parameter(name) {
  const values = new URLSearchParams(window.location.search).getAll(name);
  return values.length === 1 && values[0].length <= 512 ? values[0] : '';
}

function setMutationPending(pending) {
  mutationPending = pending;
  for (const button of consentForm.querySelectorAll('button'))
    button.disabled = pending || approval?.status !== 'pending';
  revokeButton.disabled =
    pending || currentGrant === null || currentGrant.status === 'revoked';
}

async function loadApproval(selector, userCode = '') {
  const generation = ++loadGeneration;
  approval = null;
  requestPanel.hidden = true;
  status('Loading the request...');
  const result = await api(`/api/agent-access/approval?${selector}`);
  if (generation !== loadGeneration) return;
  if (result.flow !== flow) throw new Error('invalid_request');
  approval = result;
  approvalUserCode = userCode;
  grantInput.value = result.requestId;
  document.querySelector('#agent-client').textContent = result.clientName;
  details(document.querySelector('#agent-details'), [
    ['Client ID', result.clientId],
    ['Resource', result.resource],
    ['Grant / request ID', result.requestId],
    ['Status', result.status],
    ['Expires', result.expiresAt],
  ]);
  const scopes = document.querySelector('#agent-scopes');
  scopes.replaceChildren();
  for (const [index, scope] of result.requestedScopes.entries()) {
    const row = document.createElement('p');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.name = 'scope';
    checkbox.value = scope.name;
    checkbox.id = `agent-scope-${index}`;
    checkbox.checked = true;
    const label = document.createElement('label');
    label.htmlFor = checkbox.id;
    label.textContent = `${scope.description} (${scope.name})`;
    row.append(checkbox, label);
    scopes.append(row);
  }
  requestPanel.hidden = false;
  setMutationPending(mutationPending);
  status(
    result.status === 'pending'
      ? 'Review the request and choose approve or deny.'
      : `This request is ${result.status}.`,
  );
}

consentForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (mutationPending || approval?.status !== 'pending') return;
  const decision = event.submitter?.value;
  if (decision !== 'approve' && decision !== 'deny') return;
  const selected = [
    ...consentForm.querySelectorAll('input[name="scope"]:checked'),
  ].map((input) => input.value);
  if (decision === 'approve' && selected.length === 0) {
    status('Select at least one permission, or deny this request.', true);
    return;
  }
  const request = { requestId: approval.requestId, decision };
  if (decision === 'approve') request.approvedScopes = selected;
  if (flow === 'device_code') request.userCode = approvalUserCode;
  setMutationPending(true);
  try {
    const result = await api('/api/agent-access/approval', {
      method: 'POST',
      body: JSON.stringify(request),
    });
    approval = null;
    requestPanel.hidden = true;
    if (result.flow === 'authorization_code') {
      // Only the server's registered-client callback is used; never a query-string return URL.
      const callback = new URL(result.redirectUri);
      const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(
        callback.hostname,
      );
      if (
        callback.protocol !== 'https:' &&
        !(callback.protocol === 'http:' && loopback)
      )
        throw new Error('invalid_request');
      window.location.assign(callback.href);
      return;
    }
    if (result.flow !== 'device_code') throw new Error('invalid_request');
    window.history.replaceState(null, '', window.location.pathname);
    if (userCodeInput) userCodeInput.value = '';
    status(
      result.approved
        ? 'Approved. Return to your agent to finish connecting. Keep this grant ID for revocation.'
        : 'Request denied.',
    );
  } catch (error) {
    failure(error);
  } finally {
    setMutationPending(false);
  }
});

deviceForm?.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (mutationPending) return;
  const code = userCodeInput.value.trim();
  if (!code) return;
  try {
    await loadApproval(new URLSearchParams({ user_code: code }), code);
  } catch (error) {
    failure(error);
  }
});

document
  .querySelector('#agent-grant-lookup')
  .addEventListener('submit', async (event) => {
    event.preventDefault();
    const id = grantInput.value.trim();
    if (!id || mutationPending) return;
    const generation = ++grantGeneration;
    currentGrant = null;
    grantPanel.hidden = true;
    try {
      const grant = await api(
        `/api/agent-access/grants/${encodeURIComponent(id)}`,
      );
      if (generation !== grantGeneration) return;
      currentGrant = grant;
      grantInput.value = grant.grantId;
      details(document.querySelector('#agent-grant-details'), [
        ['Grant ID', grant.grantId],
        ['Client ID', grant.clientId],
        ['Resource', grant.resource],
        ['Permissions', grant.scopes.map((scope) => scope.name).join(', ')],
        ['Status', grant.status],
        ['Created', grant.createdAt],
        ['Expires', grant.expiresAt],
      ]);
      grantPanel.hidden = false;
      setMutationPending(mutationPending);
      status('Grant loaded.');
    } catch (error) {
      failure(error);
    }
  });

revokeButton.addEventListener('click', async () => {
  if (mutationPending || currentGrant === null) return;
  const id = currentGrant.grantId;
  if (!window.confirm('Revoke this agent grant and its credentials?')) return;
  setMutationPending(true);
  try {
    await api(`/api/agent-access/grants/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    currentGrant = null;
    grantPanel.hidden = true;
    status('Grant revoked.');
  } catch (error) {
    failure(error);
  } finally {
    setMutationPending(false);
  }
});

async function start() {
  const returnTo = `${window.location.pathname}${window.location.search}`;
  document.querySelector('#agent-sign-in').href =
    `/account?${new URLSearchParams({ returnTo })}`;
  try {
    const state = await api('/api/agent-access/state');
    csrfToken = state.csrfToken;
    document.querySelector('#agent-resource').textContent =
      `Protected resource: ${state.resource}`;
    panel.hidden = false;
    if (flow === 'device_code') {
      userCodeInput.value = parameter('user_code');
      status('Enter or confirm the code shown by your agent.');
    } else {
      const requestId = parameter('request_id');
      if (requestId)
        await loadApproval(new URLSearchParams({ request_id: requestId }));
      else
        status(
          'Open the approval link from your registered client, or enter a known grant ID below.',
        );
    }
  } catch (error) {
    failure(error);
  }
}

await start();
