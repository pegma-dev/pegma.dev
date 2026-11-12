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
} from '@pegma/support-desk-application';
import type { AccessContext } from '@pegma/authorization-core';
import type { Clock } from '@pegma/spine';
import type { Store } from '@pegma/storage-core';
import { ApiError } from './api-auth';
import type { SupportReleaseFollowupConfiguration } from './support-release-followup-ports';
import { createSupportReleaseFollowupUsage } from './support-release-followup-usage';

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
  function coordinator(context?: SupportReleaseFollowupContext) {
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
      checks: config.checks,
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
        }).approveAndPostWebUpdate(access, command, {
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
    /** Programmatic only. No staff HTTP endpoint or new scheduled trigger. */
    async process(
      command: Parameters<ReturnType<typeof coordinator>['processWork']>[0],
      signal?: AbortSignal,
    ) {
      if (!options.enabled() || generation === undefined)
        return {
          outcome: 'held' as const,
          reason: 'followup_generation_unavailable' as const,
        };
      return coordinator().processWork(command, { signal });
    },
  });
}
export type SupportReleaseFollowupRuntime = ReturnType<
  typeof createSupportReleaseFollowupRuntime
>;
