import {
  createSupportDeskReleaseFollowup,
  type PrepareReleaseFollowupStaffReassessmentCommand,
} from '@pegma/support-desk-ai';
import type {
  EngineeringFollowupApplication,
  EngineeringMutationOptions,
  EngineeringFollowupKey,
  ObserveEngineeringFollowupCommand,
  ApproveAndPostEngineeringFollowupWebUpdateCommand,
  RejectEngineeringFollowupBundleCommand,
  RetryEngineeringFollowupWorkCommand,
  AbandonEngineeringFollowupWorkCommand,
  SubmitEngineeringFollowupRetestResultCommand,
} from '@pegma/support-desk-application';
import { serializeAccessContext, type AccessContext } from '@pegma/authorization-core';
import type { Clock } from '@pegma/spine';
import type { Store } from '@pegma/storage-core';
import { ApiError } from './api-auth';
import type { SupportReleaseFollowupConfiguration } from './support-release-followup-ports';
import { createSupportReleaseFollowupUsage } from './support-release-followup-usage';
import { knowledgeDigest } from './knowledge-evidence';
import type { ReleaseFollowupCheckPendingHint } from '@pegma/support-desk-ai/openrouter';

export interface SupportReleaseFollowupContext {
  current(): Promise<AccessContext>;
  assertCurrent(): void;
  readonly signal: AbortSignal;
}

/** No timers, transport, default provider or permission grants are installed. */
export function createSupportReleaseFollowupRuntime(options: {
  readonly application: EngineeringFollowupApplication;
  readonly store: Store;
  readonly clock: Clock;
  readonly configuration: SupportReleaseFollowupConfiguration;
  readonly enabled: () => boolean;
}) {
  const config = options.configuration;
  const generation = config.generation;
  const unavailable = () => {
    throw new ApiError(503, 'followup_generation_unavailable');
  };
  function coordinator(
    context?: SupportReleaseFollowupContext,
    key?: EngineeringFollowupKey,
    reassessmentAuthority?: Parameters<NonNullable<SupportReleaseFollowupConfiguration['reassessmentChecksFor']>>[1],
  ) {
    const scope = key === undefined ? undefined : { ticketId: key.ticketId, workId: key.workId };
    return createSupportDeskReleaseFollowup({
      application: {
        ...options.application,
        approveAndPostEngineeringFollowupWebUpdate(
          access,
          command,
          proof,
          control,
        ) {
          return options.application.approveAndPostEngineeringFollowupWebUpdate(
            access,
            command,
            async (...observation: Parameters<typeof proof>) => {
              const assertion = await proof(...observation);
              return () => {
                context?.assertCurrent();
                if (assertion !== undefined && assertion() !== true)
                  throw new ApiError(503, 'followup_unavailable');
                return true;
              };
            },
            control,
          );
        },
      },
      clock: options.clock,
      releaseEvidence: config.releaseEvidence,
      checks: scope === undefined ? config.checks
        : reassessmentAuthority === undefined
          ? config.checksFor?.(scope) ?? config.checks
          : config.reassessmentChecksFor?.(scope, reassessmentAuthority) ?? config.checks,
      targets: config.targets,
      ...(config.knowledge === undefined
        ? {}
        : { knowledge: config.knowledge }),
      ...(config.knowledgeAccess === undefined
        ? {}
        : { knowledgeAccess: config.knowledgeAccess }),
      serviceAccess: generation?.serviceAccess ?? {
        async resolve() {
          return { outcome: 'inactive' };
        },
      },
      configuration: generation?.configuration ?? {
        async resolve() {
          return { outcome: 'disabled' };
        },
      },
      evaluations: generation?.evaluations ?? {
        async resolve() {
          return { outcome: 'unavailable' };
        },
      },
      model: generation?.model ?? {
        async generate() {
          return unavailable();
        },
      },
      tokenCounter: generation?.tokenCounter ?? { count: unavailable },
      usage: createSupportReleaseFollowupUsage({
        store: options.store,
        clock: options.clock,
        ...(generation === undefined ? {} : { policy: generation.usagePolicy }),
      }),
      storageCommandAttempts: 1,
      ...(context === undefined && config.invocationMode !== undefined
        ? { invocationMode: config.invocationMode }
        : {}),
    });
  }
  async function staff<Value>(
    context: SupportReleaseFollowupContext,
    action: (
      access: AccessContext,
      current: () => Promise<void>,
      assertCurrent: () => void,
      signal: AbortSignal,
    ) => Promise<Value>,
  ): Promise<Value> {
    const deadline = performance.now() + 25_000;
    const controller = new AbortController();
    function assertCurrent() {
      if (
        !options.enabled() ||
        controller.signal.aborted ||
        performance.now() >= deadline
      )
        throw new ApiError(503, 'followup_unavailable');
      context.assertCurrent();
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let rejectAbort: (error: ApiError) => void = () => {};
    const stopped = new Promise<never>((_resolve, reject) => {
      rejectAbort = reject;
      timer = setTimeout(() => {
        controller.abort();
        reject(new ApiError(503, 'followup_unavailable'));
      }, 25_000);
    });
    const onAbort = () => {
      controller.abort();
      rejectAbort(new ApiError(503, 'followup_unavailable'));
    };
    context.signal.addEventListener('abort', onAbort, { once: true });
    if (context.signal.aborted) onAbort();
    const run = async () => {
      const original = await context.current();
      const actor = original.principalId;
      const permissions = [...original.permissions];
      async function current() {
        if (
          !options.enabled() ||
          controller.signal.aborted ||
          performance.now() >= deadline
        )
          throw new ApiError(503, 'followup_unavailable');
        const fresh = await context.current();
        if (
          fresh.principalId !== actor ||
          permissions.some(
            (permission) => !fresh.permissions.includes(permission),
          )
        )
          throw new ApiError(403, 'forbidden');
        if (
          !options.enabled() ||
          controller.signal.aborted ||
          performance.now() >= deadline
        )
          throw new ApiError(503, 'followup_unavailable');
      }
      assertCurrent();
      const result = await action(
        original,
        current,
        assertCurrent,
        controller.signal,
      );
      await current();
      assertCurrent();
      return result;
    };
    try {
      return await Promise.race([run(), stopped]);
    } finally {
      clearTimeout(timer);
      context.signal.removeEventListener('abort', onAbort);
      controller.abort();
    }
  }
  function mutationControl(
    current: () => Promise<void>,
    assertCurrent: () => void,
    signal: AbortSignal,
  ): EngineeringMutationOptions {
    return {
      signal,
      verifyBeforeCommit: async () => {
        await current();
        return (): true => {
          assertCurrent();
          return true;
        };
      },
    };
  }
  return Object.freeze({
    scan(
      context: SupportReleaseFollowupContext,
      bounds: { readonly limit: number; readonly cursor?: string },
    ) {
      return staff(context, (access) =>
        options.application.scanEngineeringFollowups(access, bounds),
      );
    },
    read(context: SupportReleaseFollowupContext, key: EngineeringFollowupKey) {
      return staff(context, (access) =>
        options.application.readEngineeringFollowupWork(access, key),
      );
    },
    observe(
      context: SupportReleaseFollowupContext,
      command: ObserveEngineeringFollowupCommand,
    ) {
      return staff(context, (access, current, assertCurrent, signal) =>
        options.application.observeEngineeringFollowup(
          access,
          command,
          mutationControl(current, assertCurrent, signal),
        ),
      );
    },
    reassess(
      context: SupportReleaseFollowupContext,
      command: PrepareReleaseFollowupStaffReassessmentCommand,
    ) {
      return staff(context, (access, current, assertCurrent, signal) =>
        coordinator({
          ...context,
          assertCurrent,
          signal,
        }, command, {
          async resolve() {
            await current();
            if (config.reassessmentUsageScopeRef === undefined)
              return { outcome: 'unavailable' };
            const fresh = await context.current();
            return { outcome: 'ready', authority: {
              access: fresh,
              authorityVersion: 'pg-followup-staff/' + await knowledgeDigest(serializeAccessContext(fresh)),
              usageScopeRef: config.reassessmentUsageScopeRef,
            } };
          },
        }).prepareStaffReassessment(
          access,
          command,
          mutationControl(current, assertCurrent, signal),
        ),
      );
    },
    post(
      context: SupportReleaseFollowupContext,
      command: ApproveAndPostEngineeringFollowupWebUpdateCommand,
    ) {
      return staff(context, (access, current, assertCurrent, signal) =>
        coordinator({
          ...context,
          assertCurrent,
          signal,
        }, command).approveAndPostWebUpdate(access, command, {
          signal,
          verifyBeforeCommit: current,
        }),
      );
    },
    reject(
      context: SupportReleaseFollowupContext,
      command: RejectEngineeringFollowupBundleCommand,
    ) {
      return staff(context, (access, current, assertCurrent, signal) =>
        options.application.rejectEngineeringFollowupBundle(
          access,
          command,
          mutationControl(current, assertCurrent, signal),
        ),
      );
    },
    retest(
      context: SupportReleaseFollowupContext,
      command: SubmitEngineeringFollowupRetestResultCommand,
    ) {
      return staff(context, (access, current, assertCurrent, signal) =>
        options.application.submitEngineeringFollowupRetestResult(access, command,
          mutationControl(current, assertCurrent, signal)),
      );
    },
    retry(
      context: SupportReleaseFollowupContext,
      command: RetryEngineeringFollowupWorkCommand,
    ) {
      return staff(context, (access, current, assertCurrent, signal) =>
        options.application.retryEngineeringFollowupWork(
          access,
          command,
          mutationControl(current, assertCurrent, signal),
        ),
      );
    },
    abandon(
      context: SupportReleaseFollowupContext,
      command: AbandonEngineeringFollowupWorkCommand,
    ) {
      return staff(context, (access, current, assertCurrent, signal) =>
        options.application.abandonEngineeringFollowupWork(
          access,
          command,
          mutationControl(current, assertCurrent, signal),
        ),
      );
    },
    /** Body-free discovery for the existing bounded host queue. */
    scanProcessing(bounds: Parameters<ReturnType<typeof coordinator>['scanCandidates']>[0]) {
      return coordinator().scanCandidates(bounds);
    },
    async scanChecks(signal: AbortSignal) {
      if (!options.enabled() || signal.aborted || !config.deferredChecks)
        return [];
      return (await config.deferredChecks.scanPending(signal)).filter(
        (value) => value.mode === 'work',
      );
    },
    async precomputeChecks(
      hint: Pick<
        ReleaseFollowupCheckPendingHint,
        'operationId' | 'expiresAt'
      > & EngineeringFollowupKey,
      signal: AbortSignal,
      current?: () => boolean,
    ) {
      const admitted = () =>
        options.enabled() && !signal.aborted && current?.() !== false;
      if (!admitted() || !config.deferredChecks)
        return { outcome: 'held' as const };
      return config.deferredChecks.precomputePending(
        hint.operationId,
        {
          deadline: new Date(
            Math.min(
              Date.parse(options.clock.now()) + 25000,
              Date.parse(hint.expiresAt),
            ),
          ).toISOString(),
          signal,
        },
        { ticketId: hint.ticketId, workId: hint.workId },
        admitted,
      );
    },
    /** One bounded SDK stage; never posts or publishes automatically. */
    async process(
      command: Parameters<ReturnType<typeof coordinator>['processWork']>[0],
      signal?: AbortSignal,
    ) {
      if (!options.enabled() || generation === undefined)
        return {
          outcome: 'held' as const,
          reason: 'followup_generation_unavailable' as const,
        };
      return coordinator(undefined, command).processWork(command, { signal });
    },
  });
}
export type SupportReleaseFollowupRuntime = ReturnType<
  typeof createSupportReleaseFollowupRuntime
>;
