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
}

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
export type SupportEngineeringProcessResult = EngineeringProcessResult | Held;

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
  const processing = createSupportDeskEngineering({ ...base, serviceAccess: {
    async resolve(signal) {
      if (!enabled()) return { outcome: 'inactive' };
      const value = await base.serviceAccess.resolve(signal);
      return enabled() ? value : { outcome: 'inactive' };
    },
  } });

  async function staff<Result>(original: AccessContext, permission: string,
    run: (access: AccessContext, refresh: () => Promise<AccessContext>, signal: AbortSignal) => Promise<Result>): Promise<Result> {
    const bound = structuredClone(original);
    const started = performance.now();
    const controller = new AbortController();
    const ensure = (): void => {
      if (controller.signal.aborted || performance.now() - started >= staffOperationMilliseconds)
        throw new SupportEngineeringUnavailableError();
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
      const value = await within(() => run(current, refresh, controller.signal));
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
      refresh: () => Promise<AccessContext>, signal: AbortSignal) => Promise<Result>): Promise<Result> {
    const packet = structuredClone(input);
    const principalId = access.principalId;
    return staff(access, permission, async (_current, refresh, signal) => {
      const { clientCommandId, ...fields } = packet;
      const identity = await supportEngineeringCommandIdentity({ principalId, ticketId, operation, clientCommandId });
      return invoke(await refresh(), { ...fields, ...identity }, refresh, signal);
    });
  }

  async function reviewCommand(access: AccessContext, input: ReviewEngineeringProposalCommand,
    beforeCommit?: () => Promise<void>) {
    const packet = structuredClone(input);
    if (beforeCommit !== undefined && typeof beforeCommit !== 'function')
      throw new TypeError('Expected an engineering browser commit guard');
    return staff(access, supportPermissions.engineeringReview, async (current, refresh, signal) => {
      const reviewing = createSupportDeskEngineering(reviewBase);
      return reviewing.reviewProposal(current, packet, { signal,
        verifyBeforeCommit: async () => { await refresh(); await beforeCommit?.(); },
      });
    });
  }

  return Object.freeze({
    reviewCommand,
    enroll: (access: AccessContext, input: EngineeringEnrollmentPacket) =>
      command(access, supportPermissions.engineeringEvidenceSubmit, 'enroll', input.ticketId, input,
        (current, packet) => application.enrollEngineeringSource(current, packet)),
    submitVerifiedFailure: (access: AccessContext, input: EngineeringFailurePacket) =>
      command(access, supportPermissions.engineeringEvidenceSubmit, 'failure', input.ticketId, input,
        (current, packet) => application.submitEngineeringEvidence(current, packet)),
    selectRepository: (access: AccessContext, input: EngineeringSelectionPacket) =>
      command(access, supportPermissions.engineeringReview, 'select', input.ticketId, input,
        (current, packet) => application.selectEngineeringRepository(current, packet)),
    reviewProposal: (access: AccessContext, input: EngineeringReviewPacket) =>
      command(access, supportPermissions.engineeringReview, 'review', input.ticketId, input,
        async (current, packet, refresh, signal) => {
          return coordinator.reviewProposal(current, packet, { signal,
            verifyBeforeCommit: async () => { await refresh(); },
          });
        }),
    invalidate: (access: AccessContext, input: EngineeringInvalidationPacket) =>
      command(access, supportPermissions.engineeringWithdraw, 'invalidate', input.ticketId, input,
        (current, packet) => application.invalidateEngineeringSource(current, packet)),
    withdraw: (access: AccessContext, input: EngineeringWithdrawalPacket) =>
      command(access, supportPermissions.engineeringWithdraw, 'withdraw', input.ticketId, input,
        (current, packet) => application.withdrawEngineeringSource(current, packet)),
    readSource: (access: AccessContext, ticketId: string) =>
      staff(access, supportPermissions.engineeringRead, (current) => application.readEngineeringSource(current, ticketId)),
    readWork(access: AccessContext, input: EngineeringKey) {
      const key = structuredClone(input);
      return staff(access, supportPermissions.engineeringRead, (current) => application.readEngineeringWork(current, key));
    },
    readPolicy: (access: AccessContext) =>
      staff(access, supportPermissions.engineeringPolicyRead, (current) => application.readRepositoryPolicy(current)),
    putPolicy: (access: AccessContext, input: EngineeringPolicyPacket, intentFingerprint?: string) =>
      command(access, supportPermissions.engineeringPolicyManage, 'policy_put', 'policy-instance', input,
        (current, packet) => {
          if (intentFingerprint !== undefined && !/^[a-f0-9]{64}$/u.test(intentFingerprint))
            throw new TypeError('Invalid engineering policy intent fingerprint');
          return application.putRepositoryPolicy(current, {
            ...packet,
            ...(intentFingerprint === undefined ? {} : {
              correlationId: 'engineering-policy-intent:' + intentFingerprint,
            }),
          });
        }),
    disableExports: (access: AccessContext, input: EngineeringDisablePacket) =>
      command(access, supportPermissions.engineeringPolicyManage, 'policy_disable', 'policy-instance', input,
        (current, packet) => application.disableEngineeringExports(current, packet)),
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
    async processWork(input: Parameters<SupportDeskEngineering['processWork']>[0]): Promise<SupportEngineeringProcessResult> {
      if (!enabled()) return { outcome: 'held', reason: 'engineering_disabled' };
      if (ports.serviceAccess === undefined) return { outcome: 'held', reason: 'engineering_unavailable' };
      return processing.processWork(structuredClone(input));
    },
    // Separate authority and no generation-config prerequisite, including after withdrawal.
    reconcileSource: (ticketId: string) => coordinator.reconcileSource(ticketId),
  });
}

export type SupportEngineeringRuntime = ReturnType<typeof createSupportEngineeringRuntime>;
