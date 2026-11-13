import { hasPermission, type AccessContext } from '@pegma/authorization-core';
import type { DurableRateLimiter } from '@pegma/rate-limit';
import {
  supportPermissions,
  type EngineeringFollowupCandidate,
  type EngineeringFollowupWorkRecord,
} from '@pegma/support-desk-application';
import {
  createAgentPrincipalResolver,
  type AgentBrowserOptions,
} from './agent-authority';
import {
  ApiError,
  authenticate,
  boundedString,
  enforceRateLimit,
  exactObject,
  json,
  optionalKeysObject,
  readJson,
} from './api-auth';
import { mapSupportError } from './support-desk';
import { supportHumanBrowser } from './support-human-auth';
import { supportReleaseFollowupIdentity } from './support-release-followup-ports';
import type { SupportReleaseFollowupRuntime } from './support-release-followup';
import {
  verifySupportFollowupMappingInput,
  withdrawSupportFollowupMappingInput,
  type SupportFollowupMappings,
} from './support-release-followup-mapping';
import { prepareSupportFollowupRetestInput, type SupportFollowupRetests } from './support-release-followup-retests';

export interface SupportReleaseFollowupHandlerOptions extends AgentBrowserOptions {
  readonly enabled: () => boolean;
  readonly runtime: () => SupportReleaseFollowupRuntime;
  readonly mappings?: SupportFollowupMappings;
  readonly retests?: SupportFollowupRetests;
  readonly readLimiter: DurableRateLimiter;
  readonly mutationLimiter: DurableRateLimiter;
}
const namespace =
  /^\/api\/support\/admin\/tickets\/[A-Za-z0-9._~-]{1,200}\/follow-up(?:\/|$)/u;
const route =
  /^\/api\/support\/admin\/tickets\/([A-Za-z0-9._~-]{1,200})\/follow-up\/(scan|work|observe|reassess|post|reject|retry|abandon|mapping|verify-mapping|withdraw-mapping|retest-receipt|retest)$/u;
export function isSupportReleaseFollowupRequest(path: string) {
  return namespace.test(path);
}

function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
    throw new ApiError(400, 'invalid_request');
  return value;
}
function text(value: unknown, maximum = 200): string {
  return boundedString(value, 1, maximum);
}
function hash(value: unknown): string {
  const result = text(value, 64);
  if (!/^[a-f0-9]{64}$/u.test(result))
    throw new ApiError(400, 'invalid_request');
  return result;
}
function lines(value: unknown, maximum: number): string[] {
  if (!Array.isArray(value) || value.length > maximum)
    throw new ApiError(400, 'invalid_request');
  return value.map((entry) =>
    boundedString(entry, 1, 2_000, { allowMultiline: true }),
  );
}
function candidate(raw: unknown): EngineeringFollowupCandidate {
  const row = exactObject(raw, [
    'customerDraft',
    'kbProposal',
    'retestRequests',
  ]);
  const draft = exactObject(row.customerDraft, ['body']);
  const kb =
    row.kbProposal === null
      ? null
      : exactObject(row.kbProposal, [
          'summary',
          'changes',
          'advisoryValidationRequirements',
        ]);
  if (!Array.isArray(row.retestRequests) || row.retestRequests.length > 4)
    throw new ApiError(400, 'invalid_request');
  return {
    customerDraft: {
      body: boundedString(draft.body, 1, 8_000, { allowMultiline: true }),
    },
    kbProposal:
      kb === null
        ? null
        : {
            summary: text(kb.summary, 2_000),
            changes: lines(kb.changes, 12),
            advisoryValidationRequirements: lines(
              kb.advisoryValidationRequirements,
              12,
            ),
          },
    retestRequests: row.retestRequests.map((value) => {
      const retest = exactObject(value, ['steps', 'expectedBehavior']);
      return {
        steps: lines(retest.steps, 12),
        expectedBehavior: text(retest.expectedBehavior, 2_000),
      };
    }),
  };
}

/** Explicit staff projection; provider metadata, claim identities and checks receipts stay server-side. */
export function supportReleaseFollowupWorkView(
  work: EngineeringFollowupWorkRecord,
) {
  return {
    ticketId: work.ticketId,
    workId: work.workId,
    workGeneration: work.workGeneration,
    status: work.status,
    stage: work.stage,
    deadline: work.deadline,
    acceptedTicketRevision: work.acceptedTicketRevision,
    withdrawn: work.withdrawn,
    retestResults: work.retestResults.map(({ requestId, result, verifiedAt }) => ({
      requestId,
      result,
      verifiedAt,
    })),
    ...(work.handoff === undefined ? {} : { handoff: work.handoff }),
    ...(work.delivered === undefined ? {} : {
      delivered: {
        messageId: work.delivered.messageId,
        ticketRevision: work.delivered.ticketRevision,
        postedAt: work.delivered.postedAt,
      },
    }),
    ...(work.heldReason === undefined ? {} : { heldReason: work.heldReason }),
    ...(work.candidate === undefined ? {} : { candidate: work.candidate }),
    ...(work.preparedBundle === undefined
      ? {}
      : {
          prepared: {
            bundleHash: work.preparedBundle.bundleHash,
            bundle: work.preparedBundle.bundle,
          },
        }),
  };
}

/** Existing browser authority and durable engineering quotas, independent of model readiness. */
export function createSupportReleaseFollowupHandlers(
  options?: SupportReleaseFollowupHandlerOptions,
) {
  return async (request: Request): Promise<Response | null> => {
    const url = new URL(request.url);
    if (!isSupportReleaseFollowupRequest(url.pathname)) return null;
    function enabled() {
      try {
        return options?.enabled() === true;
      } catch {
        return false;
      }
    }
    if (options === undefined || !enabled())
      return json({ error: 'not_found' }, { status: 404 });
    const match = route.exec(url.pathname);
    if (match === null) return json({ error: 'not_found' }, { status: 404 });
    const ticketId = match[1]!;
    const operation = match[2]!;
    const mutation = operation !== 'work' && operation !== 'scan' && operation !== 'mapping';
    const required =
      operation === 'observe' || operation === 'verify-mapping' || operation === 'withdraw-mapping' || operation === 'retest-receipt' || operation === 'retest'
        ? supportPermissions.engineeringFollowupEvidenceSubmit
        : mutation
          ? supportPermissions.engineeringFollowupReview
          : supportPermissions.engineeringFollowupRead;
    const resolve = createAgentPrincipalResolver(options);
    const browser = supportHumanBrowser(request, {
      sessions: options.sessions,
      mutation,
      permission: required,
      async authenticate(incoming) {
        const value = await authenticate(incoming, options);
        if (value === null) throw new ApiError(401, 'authentication_required');
        return value;
      },
      async access(authenticated) {
        const value = await resolve(authenticated.link.subject);
        if (value === null) throw new ApiError(401, 'authentication_required');
        return value;
      },
    });
    let ceiling: AccessContext | undefined;
    let csrfToken = '';
    async function current() {
      if (!enabled()) throw new ApiError(503, 'followup_disabled');
      const fresh = await browser.current();
      if (!enabled()) throw new ApiError(503, 'followup_disabled');
      ceiling ??= structuredClone(fresh.access);
      const access = {
        ...fresh.access,
        permissions: fresh.access.permissions.filter((entry) =>
          ceiling!.permissions.includes(entry),
        ),
        roles: fresh.access.roles.filter((entry) =>
          ceiling!.roles.includes(entry),
        ),
        entitlements: fresh.access.entitlements.filter((entry) =>
          ceiling!.entitlements.includes(entry),
        ),
      };
      for (const permission of [
        required,
        supportPermissions.queueRead,
        ...(operation === 'post' ? [supportPermissions.replyAny] : []),
      ]) {
        if (!hasPermission(access, permission))
          throw new ApiError(403, 'forbidden');
      }
      csrfToken = fresh.authenticated.csrfToken;
      return access;
    }
    const context = {
      current,
      signal: request.signal,
      assertCurrent() {
        if (!enabled() || request.signal.aborted)
          throw new ApiError(503, 'followup_disabled');
        browser.assertCurrent();
      },
    };
    let admitted = false;
    try {
      if (request.method !== (mutation ? 'POST' : 'GET'))
        throw new ApiError(405, 'method_not_allowed');
      if (url.hash !== '' || (mutation && url.search !== ''))
        throw new ApiError(400, 'invalid_request');
      const initial = await current();
      admitted = true;
      await enforceRateLimit(
        mutation ? options.mutationLimiter : options.readLimiter,
        initial.principalId,
      );
      if (!mutation) {
        if (operation === 'mapping') {
          const mappings = options.mappings;
          if (mappings === undefined)
            throw new ApiError(503, 'followup_mapping_unavailable');
          if (url.searchParams.size === 0)
            return json({ result: await mappings.choices(context, ticketId), csrfToken });
          if (url.searchParams.size !== 2 ||
            url.searchParams.getAll('repositoryId').length !== 1 ||
            url.searchParams.getAll('issueId').length !== 1)
            throw new ApiError(400, 'invalid_request');
          const result = await mappings.read(context, ticketId,
            text(url.searchParams.get('repositoryId')), text(url.searchParams.get('issueId')));
          return json({ result, csrfToken });
        }
        if (operation === 'scan') {
          if (
            url.searchParams.size > 1 ||
            url.searchParams.getAll('cursor').length > 1 ||
            (url.searchParams.size === 1 && !url.searchParams.has('cursor'))
          )
            throw new ApiError(400, 'invalid_request');
          const cursor = url.searchParams.get('cursor');
          const page = await options
            .runtime()
            .scan(context, {
              limit: 16,
              ...(cursor === null ? {} : { cursor: text(cursor, 4_096) }),
            });
          return json({
            result: {
              ticketId,
              candidates: page.candidates.filter(
                (entry) => entry.ticketId === ticketId,
              ),
              reviewCandidates: page.reviewCandidates.filter(
                (entry) => entry.ticketId === ticketId,
              ),
              attention: page.attentionSources.includes(ticketId),
              physicalRows: page.physicalRows,
              nextCursor: page.nextCursor,
            },
            csrfToken,
          });
        }
        if (
          url.searchParams.size !== 1 ||
          url.searchParams.getAll('workId').length !== 1
        )
          throw new ApiError(400, 'invalid_request');
        const workId = text(url.searchParams.get('workId'));
        const value = await options
          .runtime()
          .read(context, { ticketId, workId });
        return json({
          result: supportReleaseFollowupWorkView(value),
          csrfToken,
        });
      }
      const raw = await readJson(request, { timeoutMs: 10_000 });
      if (operation === 'retest-receipt') {
        if (options.retests === undefined)
          throw new ApiError(503, 'followup_retest_unavailable');
        const parsed = prepareSupportFollowupRetestInput.safeParse(raw);
        if (!parsed.success) throw new ApiError(400, 'invalid_request');
        const result = await options.retests.prepare(context, ticketId, parsed.data);
        return json({ result, csrfToken }, { status: 'pending' in result ? 202 : 200 });
      }
      if (operation === 'verify-mapping' || operation === 'withdraw-mapping') {
        if (options.mappings === undefined)
          throw new ApiError(503, 'followup_mapping_unavailable');
        const parsed = operation === 'verify-mapping'
          ? verifySupportFollowupMappingInput.safeParse(raw)
          : withdrawSupportFollowupMappingInput.safeParse(raw);
        if (!parsed.success) throw new ApiError(400, 'invalid_request');
        const result = operation === 'verify-mapping'
          ? await options.mappings.verify(context, ticketId, verifySupportFollowupMappingInput.parse(parsed.data))
          : await options.mappings.withdraw(context, ticketId, withdrawSupportFollowupMappingInput.parse(parsed.data));
        return json({ result, csrfToken });
      }
      const fields =
        operation === 'retest'
          ? ['commandId', 'workId', 'retestRequestId', 'receiptReference']
          : operation === 'observe'
          ? ['commandId', 'repositoryId', 'issueId', 'inputReference']
          : operation === 'post'
            ? [
                'commandId',
                'workId',
                'expectedWorkGeneration',
                'expectedTicketRevision',
                'bundleHash',
                'messageId',
              ]
            : operation === 'reject'
              ? [
                  'commandId',
                  'workId',
                  'expectedWorkGeneration',
                  'bundleHash',
                  'reason',
                ]
              : operation === 'abandon'
                ? ['commandId', 'workId', 'expectedWorkGeneration', 'reason']
                : ['commandId', 'workId', 'expectedWorkGeneration'];
      const row =
        operation === 'reassess'
          ? optionalKeysObject(raw, fields, ['content'])
          : exactObject(raw, fields);
      const commandId = text(row.commandId);
      if (
        !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(
          commandId,
        )
      )
        throw new ApiError(400, 'invalid_request');
      const identity = await supportReleaseFollowupIdentity(
        initial.principalId,
        ticketId,
        operation,
        commandId,
      );
      const base = { ...identity, ticketId };
      const runtime = options.runtime();
      let result: unknown;
      if (operation === 'retest')
        result = await runtime.retest(context, {
          ...base,
          workId: text(row.workId),
          retestRequestId: text(row.retestRequestId),
          receiptReference: text(row.receiptReference),
        });
      else if (operation === 'observe')
        result = await runtime.observe(context, {
          ...base,
          association: {
            repositoryId: text(row.repositoryId),
            issueId: text(row.issueId),
          },
          inputReference: text(row.inputReference),
        });
      else {
        const packet = {
          ...base,
          workId: text(row.workId),
          expectedWorkGeneration: integer(row.expectedWorkGeneration),
        };
        if (operation === 'post')
          result = await runtime.post(context, {
            ...packet,
            expectedTicketRevision: integer(row.expectedTicketRevision),
            bundleHash: hash(row.bundleHash),
            messageId: text(row.messageId),
          });
        else if (operation === 'reassess')
          result = await runtime.reassess(context, {
            ...packet,
            ...(row.content === undefined
              ? {}
              : { content: candidate(row.content) }),
          });
        else if (operation === 'reject')
          result = await runtime.reject(context, {
            ...packet,
            bundleHash: hash(row.bundleHash),
            reason: text(row.reason),
          });
        else if (operation === 'retry')
          result = await runtime.retry(context, packet);
        else
          result = await runtime.abandon(context, {
            ...packet,
            reason: text(row.reason),
          });
      }
      return json({ result, commandId, operation, csrfToken });
    } catch (error) {
      let failure = error;
      if (admitted) {
        try {
          await current();
        } catch (closed) {
          failure = closed;
        }
      }
      const mapped =
        failure instanceof ApiError ? failure : mapSupportError(failure);
      const status = mapped.status >= 500 ? 503 : mapped.status;
      const code = mapped.code;
      return json(
        {
          error:
            status >= 500
              ? failure instanceof ApiError
                ? code
                : 'followup_unavailable'
              : code,
        },
        {
          status,
          ...(mapped.retryAfterSeconds === undefined
            ? {}
            : { headers: { 'Retry-After': String(mapped.retryAfterSeconds) } }),
        },
      );
    }
  };
}
