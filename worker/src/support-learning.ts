import { hasPermission, type AccessContext } from '@pegma/authorization-core';
import {
  createSupportDeskLearning,
  createSupportDeskLearningSourceVerifier,
  type LearningProcessResult,
  type LearningScanBounds,
  type ProcessLearningWorkCommand,
  type SupportDeskLearningOptions,
  type SupportDeskLearningSourceVerifierOptions,
} from '@pegma/support-desk-ai';
import {
  SupportDeskAuthorizationError,
  supportPermissions,
  type EnrollResolutionLearningCommand,
  type InvalidateResolutionEvidenceCommand,
  type ResolutionLearningApplication,
  type ResolutionLearningKey,
  type ResolutionLearningOptions,
  type ReviewResolutionLearningProposalCommand,
  type SubmitResolutionEvidenceCommand,
  type WithdrawResolutionLearningSourceCommand,
} from '@pegma/support-desk-application';
import type { Clock } from '@pegma/spine';
import {
  createSupportLearningKnowledgePort,
  supportLearningCommandIdentity,
  type DirectLearningKnowledge,
  type SupportLearningProcessingPorts,
  type SupportLearningStaffAccess,
  type SupportLearningStaffOperation,
} from './support-learning-ports';

type Packet<Command> = Omit<Command, 'commandId' | 'correlationId'> & {
  readonly clientCommandId: string;
};
export type LearningEnrollmentPacket = Packet<EnrollResolutionLearningCommand>;
export type LearningVerifiedFixPacket = Packet<
  Omit<SubmitResolutionEvidenceCommand, 'evidence'> & {
    readonly evidence: Extract<
      SubmitResolutionEvidenceCommand['evidence'],
      { readonly kind: 'staff_verified_fix' }
    >;
  }
>;
export type LearningReviewPacket = Packet<ReviewResolutionLearningProposalCommand>;
export type LearningInvalidationPacket = Packet<InvalidateResolutionEvidenceCommand>;
export type LearningWithdrawalPacket = Packet<WithdrawResolutionLearningSourceCommand>;

/** Intake is a separate SDK switch from model processing. Neither defaults ON. */
export function supportLearningApplicationOptions(
  options: ResolutionLearningOptions = {},
): ResolutionLearningOptions {
  return Object.freeze({ ...options, enabled: options.enabled === true });
}

/** Construct before KB; pass this SAME verifier to KB and the learning runtime. */
export function createSupportLearningSourceBridge(
  options: SupportDeskLearningSourceVerifierOptions,
) {
  return createSupportDeskLearningSourceVerifier(options);
}

export interface SupportLearningRuntimeOptions {
  readonly application: ResolutionLearningApplication;
  readonly knowledge: DirectLearningKnowledge;
  readonly sources: SupportDeskLearningOptions['sources'];
  readonly clock: Clock;
  readonly staffAccess: SupportLearningStaffAccess;
  readonly processingEnabled?: () => boolean;
  readonly ports?: Partial<SupportLearningProcessingPorts>;
}

export class SupportLearningUnavailableError extends Error {
  readonly code = 'support_learning_unavailable';
  constructor() {
    super('Support learning is unavailable');
    this.name = 'SupportLearningUnavailableError';
  }
}

/**
 * No HTTP, issuer, scheduler, Store or publication authority is created here.
 * The later browser adapter must also fence its original cookie/session/headers.
 */
export function createSupportLearningRuntime(options: SupportLearningRuntimeOptions) {
  const ports = options.ports ?? {};
  const processingEnabled = (): boolean => {
    try { return options.processingEnabled?.() === true; }
    catch { return false; }
  };
  const unavailable = async (): Promise<never> => {
    throw new SupportLearningUnavailableError();
  };
  const disabledChecks: SupportLearningProcessingPorts['checks'] = {
    resolvePolicy: async () => ({ outcome: 'disabled' }),
    check: async () => ({ outcome: 'held' }),
    verify: async () => null,
  };
  const coordinatorOptions: SupportDeskLearningOptions = {
    application: options.application,
    knowledge: createSupportLearningKnowledgePort(options.knowledge),
    sources: options.sources,
    clock: options.clock,
    serviceAccess: ports.serviceAccess ?? { resolve: async () => ({ outcome: 'inactive' }) },
    knowledgeAccess: ports.knowledgeAccess ?? { resolve: async () => ({ outcome: 'inactive' }) },
    retirementAccess: ports.retirementAccess ?? { resolve: async () => ({ outcome: 'inactive' }) },
    configuration: {
      async resolve(expected, signal) {
        if (!processingEnabled() || ports.configuration === undefined)
          return { outcome: 'disabled' };
        const result = await ports.configuration.resolve(expected, signal);
        return processingEnabled() ? result : { outcome: 'disabled' };
      },
    },
    checks: ports.checks ?? disabledChecks,
    model: ports.model ?? { generate: unavailable },
    usage: ports.usage ?? {
      reserve: async () => ({ outcome: 'denied' }),
      reconcile: async () => 'pending',
    },
    targets: ports.targets ?? {
      resolveScope: async () => ({ outcome: 'held' }),
      select: async () => ({ outcome: 'held' }),
    },
    tokenCounter: ports.tokenCounter ?? { count: () => { throw new SupportLearningUnavailableError(); } },
    maxOperationMilliseconds: 25_000,
    storageCommandAttempts: 2,
  };
  const coordinator = createSupportDeskLearning(coordinatorOptions);
  // The process coordinator checks the host switch at each SDK service fence.
  // The review/reconciliation coordinator retains independent read authority.
  const processingCoordinator = createSupportDeskLearning({
    ...coordinatorOptions,
    serviceAccess: {
      async resolve(signal) {
        if (!processingEnabled() || ports.serviceAccess === undefined)
          return { outcome: 'inactive' };
        const result = await ports.serviceAccess.resolve(signal);
        return processingEnabled() ? result : { outcome: 'inactive' };
      },
    },
  });

  async function staff<Result>(
    original: AccessContext,
    permission: string,
    operation: (access: AccessContext) => Promise<Result>,
  ): Promise<Result> {
    const bound = structuredClone(original);
    const controller = new AbortController();
    let rejectDeadline: (error: Error) => void = () => {};
    const deadline = new Promise<never>((_resolve, reject) => { rejectDeadline = reject; });
    const timer = setTimeout(() => {
      controller.abort();
      rejectDeadline(new SupportLearningUnavailableError());
    }, 25_000);
    const current = async (): Promise<AccessContext> => {
      if (original.principalId !== bound.principalId || controller.signal.aborted)
        throw new SupportDeskAuthorizationError(permission);
      let resolved: AccessContext | null;
      try {
        resolved = await Promise.race([
          options.staffAccess.resolve(bound.principalId, controller.signal),
          deadline,
        ]);
      } catch {
        throw new SupportLearningUnavailableError();
      }
      if (
        resolved === null || resolved.principalId !== bound.principalId ||
        original.principalId !== bound.principalId || controller.signal.aborted
      )
        throw new SupportDeskAuthorizationError(permission);
      const access: AccessContext = {
        principalId: bound.principalId,
        policyVersion: resolved.policyVersion,
        roles: resolved.roles.filter((role) => bound.roles.includes(role)),
        entitlements: resolved.entitlements.filter((entry) => bound.entitlements.includes(entry)),
        permissions: resolved.permissions.filter((entry) => bound.permissions.includes(entry)),
      };
      if (!hasPermission(access, permission))
        throw new SupportDeskAuthorizationError(permission);
      if (!hasPermission(access, supportPermissions.queueRead))
        throw new SupportDeskAuthorizationError(supportPermissions.queueRead);
      return access;
    };
    try {
      const access = await current();
      const result = await operation(access);
      // Revocation can withhold an ACK after a committed SDK mutation. The
      // original immutable packet remains replayable; no rollback is invented.
      await current();
      return result;
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }

  async function command<Command extends { readonly ticketId: string; readonly clientCommandId: string }, Result>(
    access: AccessContext,
    permission: string,
    operation: SupportLearningStaffOperation,
    input: Command,
    invoke: (current: AccessContext, packet: Omit<Command, 'clientCommandId'> & { commandId: string; correlationId: string }) => Promise<Result>,
  ) {
    const packet = structuredClone(input);
    const actor = access.principalId;
    return staff(access, permission, async (current) => {
      const { clientCommandId, ...fields } = packet;
      const identity = await supportLearningCommandIdentity({
        principalId: actor, ticketId: packet.ticketId, operation, clientCommandId,
      });
      return invoke(current, { ...fields, ...identity });
    });
  }

  function processingReady(): 'disabled' | 'unavailable' | 'ready' {
    if (!processingEnabled()) return 'disabled';
    return [ports.serviceAccess, ports.knowledgeAccess, ports.retirementAccess,
      ports.configuration, ports.checks, ports.model, ports.usage, ports.targets,
      ports.tokenCounter].some((port) => port === undefined) ? 'unavailable' : 'ready';
  }

  return Object.freeze({
    enroll: (access: AccessContext, input: LearningEnrollmentPacket) =>
      command(access, supportPermissions.learningEvidenceSubmit, 'enroll', input,
        (current, packet) => options.application.enrollResolutionLearning(current, packet)),
    submitVerifiedFix: (access: AccessContext, input: LearningVerifiedFixPacket) =>
      command(access, supportPermissions.learningEvidenceSubmit, 'verified_fix', input,
        (current, packet) => options.application.submitResolutionEvidence(current, packet)),
    reviewProposal: (access: AccessContext, input: LearningReviewPacket) =>
      command(access, supportPermissions.learningReview, 'review', input,
        (current, packet) => coordinator.reviewProposal(current, packet)),
    invalidate: (access: AccessContext, input: LearningInvalidationPacket) =>
      command(access, supportPermissions.learningEvidenceSubmit, 'invalidate', input,
        (current, packet) => options.application.invalidateResolutionEvidence(current, packet)),
    withdraw: (access: AccessContext, input: LearningWithdrawalPacket) =>
      command(access, supportPermissions.learningWithdraw, 'withdraw', input,
        (current, packet) => options.application.withdrawResolutionLearningSource(current, packet)),
    readSource: (access: AccessContext, ticketId: string) =>
      staff(access, supportPermissions.learningRead, (current) =>
        options.application.readResolutionLearningSource(current, ticketId)),
    readWork(access: AccessContext, key: ResolutionLearningKey) {
      const bound = structuredClone(key);
      return staff(access, supportPermissions.learningRead, (current) =>
        options.application.readResolutionLearningWork(current, bound));
    },
    async scanCandidates(bounds: LearningScanBounds) {
      const state = processingReady();
      if (state !== 'ready') return { outcome: 'held' as const, reason: `learning_${state}` };
      return processingCoordinator.scanCandidates(structuredClone(bounds));
    },
    async processWork(input: ProcessLearningWorkCommand): Promise<LearningProcessResult> {
      const state = processingReady();
      if (state !== 'ready') return { outcome: 'held', reason: `learning_${state}` };
      return processingCoordinator.processWork(structuredClone(input));
    },
    // Privacy and source reconciliation stay available independently of the
    // generation switch and provider configuration. The SDK checks authority.
    reconcileSource: (ticketId: string) => coordinator.reconcileSource(ticketId),
  });
}

export type SupportLearningRuntime = ReturnType<typeof createSupportLearningRuntime>;
