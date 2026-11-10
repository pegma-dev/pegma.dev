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
let approvedLookupSelector = '';

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

function retryMessage(error) {
  return Number.isFinite(error.retryAfterSeconds)
    ? `Too many requests. Try again in ${error.retryAfterSeconds} second(s).`
    : 'Too many requests. Wait before trying again.';
}

function retryAfter(response) {
  const value = response.headers.get('Retry-After');
  if (value === null) return undefined;
  const seconds = /^\d+$/u.test(value)
    ? Number(value)
    : Math.ceil((Date.parse(value) - Date.now()) / 1000);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

async function failure(
  error,
  isCurrent = () => true,
  resource = false,
  acceptedConsent = false,
) {
  if (!isCurrent()) return;
  const prefix = acceptedConsent
    ? 'Consent was accepted, but grant controls could not be loaded. '
    : '';
  if (error.status === 403 && resource) {
    try {
      const state = await api('/api/agent-access/state');
      if (!isCurrent()) return;
      csrfToken = state.csrfToken;
      status(
        `${prefix}That request or grant is not available to this account. Other Admin controls remain available.`,
        true,
      );
      return;
    } catch (authorityError) {
      if (!isCurrent()) return;
      if (authorityError.status !== 401 && authorityError.status !== 403) {
        status(
          `${prefix}${authorityError.status === 429 ? retryMessage(authorityError) : 'Current Admin access could not be checked. Retry the lookup.'}`,
          true,
        );
        return;
      }
      error = authorityError;
    }
  }
  if (!isCurrent()) return;
  if (error.status === 401) {
    ++loadGeneration;
    ++grantGeneration;
    csrfToken = '';
    approval = null;
    currentGrant = null;
    panel.hidden = true;
    signedOut.hidden = false;
    status(`${prefix}Sign in to continue.`);
    return;
  }
  if (error.status === 403) {
    ++loadGeneration;
    ++grantGeneration;
    approval = null;
    currentGrant = null;
    csrfToken = '';
    panel.hidden = true;
  }
  status(
    prefix +
      (error.status === 429
        ? retryMessage(error)
        : (messages[error.message] ??
          (error.status === 403
            ? messages.forbidden
            : 'The request could not be completed. Refresh and try again.'))),
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
    error.retryAfterSeconds = retryAfter(response);
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
  return values.length === 1 && values[0].length <= 128 ? values[0] : '';
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
  const isCurrent = () => generation === loadGeneration;
  approval = null;
  requestPanel.hidden = true;
  status('Loading the request...');
  try {
    const result = await api(`/api/agent-access/approval?${selector}`);
    if (!isCurrent()) return;
    if (result.flow !== flow) throw new Error('invalid_request');
    approval = result;
    approvalUserCode = userCode;
    document.querySelector('#agent-client').textContent = result.clientName;
    details(document.querySelector('#agent-details'), [
      ['Client ID', result.clientId],
      ['Resource', result.resource],
      ['Request ID', result.requestId],
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
  } catch (error) {
    await failure(error, isCurrent, true);
  }
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
  ++loadGeneration;
  ++grantGeneration;
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
    if (result.approved) {
      approvedLookupSelector = request.requestId;
      document.querySelector('#agent-approved-grant').hidden = false;
      await loadGrant(approvedLookupSelector, true);
    } else status('Request denied.');
  } catch (error) {
    await failure(error, () => true, true);
  } finally {
    setMutationPending(false);
  }
});

deviceForm?.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (mutationPending) return;
  const code = userCodeInput.value.trim();
  if (!code || code.length > 128) return;
  await loadApproval(new URLSearchParams({ user_code: code }), code);
});

async function loadGrant(id, acceptedConsent = false) {
  const generation = ++grantGeneration;
  const isCurrent = () => generation === grantGeneration;
  currentGrant = null;
  grantPanel.hidden = true;
  try {
    const grant = await api(
      `/api/agent-access/grants/${encodeURIComponent(id)}`,
    );
    if (!isCurrent()) return;
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
    document.querySelector('#agent-grant-instructions').textContent =
      `Grant ID: ${grant.grantId}. Use this ID in the lookup form or choose Revoke this grant below. Status: ${grant.status}.`;
    setMutationPending(mutationPending);
    if (acceptedConsent)
      document.querySelector('#agent-approved-grant').hidden = true;
    status(
      acceptedConsent
        ? 'Consent accepted and grant controls loaded. Return to your agent to finish connecting. The exact grant ID and revocation controls are below.'
        : 'Grant loaded.',
    );
  } catch (error) {
    await failure(error, isCurrent, true, acceptedConsent);
  }
}

document
  .querySelector('#agent-approved-grant')
  .addEventListener('click', async () => {
    if (!approvedLookupSelector || mutationPending) return;
    await loadGrant(approvedLookupSelector, true);
  });

document
  .querySelector('#agent-grant-lookup')
  .addEventListener('submit', async (event) => {
    event.preventDefault();
    const id = grantInput.value.trim();
    if (!id || id.length > 128 || mutationPending) return;
    await loadGrant(id);
  });

revokeButton.addEventListener('click', async () => {
  if (mutationPending || currentGrant === null) return;
  const id = currentGrant.grantId;
  if (!window.confirm('Revoke this agent grant and its credentials?')) return;
  ++loadGeneration;
  const generation = ++grantGeneration;
  const isCurrent = () => generation === grantGeneration;
  setMutationPending(true);
  try {
    await api(`/api/agent-access/grants/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    if (!isCurrent()) return;
    currentGrant = null;
    grantPanel.hidden = true;
    status('Grant revoked.');
  } catch (error) {
    await failure(error, isCurrent, true);
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
    await failure(error);
  }
}

await start();
