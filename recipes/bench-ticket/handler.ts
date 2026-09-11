/**
 * Fetch-API HTTP host for Bench Ticket. Used by the Node Docker process and
 * the Cloudflare Worker. Not pegma.dev’s production routes.
 */
import { IdentityError } from '@pegma/identity';
import {
  SupportDeskAuthorizationError,
  SupportDeskConflictError,
  SupportDeskLimitError,
  SupportDeskNotFoundError,
} from '@pegma/support-desk-application';
import type { PrincipalId } from '@pegma/spine';
import {
  openBenchTicketSession,
  type BenchTicketComposition,
} from './composition';

export const SESSION_COOKIE = 'bench_ticket_session';

const PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Bench Ticket</title>
  <style>
    :root { color-scheme: light dark; --ink:#2c2c2c; --line:#e3e5e9; --paper:#f7f8fa; }
    body { font-family: system-ui, sans-serif; margin: 0; background: var(--paper); color: var(--ink); }
    main { max-width: 40rem; margin: 0 auto; padding: 1.5rem; }
    h1 { font-size: 1.5rem; }
    label { display: block; font-weight: 650; margin: 0.75rem 0 0.25rem; }
    input, textarea { width: 100%; box-sizing: border-box; padding: 0.55rem 0.65rem; }
    textarea { min-height: 6rem; }
    button { margin: 0.5rem 0.4rem 0.5rem 0; padding: 0.45rem 0.8rem; }
    .notice { background: #fff3; border: 1px solid var(--line); padding: 0.75rem 1rem; }
    .ticket { border: 1px solid var(--line); padding: 0.75rem; margin: 0.5rem 0; }
    .muted { color: #5c6570; font-size: 0.9rem; }
    [hidden] { display: none !important; }
  </style>
</head>
<body>
  <main>
    <h1>Bench Ticket</h1>
    <p class="muted">Makerspace helpdesk demo — email-code login, then file and reply to a ticket. Codes land in Mailpit (local) or process logs (cloud).</p>
    <p id="status" class="notice"></p>
    <section id="auth">
      <label for="email">Email</label>
      <input id="email" type="email" autocomplete="username" />
      <button type="button" id="create">Create account</button>
      <button type="button" id="signin">Sign in</button>
      <div id="code-row" hidden>
        <label for="code">One-time code</label>
        <input id="code" inputmode="numeric" autocomplete="one-time-code" />
        <button type="button" id="verify">Verify code</button>
      </div>
    </section>
    <section id="desk" hidden>
      <p>Signed in as <strong id="who"></strong> <button type="button" id="signout">Sign out</button></p>
      <h2>File a ticket</h2>
      <label for="subject">Subject</label>
      <input id="subject" />
      <label for="body">Body</label>
      <textarea id="body"></textarea>
      <button type="button" id="file">File ticket</button>
      <h2>Your queue</h2>
      <div id="tickets"></div>
    </section>
  </main>
  <script>
    const status = document.getElementById('status');
    const auth = document.getElementById('auth');
    const desk = document.getElementById('desk');
    const codeRow = document.getElementById('code-row');
    let flow = 'create';
    let codeHandle = '';
    function setStatus(text) { status.textContent = text; }
    async function api(path, options) {
      const res = await fetch(path, options);
      const text = await res.text();
      let data = {};
      try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text }; }
      if (!res.ok) throw new Error(data.error || res.statusText);
      return data;
    }
    async function refresh() {
      try {
        const me = await api('/api/me');
        auth.hidden = true;
        desk.hidden = false;
        document.getElementById('who').textContent = me.principalId;
        const listed = await api('/api/tickets');
        const root = document.getElementById('tickets');
        root.replaceChildren();
        for (const row of listed.tickets) {
          const el = document.createElement('div');
          el.className = 'ticket';
          const title = document.createElement('strong');
          title.textContent = '#' + row.number;
          const subject = document.createTextNode(' ' + row.subject + ' ');
          const status = document.createElement('span');
          status.className = 'muted';
          status.textContent = String(row.status);
          const replyWrap = document.createElement('div');
          const textarea = document.createElement('textarea');
          textarea.dataset.reply = String(row.id);
          textarea.placeholder = 'Reply';
          const button = document.createElement('button');
          button.type = 'button';
          button.dataset.send = String(row.id);
          button.textContent = 'Reply';
          replyWrap.append(textarea, button);
          el.append(title, subject, status, replyWrap);
          root.appendChild(el);
        }
        root.onclick = async (event) => {
          const send = event.target.getAttribute('data-send');
          if (!send) return;
          const textarea = root.querySelector('[data-reply="' + send + '"]');
          await api('/api/tickets/' + encodeURIComponent(send) + '/replies', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ body: textarea.value }),
          });
          setStatus('Reply saved.');
          await refresh();
        };
      } catch {
        auth.hidden = false;
        desk.hidden = true;
      }
    }
    async function begin(kind) {
      flow = kind;
      const email = document.getElementById('email').value;
      const data = await api('/api/auth/begin', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, flow: kind }),
      });
      codeHandle = data.codeHandle;
      codeRow.hidden = false;
      setStatus('Code sent. Check Mailpit at http://localhost:8025 or the process logs, then verify.');
    }
    document.getElementById('create').onclick = () => begin('create').catch((err) => setStatus(err.message));
    document.getElementById('signin').onclick = () => begin('signin').catch((err) => setStatus(err.message));
    document.getElementById('verify').onclick = async () => {
      try {
        await api('/api/auth/finish', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            flow,
            codeHandle,
            code: document.getElementById('code').value,
          }),
        });
        setStatus('Signed in.');
        await refresh();
      } catch (err) { setStatus(err.message); }
    };
    document.getElementById('signout').onclick = async () => {
      await api('/api/auth/signout', { method: 'POST' });
      setStatus('Signed out.');
      await refresh();
    };
    document.getElementById('file').onclick = async () => {
      try {
        await api('/api/tickets', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            subject: document.getElementById('subject').value,
            body: document.getElementById('body').value,
            category: 'general',
          }),
        });
        document.getElementById('subject').value = '';
        document.getElementById('body').value = '';
        setStatus('Ticket filed.');
        await refresh();
      } catch (err) { setStatus(err.message); }
    };
    refresh().catch(() => {});
  </script>
</body>
</html>
`;

function json(
  status: number,
  body: unknown,
  headers?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

function decodeUriComponentSafe(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key.length === 0) continue;
    const decoded = decodeUriComponentSafe(value);
    if (decoded === null) continue;
    out[key] = decoded;
  }
  return out;
}

function sessionCookie(sessionId: string, origin: string): string {
  const secure = origin.startsWith('https:');
  return `${SESSION_COOKIE}=${encodeURIComponent(sessionId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800${secure ? '; Secure' : ''}`;
}

function clearSessionCookie(origin: string): string {
  const secure = origin.startsWith('https:');
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
}

function mintId(): string {
  return crypto.randomUUID();
}

function mintSessionId(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function mapError(error: unknown): Response {
  if (error instanceof IdentityError) {
    const status =
      error.code === 'rate_limited'
        ? 429
        : error.code === 'verification_failed' || error.code === 'invalid_input'
          ? 400
          : error.code === 'not_found'
            ? 404
            : error.code === 'conflict'
              ? 409
              : 400;
    return json(status, { error: error.code });
  }
  if (error instanceof SupportDeskAuthorizationError) {
    return json(403, { error: 'forbidden' });
  }
  if (error instanceof SupportDeskNotFoundError) {
    return json(404, { error: 'not_found' });
  }
  if (error instanceof SupportDeskConflictError) {
    return json(409, { error: 'conflict' });
  }
  if (error instanceof SupportDeskLimitError) {
    return json(413, { error: 'limit_exceeded' });
  }
  return json(500, { error: 'internal_error' });
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (text.trim().length === 0) return {};
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new IdentityError('invalid_input', 'JSON object required.');
  }
  return parsed as Record<string, unknown>;
}

async function currentPrincipal(
  request: Request,
  composition: BenchTicketComposition,
): Promise<PrincipalId | null> {
  const cookies = parseCookies(request.headers.get('cookie'));
  const sessionId = cookies[SESSION_COOKIE];
  if (!sessionId) return null;
  const session = await composition.sessions.get(sessionId);
  return session?.principalId ?? null;
}

async function drainMail(composition: BenchTicketComposition): Promise<void> {
  await composition.mailWorker.runSendPage({ limit: 20 });
}

export async function handleBenchTicketRequest(
  request: Request,
  composition: BenchTicketComposition,
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method.toUpperCase();

  try {
    if (method === 'GET' && (path === '/' || path === '/index.html')) {
      return new Response(PAGE_HTML, {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }
    if (method === 'GET' && path === '/health') {
      const health = await composition.health();
      return json(health.status, health.body);
    }

    if (method === 'POST' && path === '/api/auth/begin') {
      const body = await readJson(request);
      const email = String(body.email ?? '');
      const flow = body.flow === 'signin' ? 'signin' : 'create';
      const rateLimitKey = request.headers.get('cf-connecting-ip') ?? 'local';
      const started =
        flow === 'signin'
          ? await composition.identity.beginEmailSignIn(email, rateLimitKey)
          : await composition.identity.beginAccountCreation(email, rateLimitKey);
      await drainMail(composition);
      return json(200, { codeHandle: started.codeHandle, expiresAt: started.expiresAt });
    }

    if (method === 'POST' && path === '/api/auth/finish') {
      const body = await readJson(request);
      const flow = body.flow === 'signin' ? 'signin' : 'create';
      const input = {
        codeHandle: String(body.codeHandle ?? ''),
        code: String(body.code ?? ''),
        rateLimitKey: request.headers.get('cf-connecting-ip') ?? 'local',
      };
      const claims =
        flow === 'signin'
          ? await composition.identity.finishEmailSignIn(input)
          : await composition.identity.finishAccountCreation(input);
      const sessionId = mintSessionId();
      await openBenchTicketSession(composition, sessionId, claims);
      return json(
        200,
        { principalId: claims.subject },
        { 'set-cookie': sessionCookie(sessionId, composition.origin) },
      );
    }

    if (method === 'POST' && path === '/api/auth/signout') {
      const cookies = parseCookies(request.headers.get('cookie'));
      const sessionId = cookies[SESSION_COOKIE];
      if (sessionId) await composition.sessions.destroy(sessionId);
      return json(200, { ok: true }, { 'set-cookie': clearSessionCookie(composition.origin) });
    }

    if (method === 'GET' && path === '/api/me') {
      const principalId = await currentPrincipal(request, composition);
      if (!principalId) return json(401, { error: 'unauthenticated' });
      const user = await composition.identity.getUser(principalId);
      return json(200, { principalId, email: user?.email ?? null });
    }

    if (method === 'GET' && path === '/api/tickets') {
      const principalId = await currentPrincipal(request, composition);
      if (!principalId) return json(401, { error: 'unauthenticated' });
      const tickets = await composition.support.listCustomerTickets(
        composition.customerAccess(principalId),
      );
      return json(200, { tickets });
    }

    if (method === 'POST' && path === '/api/tickets') {
      const principalId = await currentPrincipal(request, composition);
      if (!principalId) return json(401, { error: 'unauthenticated' });
      const body = await readJson(request);
      const created = await composition.support.createCustomerTicket(
        composition.customerAccess(principalId),
        {
          commandId: mintId(),
          correlationId: mintId(),
          ticketId: mintId(),
          messageId: mintId(),
          subject: String(body.subject ?? ''),
          body: String(body.body ?? ''),
          ...(typeof body.category === 'string' ? { category: body.category } : {}),
        },
      );
      return json(201, created);
    }

    const ticketMatch = /^\/api\/tickets\/([^/]+)$/.exec(path);
    if (method === 'GET' && ticketMatch) {
      const principalId = await currentPrincipal(request, composition);
      if (!principalId) return json(401, { error: 'unauthenticated' });
      const ticketId = decodeUriComponentSafe(ticketMatch[1] ?? '');
      if (ticketId === null) return json(400, { error: 'invalid_ticket_id' });
      const view = await composition.support.readCustomerTicket(
        composition.customerAccess(principalId),
        ticketId,
      );
      return json(200, view);
    }

    const replyMatch = /^\/api\/tickets\/([^/]+)\/replies$/.exec(path);
    if (method === 'POST' && replyMatch) {
      const principalId = await currentPrincipal(request, composition);
      if (!principalId) return json(401, { error: 'unauthenticated' });
      const ticketId = decodeUriComponentSafe(replyMatch[1] ?? '');
      if (ticketId === null) return json(400, { error: 'invalid_ticket_id' });
      const body = await readJson(request);
      const replied = await composition.support.replyToCustomerTicket(
        composition.customerAccess(principalId),
        {
          commandId: mintId(),
          correlationId: mintId(),
          ticketId,
          messageId: mintId(),
          body: String(body.body ?? ''),
        },
      );
      return json(200, replied);
    }

    return json(404, { error: 'not_found' });
  } catch (error) {
    if (error instanceof SyntaxError) {
      return json(400, { error: 'invalid_json' });
    }
    return mapError(error);
  }
}
