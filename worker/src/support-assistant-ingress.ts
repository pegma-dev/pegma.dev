import {
  bestEffortSupportAssistantHint,
  supportAssistantAcceptedTarget,
} from './support-assistant';
import { supportPermissions } from '@pegma/support-desk-application';
import type { Logger } from '@pegma/spine';
import type { IdentityUser } from './identity-contracts';
import {
  ApiError,
  authenticate,
  boundedString,
  enforceRateLimit,
  json,
  optionalKeysObject,
  readJson,
} from './api-auth';
import { createAgentPrincipalResolver } from './agent-authority';
import { supportHumanBrowser } from './support-human-auth';
import {
  supportBrowserCommand,
  SUPPORT_BROWSER_COMMAND_HEADER,
} from './support-browser-commands';
import {
  mapSupportError,
  PEGMA_SUPPORT_CATEGORY_SET,
  type SupportRuntime,
} from './support-desk';
import { publicTicketView } from './support-api';
import type { SupportAnsweringRuntime } from './support-assistant-composition';

export const SUPPORT_ANSWERING_NAMESPACE = '/api/support/assistant/';

/** Current browser-only ingress. SDK receipts own replay; the host stores no command or grant. */
export function createSupportAnsweringIngress(
  runtime: SupportRuntime,
  logger: Logger,
  answering: SupportAnsweringRuntime,
) {
  return async (request: Request): Promise<Response> => {
    const correlationId = crypto.randomUUID();
    const url = new URL(request.url);
    if (
      url.search !== '' ||
      ![
        '/api/support/assistant/capability',
        '/api/support/assistant/tickets',
      ].includes(url.pathname)
    )
      return json({ error: 'not_found' }, { status: 404 });
    const capability = url.pathname.endsWith('/capability');
    if (request.method !== (capability ? 'GET' : 'POST'))
      return json({ error: 'method_not_allowed' }, { status: 405 });
    const started = performance.now();
    const controller = new AbortController();
    let rejectStopped: (error: ApiError) => void = () => {};
    const stopped = new Promise<never>((_resolve, reject) => {
      rejectStopped = reject;
    });
    const stop = () => {
      controller.abort();
      rejectStopped(new ApiError(503, 'acknowledgement_unknown'));
    };
    const timer = setTimeout(stop, 25_000);
    if (request.signal.aborted) stop();
    else request.signal.addEventListener('abort', stop, { once: true });
    const headerValues = () =>
      [
        'Cookie',
        'Origin',
        'X-Pegma-CSRF',
        'Authorization',
        'Sec-Fetch-Site',
        SUPPORT_BROWSER_COMMAND_HEADER,
      ].map((name) => request.headers.get(name));
    const originalHeaders = JSON.stringify(headerValues());
    const sync = () => {
      if (
        controller.signal.aborted ||
        performance.now() - started >= 25_000 ||
        JSON.stringify(headerValues()) !== originalHeaders
      )
        throw new ApiError(403, 'browser_credential_changed');
      return true as const;
    };
    let email: string | undefined;
    // This slot belongs to one current() call in this request. Contact is read
    // after the resolver's actual role await, beside its verified claims read,
    // and before the browser's closing SessionStore read. It is never a cache.
    let contactObservation: { user?: IdentityUser | null } | undefined;
    const resolve = createAgentPrincipalResolver({
      ...runtime,
      identity: {
        ...runtime.identity,
        async claimsFor(principalId) {
          const observed = contactObservation;
          if (observed === undefined)
            return runtime.identity.claimsFor(principalId);
          const [claims, user] = await Promise.all([
            runtime.identity.claimsFor(principalId),
            runtime.identity.getUser(principalId),
          ]);
          observed.user = user;
          return claims;
        },
      },
    });
    const browser = supportHumanBrowser(request, {
      sessions: runtime.sessions,
      mutation: !capability,
      permission: supportPermissions.create,
      async authenticate(incoming) {
        const actual = await authenticate(incoming, { ...runtime, logger });
        if (actual === null) throw new ApiError(401, 'authentication_required');
        email = actual.user.email;
        return actual;
      },
      async access(coordinates) {
        const access = await resolve(coordinates.link.subject);
        if (access === null) throw new ApiError(401, 'authentication_required');
        return access;
      },
    });
    async function current(withContact = false) {
      const observation: { user?: IdentityUser | null } | undefined =
        withContact ? {} : undefined;
      contactObservation = observation;
      try {
        const value = await browser.current();
        sync();
        return { ...value, contact: observation?.user };
      } finally {
        if (contactObservation === observation) contactObservation = undefined;
      }
    }
    async function execute() {
      try {
        const initial = await current();
        if (capability) {
          const available = await answering.admission(
            initial.access.principalId,
          );
          const final = await current();
          available?.assertCurrent(final.access);
          return json({
            enabled: available !== null,
            ...(available === null
              ? {}
              : { disclosureVersion: answering.disclosureVersion }),
            csrfToken: final.authenticated.csrfToken,
          });
        }
        if (request.headers.get(SUPPORT_BROWSER_COMMAND_HEADER) !== '1')
          throw new ApiError(400, 'invalid_request');
        await enforceRateLimit(
          runtime.createLimiter,
          initial.access.principalId,
        );
        const body = optionalKeysObject(
          await readJson(request, { timeoutMs: 10_000 }),
          ['command', 'subject', 'body', 'category', 'preference'],
          ['disclosureVersion'],
        );
        const actor = await current();
        const { expectedRequesterEmail, ...command } = supportBrowserCommand(
          body.command,
          actor.access.principalId,
          'create',
        );
        if (
          body.preference !== 'human' &&
          body.preference !== 'assistant_if_available'
        )
          throw new ApiError(400, 'invalid_request');
        const preference = body.preference;
        const disclosureVersion =
          body.disclosureVersion === undefined
            ? undefined
            : boundedString(body.disclosureVersion, 1, 200);
        const subject = boundedString(body.subject, 1, 200);
        const text = boundedString(body.body, 1, 20_000, {
          allowMultiline: true,
        });
        const category = boundedString(body.category, 1, 200);
        if (!PEGMA_SUPPORT_CATEGORY_SET.has(category))
          throw new ApiError(400, 'invalid_request');
        // A changed contact admits only exact accepted recovery. Do not pre-read
        // the target or renew route/disclosure before the SDK receipt lookup.
        const fresh = expectedRequesterEmail === email;
        let admission: Awaited<
          ReturnType<SupportAnsweringRuntime['admission']>
        > = null;
        const result = await runtime.application.createAdmittedCustomerTicket(
          actor.access,
          {
            ...command,
            correlationId: command.commandId,
            subject,
            body: text,
            category,
            preference,
            ...(disclosureVersion === undefined ? {} : { disclosureVersion }),
            ...(expectedRequesterEmail === null
              ? {}
              : { requesterEmail: expectedRequesterEmail }),
          },
          fresh
            ? {
                signal: controller.signal,
                async resolveAssistantStart() {
                  if (
                    !answering.admissionEnabled() ||
                    disclosureVersion !== answering.disclosureVersion
                  )
                    return null;
                  admission = await answering.admission(
                    actor.access.principalId,
                  );
                  return admission?.access ?? null;
                },
                async verifyBeforeCommit(mode) {
                  let finalAdmission: typeof admission = null;
                  if (mode === 'assistant') {
                    const latest = await answering.admission(
                      actor.access.principalId,
                    );
                    if (
                      latest === null ||
                      admission === null ||
                      latest.binding !== admission.binding ||
                      disclosureVersion !== answering.disclosureVersion
                    )
                      throw new ApiError(409, 'admission_changed');
                    finalAdmission = latest;
                  }
                  // Only fresh SDK creates reach this guard. The same existing
                  // contact read now joins the closing Identity wave AFTER roles;
                  // exact accepted receipts never depend on today's contact.
                  const finalBrowser = await current(true);
                  const user = finalBrowser.contact;
                  if (
                    user === undefined ||
                    user === null ||
                    user.principalId !== actor.access.principalId ||
                    user.status !== 'active' ||
                    user.emailVerified !== true
                  )
                    throw new ApiError(401, 'authentication_required');
                  if (typeof user.email !== 'string' || user.email.length === 0)
                    throw new ApiError(503, 'service_unavailable');
                  if (user.email !== expectedRequesterEmail)
                    throw new ApiError(409, 'contact_changed');
                  sync();
                  return () => {
                    sync();
                    if (mode === 'assistant' && !answering.admissionEnabled())
                      throw new ApiError(409, 'admission_changed');
                    finalAdmission?.assertCurrent(finalBrowser.access);
                    return true;
                  };
                },
              }
            : undefined,
        );
        // Leave closing browser budget intact. Hints never turn a known ACK
        // into an unknown result and never carry a browser actor or body.
        const acceptedTarget = supportAssistantAcceptedTarget(
          result.view,
          command.messageId,
        );
        if (
          result.initialMode === 'assistant' &&
          acceptedTarget !== undefined &&
          performance.now() - started < 23_500
        )
          await bestEffortSupportAssistantHint(
            answering.hintAccepted,
            acceptedTarget,
          );
        const final = await current();
        return json(
          {
            ...publicTicketView(result.view),
            initialMode: result.initialMode,
            csrfToken: final.authenticated.csrfToken,
          },
          { status: 201 },
        );
      } catch (error) {
        if (error instanceof ApiError)
          return json(
            { error: error.code },
            {
              status: error.status,
              ...(error.retryAfterSeconds === undefined
                ? {}
                : {
                    headers: { 'Retry-After': String(error.retryAfterSeconds) },
                  }),
            },
          );
        const mapped = mapSupportError(error);
        if (mapped.status >= 500)
          logger.log('error', 'support.answering_ingress_unavailable', {
            correlationId,
          });
        return json(
          {
            error: mapped.code,
            ...(mapped.status >= 500 ? { correlationId } : {}),
          },
          { status: mapped.status === 500 ? 503 : mapped.status },
        );
      }
    }
    try {
      return await Promise.race([execute(), stopped]);
    } catch {
      logger.log('warn', 'support.answering_ingress_unavailable', {
        correlationId,
      });
      return json(
        { error: 'acknowledgement_unknown', correlationId },
        { status: 503 },
      );
    } finally {
      clearTimeout(timer);
      request.signal.removeEventListener('abort', stop);
    }
  };
}
