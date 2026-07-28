const statusNode = document.querySelector('#account-status');
const signedOut = document.querySelector('#signed-out');
const signedIn = document.querySelector('#signed-in');
const passkeySignIn = document.querySelector('#passkey-sign-in');
const emailStart = document.querySelector('#email-start');
const emailFinish = document.querySelector('#email-finish');
const emailAvailability = document.querySelector('#email-availability');
const accountEmail = document.querySelector('#account-email-display');
const passkeyList = document.querySelector('#passkey-list');
const addPasskey = document.querySelector('#add-passkey');
const signOut = document.querySelector('#sign-out');

let csrfToken = '';
let emailChallengeHandle = '';
let passkeyRemovalAvailable = false;

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

function bytesToBase64Url(value) {
  const bytes = new Uint8Array(value);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
}

function base64UrlToBytes(value) {
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/');
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function registrationOptions(options) {
  return {
    ...options,
    challenge: base64UrlToBytes(options.challenge),
    user: {
      ...options.user,
      id: base64UrlToBytes(options.user.id),
    },
    excludeCredentials: (options.excludeCredentials ?? []).map(
      (credential) => ({
        ...credential,
        id: base64UrlToBytes(credential.id),
      }),
    ),
  };
}

function authenticationOptions(options) {
  return {
    ...options,
    challenge: base64UrlToBytes(options.challenge),
    allowCredentials: (options.allowCredentials ?? []).map((credential) => ({
      ...credential,
      id: base64UrlToBytes(credential.id),
    })),
  };
}

function credentialBase(credential) {
  return {
    id: credential.id,
    rawId: bytesToBase64Url(credential.rawId),
    type: credential.type,
    authenticatorAttachment: credential.authenticatorAttachment,
    clientExtensionResults: credential.getClientExtensionResults(),
  };
}

function registrationResponse(credential) {
  return {
    ...credentialBase(credential),
    response: {
      clientDataJSON: bytesToBase64Url(credential.response.clientDataJSON),
      attestationObject: bytesToBase64Url(
        credential.response.attestationObject,
      ),
      transports:
        typeof credential.response.getTransports === 'function'
          ? credential.response.getTransports()
          : [],
    },
  };
}

function authenticationResponse(credential) {
  return {
    ...credentialBase(credential),
    response: {
      clientDataJSON: bytesToBase64Url(credential.response.clientDataJSON),
      authenticatorData: bytesToBase64Url(
        credential.response.authenticatorData,
      ),
      signature: bytesToBase64Url(credential.response.signature),
      userHandle:
        credential.response.userHandle === null
          ? undefined
          : bytesToBase64Url(credential.response.userHandle),
    },
  };
}

function renderPasskeys(passkeys) {
  passkeyList.replaceChildren();
  if (passkeys.length === 0) {
    const empty = document.createElement('li');
    empty.textContent = 'No passkeys registered yet.';
    passkeyList.append(empty);
    return;
  }
  for (const passkey of passkeys) {
    const item = document.createElement('li');
    const details = document.createElement('span');
    const used =
      passkey.lastUsedAt === null
        ? 'not used yet'
        : `last used ${new Date(passkey.lastUsedAt).toLocaleDateString()}`;
    details.textContent = `${passkey.label} — ${used}`;
    item.append(details);
    if (passkeyRemovalAvailable) {
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'text-button';
      remove.textContent = 'Remove';
      remove.addEventListener('click', async () => {
        try {
          await api('/api/identity/passkeys', {
            method: 'DELETE',
            body: JSON.stringify({ credentialId: passkey.credentialId }),
          });
          await refreshAccount();
          showStatus('Passkey removed.');
        } catch (error) {
          showStatus(`Could not remove passkey: ${error.message}`, true);
        }
      });
      item.append(remove);
    }
    passkeyList.append(item);
  }
}

async function refreshAccount() {
  try {
    const result = await api('/api/identity/account');
    csrfToken = result.csrfToken;
    accountEmail.textContent = result.account.email;
    renderPasskeys(result.passkeys);
    signedOut.hidden = true;
    signedIn.hidden = false;
    showStatus('Your account is ready.');
    return true;
  } catch (error) {
    if (error.status !== 401) {
      throw error;
    }
    csrfToken = '';
    signedIn.hidden = true;
    signedOut.hidden = false;
    return false;
  }
}

passkeySignIn.addEventListener('click', async () => {
  try {
    if (!window.PublicKeyCredential) {
      throw new Error('This browser does not support passkeys.');
    }
    showStatus('Waiting for your passkey…');
    const started = await api('/api/identity/passkeys/authentication/options', {
      method: 'POST',
      body: '{}',
    });
    const credential = await navigator.credentials.get({
      publicKey: authenticationOptions(started.options),
    });
    if (!(credential instanceof PublicKeyCredential)) {
      throw new Error('Passkey sign-in was cancelled.');
    }
    const completed = await api(
      '/api/identity/passkeys/authentication/verify',
      {
        method: 'POST',
        body: JSON.stringify({
          challengeHandle: started.challengeHandle,
          response: authenticationResponse(credential),
        }),
      },
    );
    csrfToken = completed.csrfToken;
    await refreshAccount();
  } catch (error) {
    showStatus(`Passkey sign-in failed: ${error.message}`, true);
  }
});

emailStart.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    showStatus('Requesting a verification code…');
    const form = new FormData(emailStart);
    const started = await api('/api/identity/email-code/options', {
      method: 'POST',
      body: JSON.stringify({ email: form.get('email') }),
    });
    emailChallengeHandle = started.challengeHandle;
    emailFinish.hidden = false;
    showStatus('If that address can receive a code, it is on the way.');
  } catch (error) {
    showStatus(`Email sign-in is unavailable: ${error.message}`, true);
  }
});

emailFinish.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const form = new FormData(emailFinish);
    const completed = await api('/api/identity/email-code/verify', {
      method: 'POST',
      body: JSON.stringify({
        challengeHandle: emailChallengeHandle,
        code: form.get('code'),
      }),
    });
    csrfToken = completed.csrfToken;
    await refreshAccount();
  } catch (error) {
    showStatus(`Code verification failed: ${error.message}`, true);
  }
});

addPasskey.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    showStatus('Waiting for your new passkey…');
    const form = new FormData(addPasskey);
    const started = await api('/api/identity/passkeys/registration/options', {
      method: 'POST',
      body: '{}',
    });
    const credential = await navigator.credentials.create({
      publicKey: registrationOptions(started.options),
    });
    if (!(credential instanceof PublicKeyCredential)) {
      throw new Error('Passkey registration was cancelled.');
    }
    await api('/api/identity/passkeys/registration/verify', {
      method: 'POST',
      body: JSON.stringify({
        challengeHandle: started.challengeHandle,
        label: form.get('label'),
        response: registrationResponse(credential),
      }),
    });
    addPasskey.reset();
    await refreshAccount();
    showStatus('Passkey added.');
  } catch (error) {
    showStatus(`Could not add passkey: ${error.message}`, true);
  }
});

signOut.addEventListener('click', async () => {
  try {
    await api('/api/identity/logout', { method: 'POST', body: '{}' });
    csrfToken = '';
    signedIn.hidden = true;
    signedOut.hidden = false;
    showStatus('Signed out.');
  } catch (error) {
    showStatus(`Could not sign out: ${error.message}`, true);
  }
});

async function start() {
  try {
    const capabilities = await api('/api/identity/capabilities');
    passkeyRemovalAvailable = capabilities.emailCode;
    passkeySignIn.disabled = !capabilities.passkeys;
    emailStart.querySelector('button').disabled = !capabilities.emailCode;
    emailAvailability.textContent = capabilities.emailCode
      ? 'Codes are delivered by the configured provider.'
      : 'Email-code delivery is not enabled yet.';
    const authenticated = await refreshAccount();
    if (!authenticated) {
      showStatus(
        capabilities.passkeys
          ? 'Choose a passwordless sign-in method.'
          : 'Identity is being prepared for its first public release.',
      );
    }
  } catch {
    signedOut.hidden = false;
    showStatus('The identity service is temporarily unavailable.', true);
  }
}

await start();
