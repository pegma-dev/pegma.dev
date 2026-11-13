import { hasPermission, type AccessContext } from '@pegma/authorization-core';
import type { Clock } from '@pegma/spine';
import {
  createSupportDeskEngineering,
  type EngineeringProcessResult,
  type SupportDeskEngineering,
  type SupportDeskEngineeringOptions,
} from '@pegma/support-desk-ai';
import {
  SupportDeskAuthorizationError,
  supportPermissions,
  type EngineeringApplication,
  type EngineeringPolicyApplication,
  type EngineeringOptions,
  type EngineeringKey,
  type EnrollEngineeringSourceCommand,
  type SubmitEngineeringEvidenceCommand,
  type SelectEngineeringRepositoryCommand,
  type ReviewEngineeringProposalCommand,
  type InvalidateEngineeringSourceCommand,
  type WithdrawEngineeringSourceCommand,
  type PutEngineeringPolicyCommand,
  type EngineeringPolicyCommand,
  type EngineeringMutationOptions,
} from '@pegma/support-desk-application';
import {
  supportEngineeringCommandIdentity,
  type SupportEngineeringOperation,
  type SupportEngineeringPorts,
  type SupportEngineeringStaffAccess,
} from './support-engineering-ports';

type Packet<Command> = Omit<Command, 'commandId' | 'correlationId'> & { readonly clientCommandId: string };
export type EngineeringEnrollmentPacket = Packet<EnrollEngineeringSourceCommand>;
export type EngineeringFailurePacket = Packet<Omit<SubmitEngineeringEvidenceCommand, 'evidence'> & {
  readonly evidence: Extract<SubmitEngineeringEvidenceCommand['evidence'], { readonly kind: 'staff_verified_failure' }>;
}>;
export type EngineeringSelectionPacket = Packet<SelectEngineeringRepositoryCommand>;
export type EngineeringReviewPacket = Packet<ReviewEngineeringProposalCommand>;
export type EngineeringInvalidationPacket = Packet<InvalidateEngineeringSourceCommand>;
export type EngineeringWithdrawalPacket = Packet<WithdrawEngineeringSourceCommand>;
export type EngineeringPolicyPacket = Packet<PutEngineeringPolicyCommand>;
export type EngineeringDisablePacket = Packet<EngineeringPolicyCommand>;
/** The HTTP host resolves the original browser and current human authority. */
export type SupportEngineeringHumanCommitGuard = () => Promise<AccessContext>;
export interface SupportEngineeringSelectionControl {
  readonly beforeCommit?: SupportEngineeringHumanCommitGuard;
  readonly intentFingerprint?: string;
}

/** Read-only facts required for a NEW approval; no processing or dispatch ports. */
export interface SupportEngineeringReviewProofs {
  readonly serviceAccess: SupportEngineeringPorts['serviceAccess'];
  readonly routing: Pick<SupportEngineeringPorts['routing'], 'resolve' | 'verify'>;
  readonly checks: Pick<SupportEngineeringPorts['checks'], 'resolvePolicy' | 'verify'>;
  readonly github: Pick<SupportEngineeringPorts['github'], 'getMetadata'>;
}

export interface SupportEngineeringRuntimeOptions {
  readonly application: EngineeringApplication & EngineeringPolicyApplication;
  readonly clock: Clock;
  readonly staffAccess: SupportEngineeringStaffAccess;
  /** Worker admission only. Generation configuration and export policy are separate. */
  readonly processingEnabled?: () => boolean;
  readonly ports?: Partial<SupportEngineeringPorts>;
  readonly reviewProofs?: SupportEngineeringReviewProofs;
  readonly checksFor?: (scope: EngineeringKey, onDurablyDeferred: (hint: SupportEngineeringDeferredCheckHint) => void) => SupportEngineeringPorts['checks'];
  readonly precomputeChecks?: (hint: SupportEngineeringDeferredCheckHint, run: { readonly deadline: string; readonly signal: AbortSignal; readonly current: () => boolean }) => Promise<SupportEngineeringPrecomputeResult>;
  /** Called after an accepted SDK privacy/delete transition; never grants authority. */
  readonly discardChecks?: (ticketId: string) => Promise<void>;
}

export interface SupportEngineeringDeferredCheckHint {
  readonly kind: 'checks';
  readonly operationId: string;
  readonly ticketId: string;
  readonly sourceGeneration: number;
  readonly expiresAt: string;
}
export type SupportEngineeringPrecomputeResult = { readonly outcome: 'checked' | 'held' | 'restricted' | 'unknown' };

export class SupportEngineeringUnavailableError extends Error {
  readonly code = 'support_engineering_unavailable';
  constructor() { super('Support engineering is unavailable'); this.name = 'SupportEngineeringUnavailableError'; }
}

/** Pass explicitly to the existing Support factory; intake defaults OFF. */
export function supportEngineeringApplicationOptions(options: EngineeringOptions = {}): EngineeringOptions {
  return Object.freeze({ ...options, enabled: options.enabled === true });
}

const staffOperationMilliseconds = 25_000;

type Held = { readonly outcome: 'held'; readonly reason: 'engineering_disabled' | 'engineering_unavailable' };
export type SupportEngineeringProcessResult = EngineeringProcessResult | Held | {
  readonly outcome: 'checks_pending';
  readonly hint: SupportEngineeringDeferredCheckHint;
};

/** No application, Store, auth, HTTP, policy ledger or scheduler is created. */
export function createSupportEngineeringRuntime(options: SupportEngineeringRuntimeOptions) {
  const application = options.application;
  const ports = options.ports ?? {};
  const enabled = () => { try { return options.processingEnabled?.() === true; } catch { return false; } };
  const unavailable = async (): Promise<never> => { throw new SupportEngineeringUnavailableError(); };
  const base: SupportDeskEngineeringOptions = {
    application, clock: options.clock,
    policy: { resolve: (access) => application.readRepositoryPolicy(access) },
    serviceAccess: ports.serviceAccess ?? { resolve: async () => ({ outcome: 'inactive' }) },
    reconciliationAccess: ports.reconciliationAccess ?? { resolve: async () => ({ outcome: 'inactive' }) },
    configuration: ports.configuration ?? { resolve: async () => ({ outcome: 'disabled' }) },
    routing: ports.routing ?? { resolve: async () => ({ outcome: 'unavailable' }),
      check: async () => ({ outcome: 'unavailable' }), verify: async () => null },
    checks: ports.checks ?? { resolvePolicy: async () => ({ outcome: 'disabled' }),
      check: async () => ({ outcome: 'held' }), verify: async () => null },
    model: ports.model ?? { generate: unavailable },
    usage: ports.usage ?? { reserve: async () => ({ outcome: 'unavailable' }), reconcile: async () => 'pending' },
    tokenCounter: ports.tokenCounter ?? { count() { throw new SupportEngineeringUnavailableError(); } },
    github: ports.github ?? { getMetadata: async () => null, searchDuplicates: unavailable,
      createIssue: unavailable, reconcile: async () => ({ outcome: 'unknown' }) },
    proposals: ports.proposals ?? { duplicateQuery: async () => null, prepare: async () => ({ outcome: 'held' }) },
    maxOperationMilliseconds: 25_000, storageCommandAttempts: 2,
  };
  const proofs = options.reviewProofs;
  const reviewBase: SupportDeskEngineeringOptions = proofs === undefined ? base : {
    ...base, serviceAccess: proofs.serviceAccess,
    routing: { ...base.routing, resolve: (...args) => proofs.routing.resolve(...args),
      verify: (...args) => proofs.routing.verify(...args) },
    checks: { ...base.checks, resolvePolicy: (...args) => proofs.checks.resolvePolicy(...args),
      verify: (...args) => proofs.checks.verify(...args) },
    github: { ...base.github, getMetadata: (...args) => proofs.github.getMetadata(...args) },
  };
  const coordinator = createSupportDeskEngineering(base);
  const processingOptions = { ...base, serviceAccess: {
    async resolve(signal) {
      if (!enabled()) return { outcome: 'inactive' };
      const value = await base.serviceAccess.resolve(signal);
      return enabled() ? value : { outcome: 'inactive' };
    },
  } } satisfies SupportDeskEngineeringOptions;
  const processing = createSupportDeskEngineering(processingOptions);
  async function discard(ticketId: string) {
    try { await options.discardChecks?.(ticketId); }
    catch { /* The accepted SDK receipt remains authority. Nonpaid cleanup retries redaction. */ }
  }
  function validHint(hint: SupportEngineeringDeferredCheckHint): boolean {
    return hint.kind === 'checks' && /^[0-9a-f]{64}$/u.test(hint.operationId) &&
      typeof hint.ticketId === 'string' && hint.ticketId.length > 0 && hint.ticketId.length <= 200 &&
      !/[\u0000-\u001f\u007f]/u.test(hint.ticketId) && Number.isSafeInteger(hint.sourceGeneration) && hint.sourceGeneration > 0 &&
      typeof hint.expiresAt === 'string' && Number.isFinite(Date.parse(hint.expiresAt)) && new Date(hint.expiresAt).toISOString() === hint.expiresAt;
  }

  async function staff<Result>(original: AccessContext, permission: string,
    run: (access: AccessContext, refresh: () => Promise<AccessContext>, signal: AbortSignal,
      assertCurrent: () => true) => Promise<Result>): Promise<Result> {
    const bound = structuredClone(original);
    const started = performance.now();
    const controller = new AbortController();
    const ensure = (): void => {
      if (controller.signal.aborted || performance.now() - started >= staffOperationMilliseconds)
        throw new SupportEngineeringUnavailableError();
    };
    // Live authority is resolved asynchronously before commit. This final
    // synchronous fence binds the original caller reference and deadline.
    const assertCurrent = (): true => {
      ensure();
      if (original.principalId !== bound.principalId)
        throw new SupportDeskAuthorizationError(permission);
      return true;
    };
    let rejectDeadline: (error: Error) => void = () => {};
    const deadline = new Promise<never>((_resolve, reject) => { rejectDeadline = reject; });
    const timer = setTimeout(() => {
      rejectDeadline(new SupportEngineeringUnavailableError());
      controller.abort();
    }, staffOperationMilliseconds);
    const within = async <Value>(action: () => Promise<Value>): Promise<Value> => {
      const value = await Promise.race([
        Promise.resolve().then(() => { ensure(); return action(); }),
        deadline,
      ]);
      ensure();
      return value;
    };
    async function refresh(): Promise<AccessContext> {
      ensure();
      if (original.principalId !== bound.principalId)
        throw new SupportDeskAuthorizationError(permission);
      let current: AccessContext | null;
      try { current = await within(() => options.staffAccess.resolve(bound.principalId, controller.signal)); }
      catch { ensure(); throw new SupportEngineeringUnavailableError(); }
      if (current === null || current.principalId !== bound.principalId ||
        original.principalId !== bound.principalId)
        throw new SupportDeskAuthorizationError(permission);
      const access: AccessContext = { principalId: bound.principalId, policyVersion: current.policyVersion,
        roles: current.roles.filter((role) => bound.roles.includes(role)),
        entitlements: current.entitlements.filter((entry) => bound.entitlements.includes(entry)),
        permissions: current.permissions.filter((entry) => bound.permissions.includes(entry)) };
      for (const required of [permission, supportPermissions.queueRead])
        if (!hasPermission(access, required)) throw new SupportDeskAuthorizationError(required);
      return access;
    }
    try {
      const current = await refresh();
      const value = await within(() => run(current, refresh, controller.signal, assertCurrent));
      // A direct SDK mutation may commit after this boundary stops waiting.
      // Withhold its unknown acknowledgement; only exact packet replay can
      // recover it. Timeout never proves nonacceptance or rolls it back.
      await refresh();
      return value;
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }

  async function command<Input extends { readonly clientCommandId: string }, Result>(access: AccessContext,
    permission: string, operation: SupportEngineeringOperation, ticketId: string, input: Input,
    invoke: (current: AccessContext, packet: Omit<Input, 'clientCommandId'> & { commandId: string; correlationId: string },
      refresh: () => Promise<AccessContext>, signal: AbortSignal, control: EngineeringMutationOptions) => Promise<Result>,
    beforeCommit?: SupportEngineeringHumanCommitGuard): Promise<Result> {
    const packet = structuredClone(input);
    const principalId = access.principalId;
    const ceiling = structuredClone(access);
    if (beforeCommit !== undefined && typeof beforeCommit !== 'function')
      throw new TypeError('Expected an engineering human commit guard');
    return staff(access, permission, async (_current, refresh, signal, assertCurrent) => {
      const { clientCommandId, ...fields } = packet;
      const identity = await supportEngineeringCommandIdentity({ principalId, ticketId, operation, clientCommandId });
      const control: EngineeringMutationOptions = { signal, verifyBeforeCommit: async () => {
        // A complete current browser guard already resolves current staff roles.
        // Trusted direct callers use the same current-role resolver instead.
        const current = beforeCommit === undefined ? await refresh() : await beforeCommit();
        assertCurrent();
        if (current.principalId !== principalId) throw new SupportDeskAuthorizationError(permission);
        const bounded: AccessContext = { principalId, policyVersion: current.policyVersion,
          roles: current.roles.filter((entry) => ceiling.roles.includes(entry)),
          entitlements: current.entitlements.filter((entry) => ceiling.entitlements.includes(entry)),
          permissions: current.permissions.filter((entry) => ceiling.permissions.includes(entry)) };
        for (const required of [permission, supportPermissions.queueRead])
          if (!hasPermission(bounded, required)) throw new SupportDeskAuthorizationError(required);
        return assertCurrent;
      } };
      return invoke(await refresh(), { ...fields, ...identity }, refresh, signal, control);
    });
  }

  async function reviewCommand(access: AccessContext, input: ReviewEngineeringProposalCommand,
    beforeCommit?: () => Promise<AccessContext | void>) {
    const packet = structuredClone(input);
    const ceiling = structuredClone(access);
    if (beforeCommit !== undefined && typeof beforeCommit !== 'function')
      throw new TypeError('Expected an engineering browser commit guard');
    return staff(access, supportPermissions.engineeringReview, async (current, refresh, signal, assertCurrent) => {
      const reviewing = createSupportDeskEngineering(reviewBase);
      return reviewing.reviewProposal(current, packet, { signal,
        verifyBeforeCommit: async () => {
          // The complete original-browser fence already fetches current roles
          // and Identity. Trusted direct callers use the runtime resolver.
          const observed = await beforeCommit?.();
          const fresh = observed === undefined ? await refresh() : observed;
          assertCurrent();
          if (fresh.principalId !== ceiling.principalId)
            throw new SupportDeskAuthorizationError(supportPermissions.engineeringReview);
          const bounded: AccessContext = { principalId: ceiling.principalId, policyVersion: fresh.policyVersion,
            roles: fresh.roles.filter((entry) => ceiling.roles.includes(entry)),
            entitlements: fresh.entitlements.filter((entry) => ceiling.entitlements.includes(entry)),
            permissions: fresh.permissions.filter((entry) => ceiling.permissions.includes(entry)) };
          for (const required of [supportPermissions.engineeringReview, supportPermissions.queueRead])
            if (!hasPermission(bounded, required)) throw new SupportDeskAuthorizationError(required);
        },
      });
    });
  }

  return Object.freeze({
    reviewCommand,
    enroll: (access: AccessContext, input: EngineeringEnrollmentPacket, beforeCommit?: SupportEngineeringHumanCommitGuard) =>
      command(access, supportPermissions.engineeringEvidenceSubmit, 'enroll', input.ticketId, input,
        (current, packet, _refresh, _signal, control) => application.enrollEngineeringSource(current, packet, control), beforeCommit),
    submitVerifiedFailure: (access: AccessContext, input: EngineeringFailurePacket, beforeCommit?: SupportEngineeringHumanCommitGuard) =>
      command(access, supportPermissions.engineeringEvidenceSubmit, 'failure', input.ticketId, input,
        (current, packet, _refresh, _signal, control) => application.submitEngineeringEvidence(current, packet, control), beforeCommit),
    selectRepository(access: AccessContext, input: EngineeringSelectionPacket, options: SupportEngineeringSelectionControl = {}) {
      const { intentFingerprint, beforeCommit } = options;
      return command(access, supportPermissions.engineeringReview, 'select', input.ticketId, input,
        (current, packet, _refresh, _signal, control) => {
          if (intentFingerprint !== undefined && !/^[a-f0-9]{64}$/u.test(intentFingerprint))
            throw new TypeError('Invalid engineering selection intent fingerprint');
          return application.selectEngineeringRepository(current, { ...packet,
            ...(intentFingerprint === undefined ? {} : {
              correlationId: 'engineering-selection-intent:' + intentFingerprint,
            }),
          }, control);
        }, beforeCommit);
    },
    reviewProposal: (access: AccessContext, input: EngineeringReviewPacket) =>
      command(access, supportPermissions.engineeringReview, 'review', input.ticketId, input,
        async (current, packet, refresh, signal) => {
          return createSupportDeskEngineering(reviewBase).reviewProposal(current, packet, { signal,
            verifyBeforeCommit: async () => { await refresh(); },
          });
        }),
    invalidate: (access: AccessContext, input: EngineeringInvalidationPacket, beforeCommit?: SupportEngineeringHumanCommitGuard) =>
      command(access, supportPermissions.engineeringWithdraw, 'invalidate', input.ticketId, input,
        async (current, packet, _refresh, _signal, control) => {
          const result = await application.invalidateEngineeringSource(current, packet, control); await discard(packet.ticketId); return result;
        }, beforeCommit),
    withdraw: (access: AccessContext, input: EngineeringWithdrawalPacket, beforeCommit?: SupportEngineeringHumanCommitGuard) =>
      command(access, supportPermissions.engineeringWithdraw, 'withdraw', input.ticketId, input,
        async (current, packet, _refresh, _signal, control) => {
          const result = await application.withdrawEngineeringSource(current, packet, control); await discard(packet.ticketId); return result;
        }, beforeCommit),
    readSource: (access: AccessContext, ticketId: string) =>
      staff(access, supportPermissions.engineeringRead, (current) => application.readEngineeringSource(current, ticketId)),
    readWork(access: AccessContext, input: EngineeringKey) {
      const key = structuredClone(input);
      return staff(access, supportPermissions.engineeringRead, (current) => application.readEngineeringWork(current, key));
    },
    readPolicy: (access: AccessContext) =>
      staff(access, supportPermissions.engineeringPolicyRead, (current) => application.readRepositoryPolicy(current)),
    putPolicy: (access: AccessContext, input: EngineeringPolicyPacket, intentFingerprint?: string,
      beforeCommit?: SupportEngineeringHumanCommitGuard) =>
      command(access, supportPermissions.engineeringPolicyManage, 'policy_put', 'policy-instance', input,
        (current, packet, _refresh, _signal, control) => {
          if (intentFingerprint !== undefined && !/^[a-f0-9]{64}$/u.test(intentFingerprint))
            throw new TypeError('Invalid engineering policy intent fingerprint');
          return application.putRepositoryPolicy(current, {
            ...packet,
            ...(intentFingerprint === undefined ? {} : {
              correlationId: 'engineering-policy-intent:' + intentFingerprint,
            }),
          }, control);
        }, beforeCommit),
    disableExports: (access: AccessContext, input: EngineeringDisablePacket, beforeCommit?: SupportEngineeringHumanCommitGuard) =>
      command(access, supportPermissions.engineeringPolicyManage, 'policy_disable', 'policy-instance', input,
        (current, packet, _refresh, _signal, control) => application.disableEngineeringExports(current, packet, control), beforeCommit),
    scanReview(access: AccessContext, input: Parameters<EngineeringApplication['scanEngineeringCandidates']>[1]) {
      const bounds = structuredClone(input);
      return staff(access, supportPermissions.engineeringReview, (current) => application.scanEngineeringCandidates(current, bounds));
    },
    async scanCandidates(input: Parameters<SupportDeskEngineering['scanCandidates']>[0]) {
      if (!enabled()) return { outcome: 'held' as const, reason: 'engineering_disabled' as const };
      if (ports.serviceAccess === undefined) return { outcome: 'held' as const, reason: 'engineering_unavailable' as const };
      try { return await processing.scanCandidates(structuredClone(input)); }
      catch { return { outcome: 'held' as const, reason: 'engineering_unavailable' as const }; }
    },
    async processWork(input: Parameters<SupportDeskEngineering['processWork']>[0],
      run: Parameters<SupportDeskEngineering['processWork']>[1] = {}): Promise<SupportEngineeringProcessResult> {
      if (!enabled()) return { outcome: 'held', reason: 'engineering_disabled' };
      if (ports.serviceAccess === undefined) return { outcome: 'held', reason: 'engineering_unavailable' };
      const copied = structuredClone(input);
      if (!options.checksFor) return processing.processWork(copied, run);
      let pending: SupportEngineeringDeferredCheckHint | undefined;
      const checks = options.checksFor({ ticketId: copied.ticketId, sourceGeneration: copied.sourceGeneration }, hint => {
        if (!validHint(hint) || hint.ticketId !== copied.ticketId || hint.sourceGeneration !== copied.sourceGeneration)
          throw new SupportEngineeringUnavailableError();
        pending = Object.freeze({ ...hint });
      });
      const result = await createSupportDeskEngineering({ ...processingOptions, checks }).processWork(copied, run);
      return pending && (result.outcome === 'held' || result.outcome === 'pending')
        ? { outcome: 'checks_pending', hint: pending } : result;
    },
    async precomputeChecks(input: SupportEngineeringDeferredCheckHint, run: { readonly signal?: AbortSignal } = {}): Promise<SupportEngineeringPrecomputeResult> {
      if (!enabled() || !options.precomputeChecks || run.signal?.aborted || !validHint(input)) return { outcome: 'held' };
      const hint = structuredClone(input);
      const deadlineAt = Math.min(Date.parse(options.clock.now()) + staffOperationMilliseconds, Date.parse(hint.expiresAt));
      if (!Number.isFinite(deadlineAt) || deadlineAt <= Date.parse(options.clock.now())) return { outcome: 'held' };
      const controller = new AbortController(); const abort = () => controller.abort();
      run.signal?.addEventListener('abort', abort, { once: true });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const stop = new Promise<never>((_resolve, reject) => {
          controller.signal.addEventListener('abort', () => reject(new SupportEngineeringUnavailableError()), { once: true });
          timer = setTimeout(abort, Math.max(1, deadlineAt - Date.parse(options.clock.now())));
        });
        const current = () => enabled() && !controller.signal.aborted && Date.parse(options.clock.now()) < deadlineAt;
        const result = await Promise.race([options.precomputeChecks(hint, { deadline: new Date(deadlineAt).toISOString(), signal: controller.signal, current }), stop]);
        if (!enabled() || controller.signal.aborted || !['checked', 'held', 'restricted', 'unknown'].includes(result.outcome)) return { outcome: 'unknown' };
        return { outcome: result.outcome };
      } catch { return { outcome: 'unknown' }; }
      finally { if (timer !== undefined) clearTimeout(timer); run.signal?.removeEventListener('abort', abort); controller.abort(); }
    },
    // Separate authority and no generation-config prerequisite, including after withdrawal.
    reconcileSource: (ticketId: string, run: Parameters<SupportDeskEngineering['reconcileSource']>[1] = {}) =>
      coordinator.reconcileSource(ticketId, run),
  });
}

export type SupportEngineeringRuntime = ReturnType<typeof createSupportEngineeringRuntime>;
