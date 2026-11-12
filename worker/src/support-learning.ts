import { hasPermission, type AccessContext } from '@pegma/authorization-core';
import { createAgentPrincipalResolver } from './agent-authority';
import {
  createSupportLearningHandlers,
  type SupportLearningHandlerOptions,
} from './support-learning-handlers';
import { knowledgePermissions } from '@pegma/knowledge-base-contracts';
import {
  createSupportDeskLearning,
  createSupportDeskStagedLearningReviews,
  createSupportDeskLearningSourceVerifier,
  type LearningProcessResult,
  type LearningRunOptions,
  type LearningScanBounds,
  type LearningReviewCommand,
  type ProcessLearningWorkCommand,
  type SupportDeskLearningOptions,
  type SupportDeskLearningSourceVerifierOptions,
} from '@pegma/support-desk-ai';
import {
  SupportDeskAuthorizationError,
  SupportDeskConflictError,
  type SupportDeskApplication,
  type StaffTicketView,
  type ResolutionLearningSourceResult,
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
import type { IndependentCheckCapture } from './support-independent-checks';
import {
  createSupportLearningKnowledgePort,
  supportLearningCommandIdentity,
  type DirectLearningKnowledge,
  type SupportLearningProcessingPorts,
  type SupportLearningStaffAccess,
  type SupportLearningStaffOperation,
  type SupportLearningStagedReviewOptions,
} from './support-learning-ports';
import type { SupportLearningReviewDispatch } from './support-learning-review-queue';

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
export type LearningReviewIntentPacket = Packet<LearningReviewCommand>;
export type LearningReviewHumanGuard = () => void | Promise<void>;
export type LearningInvalidationPacket = Packet<InvalidateResolutionEvidenceCommand>;
export type LearningWithdrawalPacket = Packet<WithdrawResolutionLearningSourceCommand>;

type LearningIntakeContentFence = 'resolution_unavailable' | 'solution_unavailable' | 'resolution_cycle_changed';

export type LearningIntakeRecoveryResult = {
  readonly ticketId: string;
  readonly commandId: string;
  readonly operation: 'enroll' | 'evidence';
} & (
  | { readonly outcome: 'accepted'; readonly result: ResolutionLearningSourceResult }
  | { readonly outcome: 'pending' }
  | { readonly outcome: 'superseded'; readonly expectedRevision: number; readonly observedRevision: number; readonly fence?: LearningIntakeContentFence }
);

/** Intake is a separate SDK switch from model processing. Neither defaults ON. */
export function supportLearningApplicationOptions(
  options: ResolutionLearningOptions = {},
): ResolutionLearningOptions {
  return Object.freeze({ ...options, enabled: options.enabled === true });
}

/**
 * Construct before KB; pass this SAME verifier to KB and the learning runtime.
 * For a known real SDK graph, explicitly select readScheduling:'sdk' HERE and
 * on SupportLearningRuntimeOptions. The two producer read boundaries opt in
 * independently; no customer field or structural-port detection selects it.
 * Omitted options preserve the serial custom-port path.
 */
export function createSupportLearningSourceBridge(
  options: SupportDeskLearningSourceVerifierOptions,
) {
  return createSupportDeskLearningSourceVerifier(options);
}

export interface SupportLearningRuntimeOptions {
  readonly application: ResolutionLearningApplication & Partial<Pick<SupportDeskApplication, 'readStaffTicket'>>;
  readonly knowledge: DirectLearningKnowledge;
  readonly sources: SupportDeskLearningOptions['sources'];
  readonly clock: Clock;
  readonly staffAccess: SupportLearningStaffAccess;
  /** Server-only staff boundary, including authority, SDK work and final ACK. */
  readonly staffOperationMilliseconds?: number;
  readonly processingEnabled?: () => boolean;
  readonly ports?: Partial<SupportLearningProcessingPorts>;
  readonly processingPortsFor?: (
    key: ResolutionLearningKey,
    capture?: IndependentCheckCapture,
  ) => SupportLearningProcessingPorts | undefined;
  readonly stagedReviews?: SupportLearningStagedReviewOptions;
  /** Explicit only for the known real SDK read graph; custom ports remain serial. */
  readonly readScheduling?: SupportDeskLearningOptions['readScheduling'];
}

export type SupportLearningUnavailableReason =
  | 'unavailable'
  | 'staff_deadline'
  | 'staff_authority_unavailable'
  | 'processing_readiness_unavailable'
  | 'review_checks_unavailable';

export class SupportLearningUnavailableError extends Error {
  readonly code = 'support_learning_unavailable';
  constructor(readonly reason: SupportLearningUnavailableReason = 'unavailable') {
    super('Support learning is unavailable');
    this.name = 'SupportLearningUnavailableError';
  }
}

/**
 * No HTTP, issuer, scheduler, Store or publication authority is created here.
 * The later browser adapter must also fence its original cookie/session/headers.
 */
export function createSupportLearningRuntime(options: SupportLearningRuntimeOptions) {
  return createLearningRuntime(options);
}

// Only this module can select the browser lane. Its AccessContext-taking
// implementation is never returned from a browser composition factory.
const browserLane = Symbol('support-learning-browser-lane');

function createLearningRuntime(
  options: SupportLearningRuntimeOptions,
  lane?: typeof browserLane,
) {
  const ports = options.ports ?? {};
  const staffOperationMilliseconds = options.staffOperationMilliseconds ?? 25_000;
  if (!Number.isSafeInteger(staffOperationMilliseconds) ||
    staffOperationMilliseconds < 1 || staffOperationMilliseconds > 25_000)
    throw new TypeError('Invalid staff operation boundary');
  const processingEnabled = (): boolean => {
    try { return options.processingEnabled?.() === true; }
    catch { throw new SupportLearningUnavailableError('processing_readiness_unavailable'); }
  };
  const unavailable = async (): Promise<never> => {
    throw new SupportLearningUnavailableError();
  };
  const unavailableChecks: SupportLearningProcessingPorts['checks'] = {
    resolvePolicy: async () => ({ outcome: 'unavailable' }),
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
    checks: ports.checks ?? unavailableChecks,
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
    storageCommandAttempts: 2,
    ...(options.readScheduling === undefined ? {} : { readScheduling: options.readScheduling }),
  };
  const coordinator = createSupportDeskLearning(coordinatorOptions);
  function stagedEnabled(): boolean {
    try { return options.stagedReviews?.enabled() === true; } catch { return false; }
  }
  function stagedCoordinator() {
    if (!stagedEnabled()) throw new SupportLearningUnavailableError();
    return createSupportDeskStagedLearningReviews({
      ...coordinatorOptions,
      maxOperationMilliseconds: staffOperationMilliseconds,
      async resolveActor({ principalId, signal }) {
        if (!stagedEnabled() || signal.aborted) throw new SupportLearningUnavailableError();
        const access = await options.staffAccess.resolve(principalId, signal);
        if (!stagedEnabled() || signal.aborted) throw new SupportLearningUnavailableError();
        return access;
      },
    });
  }
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
    operation: (access: AccessContext, boundary: {
      readonly signal: AbortSignal;
      ensure(): void;
      current(): Promise<AccessContext>;
    }) => Promise<Result>,
  ): Promise<Result> {
    const bound = structuredClone(original);
    // Ordinary intake/evidence/withdrawal retain their standalone resolver
    // path. Only reads and the exact review protocol share browser fences.
    const browserOperation = lane === browserLane &&
      (permission === supportPermissions.learningRead || permission === supportPermissions.learningReview);
    const started = performance.now();
    const controller = new AbortController();
    const ensure = (): void => {
      if (controller.signal.aborted || performance.now() - started >= staffOperationMilliseconds)
        throw new SupportLearningUnavailableError('staff_deadline');
    };
    let rejectDeadline: (error: Error) => void = () => {};
    const deadline = new Promise<never>((_resolve, reject) => { rejectDeadline = reject; });
    const timer = setTimeout(() => {
      rejectDeadline(new SupportLearningUnavailableError('staff_deadline'));
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
    const current = async (): Promise<AccessContext> => {
      ensure();
      if (original.principalId !== bound.principalId)
        throw new SupportDeskAuthorizationError(permission);
      let resolved: AccessContext | null;
      try {
        resolved = await within(() => options.staffAccess.resolve(bound.principalId, controller.signal));
      } catch {
        ensure();
        throw new SupportLearningUnavailableError('staff_authority_unavailable');
      }
      if (
        resolved === null || resolved.principalId !== bound.principalId ||
        original.principalId !== bound.principalId
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
      let access: AccessContext;
      if (browserOperation) {
        // The private HTTP handler has just resolved the original browser's
        // current roles, Identity and session. Do not immediately repeat only
        // its roles/Identity subset. No caller can supply this internal lane.
        ensure();
        if (original.principalId !== bound.principalId || !hasPermission(bound, permission))
          throw new SupportDeskAuthorizationError(permission);
        if (!hasPermission(bound, supportPermissions.queueRead))
          throw new SupportDeskAuthorizationError(supportPermissions.queueRead);
        access = bound;
      } else {
        access = await current();
      }
      const result = await within(() => operation(access, { signal: controller.signal, ensure, current }));
      // Revocation can withhold an ACK after a committed SDK mutation. The
      // same deadline also bounds direct SDK calls that cannot be cancelled.
      // A late commit remains unknown until the original immutable packet is
      // replayed; timeout neither rolls it back nor launches another mutation.
      // The Request-only browser lane performs its complete fresh browser
      // closing check and synchronous response projection in the handler.
      // Proof-time current() above still resolves independently in both lanes.
      if (!browserOperation) await current();
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
    invoke: (current: AccessContext, packet: Omit<Command, 'clientCommandId'> & { commandId: string; correlationId: string }, signal: AbortSignal, boundary: {
      readonly signal: AbortSignal;
      ensure(): void;
      current(): Promise<AccessContext>;
    }) => Promise<Result>,
  ) {
    const packet = structuredClone(input);
    const actor = access.principalId;
    return staff(access, permission, async (current, boundary) => {
      const { clientCommandId, ...fields } = packet;
      const identity = await supportLearningCommandIdentity({
        principalId: actor, ticketId: packet.ticketId, operation, clientCommandId,
      });
      boundary.ensure();
      return invoke(current, { ...fields, ...identity }, boundary.signal, boundary);
    });
  }

  function recoverIntake<Command extends { readonly ticketId: string; readonly clientCommandId: string; readonly expectedRevision: number }>(
    access: AccessContext, operation: 'enroll' | 'evidence', input: Command,
    invoke: (current: AccessContext, packet: Omit<Command, 'clientCommandId'> & { commandId: string; correlationId: string }) => Promise<ResolutionLearningSourceResult>,
    contentFence?: (view: StaffTicketView, packet: Omit<Command, 'clientCommandId'>,
      current: () => Promise<AccessContext>) => Promise<LearningIntakeContentFence | undefined>,
  ): Promise<LearningIntakeRecoveryResult> {
    return command(access, supportPermissions.learningEvidenceSubmit, operation === 'enroll' ? 'enroll' : 'verified_fix', input,
      async (current, packet, _signal, boundary): Promise<LearningIntakeRecoveryResult> => {
        const scope = { ticketId: packet.ticketId, commandId: packet.commandId, operation };
        // An exact accepted ACK wins before any mutable ticket observation.
        try { return { ...scope, outcome: 'accepted', result: await invoke(current, packet) }; }
        catch (error) { boundary.ensure(); if (!(error instanceof SupportDeskConflictError)) throw error; }
        const read = options.application.readStaffTicket;
        if (read === undefined) throw new SupportLearningUnavailableError();
        const view = await read.call(options.application, await boundary.current(), packet.ticketId);
        boundary.ensure();
        const revision = view.ticket.revision;
        if (view.ticket.id !== packet.ticketId || !Number.isSafeInteger(revision) || revision < 1)
          throw new SupportLearningUnavailableError();
        if (revision < packet.expectedRevision) return { ...scope, outcome: 'pending' };
        const fence = revision === packet.expectedRevision
          ? await contentFence?.(view, packet, boundary.current) : undefined;
        boundary.ensure();
        if (revision === packet.expectedRevision && fence === undefined) return { ...scope, outcome: 'pending' };
        // A newer revision or an immutable prerequisite at this exact revision
        // excludes future application. Public message/status/cycle repairs
        // advance the ticket revision. Retry the exact command AFTER the proof
        // so a raced accepted receipt wins before ownership is released.
        try { return { ...scope, outcome: 'accepted', result: await invoke(await boundary.current(), packet) }; }
        catch (error) { boundary.ensure(); if (!(error instanceof SupportDeskConflictError)) throw error; }
        // This proves that the old revision cannot act in the future. Earlier
        // acceptance may remain historically unknown for retained legacy data.
        return { ...scope, outcome: 'superseded', expectedRevision: packet.expectedRevision, observedRevision: revision,
          ...(fence === undefined ? {} : { fence }) };
      });
  }

  function processingState(): 'disabled' | 'readiness_unavailable' | 'ready' {
    try { if (!processingEnabled()) return 'disabled'; }
    catch { return 'readiness_unavailable'; }
    return 'ready';
  }

  function processingReady(selected: Partial<SupportLearningProcessingPorts> = ports): 'disabled' | 'readiness_unavailable' | 'unavailable' | 'ready' {
    const state = processingState();
    if (state !== 'ready') return state;
    return [selected.serviceAccess, selected.knowledgeAccess, selected.retirementAccess,
      selected.configuration, selected.checks, selected.model, selected.usage, selected.targets,
      selected.tokenCounter].some((port) => port === undefined) ? 'unavailable' : 'ready';
  }

  async function reviewCommand<Result>(
    access: AccessContext,
    input: LearningReviewIntentPacket,
    invoke: (current: AccessContext, packet: LearningReviewCommand, boundary: {
      readonly signal: AbortSignal;
      ensure(): void;
      current(): Promise<AccessContext>;
    }) => Promise<Result>,
  ): Promise<Result> {
    const bound = structuredClone(input);
    return staff(access, supportPermissions.learningReview, async (current, boundary) => {
      if (bound.intent.reviewerId !== current.principalId)
        throw new SupportDeskAuthorizationError(supportPermissions.learningReview);
      const { clientCommandId, ...fields } = bound;
      const identity = await supportLearningCommandIdentity({ principalId: current.principalId,
        ticketId: bound.intent.ticketId, operation: 'review', clientCommandId });
      boundary.ensure();
      return invoke(current, { ...fields, ...identity }, boundary);
    });
  }

  function guardedReviewCoordinator(boundary: {
    readonly signal: AbortSignal;
    ensure(): void;
    current(): Promise<AccessContext>;
  }, verifyHumanBeforeCommit?: LearningReviewHumanGuard) {
    const verifyCurrentReviewer = async () => {
      const access = await boundary.current();
      for (const permission of [knowledgePermissions.draftRead, knowledgePermissions.provenanceRead])
        if (!hasPermission(access, permission)) throw new SupportDeskAuthorizationError(permission);
      await verifyHumanBeforeCommit?.(); boundary.ensure();
    };
    return createSupportDeskLearning({ ...coordinatorOptions,
      application: { ...options.application, async reviewResolutionLearningProposal(actor, packet, guard) {
        return options.application.reviewResolutionLearningProposal(actor, packet, async () => {
          await verifyCurrentReviewer();
          await guard();
          await verifyCurrentReviewer();
        });
      } },
    });
  }

  return Object.freeze({
    enroll: (access: AccessContext, input: LearningEnrollmentPacket) =>
      command(access, supportPermissions.learningEvidenceSubmit, 'enroll', input,
        (current, packet) => options.application.enrollResolutionLearning(current, packet)),
    submitVerifiedFix: (access: AccessContext, input: LearningVerifiedFixPacket) =>
      command(access, supportPermissions.learningEvidenceSubmit, 'verified_fix', input,
        (current, packet) => options.application.submitResolutionEvidence(current, packet)),
    recoverEnrollment: (access: AccessContext, input: LearningEnrollmentPacket) =>
      recoverIntake(access, 'enroll', input, (current, packet) => options.application.enrollResolutionLearning(current, packet)),
    recoverVerifiedFix: (access: AccessContext, input: LearningVerifiedFixPacket) =>
      recoverIntake(access, 'evidence', input, (current, packet) => options.application.submitResolutionEvidence(current, packet),
        async (view, packet, current) => {
          if (!['resolved', 'closed'].includes(view.ticket.status) || view.ticket.resolvedAt === undefined)
            return 'resolution_unavailable';
          if (!view.messages.some((message) => message.id === packet.evidence.solutionMessageId && message.visibility === 'customer'))
            return 'solution_unavailable';
          // Resolution cycles only advance with public ticket mutations.
          // The separate public read requires its own existing permission.
          const access = await current();
          if (!hasPermission(access, supportPermissions.learningRead)) return undefined;
          const source = await options.application.readResolutionLearningSource(access, packet.ticketId);
          if (source.ticketId !== packet.ticketId || !Number.isSafeInteger(source.resolutionCycle) || source.resolutionCycle < 1)
            throw new SupportLearningUnavailableError();
          return source.resolutionCycle !== packet.resolutionCycle ? 'resolution_cycle_changed' : undefined;
        }),
    reviewProposal(access: AccessContext, input: LearningReviewPacket,
      verifyHumanBeforeCommit?: LearningReviewHumanGuard) {
      if (verifyHumanBeforeCommit !== undefined && typeof verifyHumanBeforeCommit !== 'function')
        throw new TypeError('Review submission requires a callable current-human guard');
      return command(access, supportPermissions.learningReview, 'review', input,
        (current, packet, _signal, boundary) => {
          if (ports.checks === undefined)
            throw new SupportLearningUnavailableError('review_checks_unavailable');
          // SDK guards share this staff boundary instead of starting another
          // independent host timer around the same review operation.
          return guardedReviewCoordinator(boundary, verifyHumanBeforeCommit)
            .reviewProposal(current, packet, { signal: boundary.signal });
        });
    },
    prepareReviewIntent(access: AccessContext, key: ResolutionLearningKey) {
      const bound = structuredClone(key);
      return staff(access, supportPermissions.learningReview, (current, boundary) =>
        coordinator.prepareReviewIntent(current, bound, { signal: boundary.signal }));
    },
    submitReviewIntent(access: AccessContext, input: LearningReviewIntentPacket,
      verifyHumanBeforeCommit: LearningReviewHumanGuard) {
      if (typeof verifyHumanBeforeCommit !== 'function')
        throw new TypeError('Review submission requires a current-human guard');
      return reviewCommand(access, input, (current, packet, boundary) => {
        const guarded = guardedReviewCoordinator(boundary, verifyHumanBeforeCommit);
        return guarded.submitReviewIntent(current, packet, { signal: boundary.signal });
      });
    },
    /** No model call or review acceptance occurs in this HTTP admission. */
    admitReviewIntent(access: AccessContext, input: LearningReviewIntentPacket,
      verifyHumanBeforeCommit: LearningReviewHumanGuard) {
      if (typeof verifyHumanBeforeCommit !== 'function')
        throw new TypeError('Review admission requires a current-human guard');
      return reviewCommand(access, input, async (current, packet, boundary) => {
        const result = await stagedCoordinator().admitReviewIntent(current, packet, {
          signal: boundary.signal,
          async verifyBeforeCommit() {
            boundary.ensure();
            if (!stagedEnabled()) throw new SupportLearningUnavailableError();
            await verifyHumanBeforeCommit();
            boundary.ensure();
            if (!stagedEnabled()) throw new SupportLearningUnavailableError();
            return (): true => {
              boundary.ensure();
              if (!stagedEnabled()) throw new SupportLearningUnavailableError();
              return true;
            };
          },
        });
        // Admission has already committed. A lost acceleration hint never
        // changes the honest durable result; the SDK scan recovers it.
        if (result.outcome === 'pending') {
          try { await options.stagedReviews?.enqueue({ ticketId: packet.intent.ticketId, commandId: packet.commandId }); }
          catch { /* The SDK pending row remains the authoritative outbox. */ }
        }
        return result;
      });
    },
    readStagedReviewStatus: (access: AccessContext, input: LearningReviewIntentPacket) =>
      reviewCommand(access, input, (current, packet, boundary) =>
        stagedCoordinator().readReviewStatus(current, packet, { signal: boundary.signal })),
    cancelStagedReview(access: AccessContext, input: LearningReviewIntentPacket,
      verifyHumanBeforeCommit: LearningReviewHumanGuard) {
      if (typeof verifyHumanBeforeCommit !== 'function')
        throw new TypeError('Review cancellation requires a current-human guard');
      return reviewCommand(access, input, (current, packet, boundary) =>
        stagedCoordinator().cancelReview(current, packet, { signal: boundary.signal,
          async verifyBeforeCommit() {
            boundary.ensure();
            if (!stagedEnabled()) throw new SupportLearningUnavailableError();
            await verifyHumanBeforeCommit();
            boundary.ensure();
            return (): true => {
              boundary.ensure();
              if (!stagedEnabled()) throw new SupportLearningUnavailableError();
              return true;
            };
          },
        }));
    },
    stagedReviewDispatch(): SupportLearningReviewDispatch {
      return Object.freeze<SupportLearningReviewDispatch>({
        scanPending: (bounds) => stagedCoordinator().scanPending(bounds),
        async process(input) {
          const result = await stagedCoordinator().processReview(input);
          // Only authoritative no-pending or a canonical completed receipt
          // retires the transport hint. Every other result remains discoverable.
          return result.outcome === 'not_pending' || result.outcome === 'completed' ? 'settled' : 'pending';
        },
      });
    },
    readReviewReceipt: (access: AccessContext, input: LearningReviewIntentPacket) =>
      reviewCommand(access, input, (current, packet, boundary) =>
        coordinator.readReviewReceipt(current, packet, { signal: boundary.signal })),
    cancelReview(access: AccessContext, input: LearningReviewIntentPacket,
      verifyHumanBeforeCommit: LearningReviewHumanGuard) {
      if (typeof verifyHumanBeforeCommit !== 'function')
        throw new TypeError('Review cancellation requires a current-human guard');
      return reviewCommand(access, input, (current, packet, boundary) =>
        coordinator.cancelReview(current, packet, { signal: boundary.signal,
          async verifyBeforeCommit() {
            await boundary.current(); await verifyHumanBeforeCommit(); boundary.ensure();
          },
        }));
    },
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
    // Discovery uses current source authority even when paid processing is OFF.
    scanMaintenanceCandidates: (bounds: LearningScanBounds) =>
      coordinator.scanCandidates(structuredClone(bounds)),
    async processWork(input: ProcessLearningWorkCommand, run?: LearningRunOptions,
      capture?: IndependentCheckCapture): Promise<LearningProcessResult> {
      const packet = structuredClone(input);
      let scoped: SupportLearningProcessingPorts | undefined;
      if (options.processingPortsFor !== undefined) {
        // Readiness precedes scoped construction; no Work claim occurs on failure.
        const state = processingState();
        if (state !== 'ready') return { outcome: 'held', reason: `learning_${state}` };
        try {
          scoped = options.processingPortsFor({ ticketId: packet.ticketId,
            sourceGeneration: packet.sourceGeneration }, capture);
        } catch {
          return { outcome: 'held', reason: 'learning_unavailable' };
        }
        if (scoped === undefined) return { outcome: 'held', reason: 'learning_unavailable' };
      }
      const state = processingReady(scoped ?? ports);
      if (state !== 'ready') return { outcome: 'held', reason: `learning_${state}` };
      if (scoped === undefined) return processingCoordinator.processWork(packet, run);
      const selected = scoped;
      const operation = createSupportDeskLearning({
        ...coordinatorOptions,
        ...selected,
        serviceAccess: {
          async resolve(signal) {
            if (!processingEnabled()) return { outcome: 'inactive' };
            const result = await selected.serviceAccess.resolve(signal);
            return processingEnabled() ? result : { outcome: 'inactive' };
          },
        },
        configuration: {
          async resolve(expected, signal) {
            if (!processingEnabled()) return { outcome: 'disabled' };
            const result = await selected.configuration.resolve(expected, signal);
            return processingEnabled() ? result : { outcome: 'disabled' };
          },
        },
      });
      return operation.processWork(packet, run);
    },
    // Privacy and source reconciliation stay available independently of the
    // generation switch and provider configuration. The SDK checks authority.
    reconcileSource: (ticketId: string, run?: LearningRunOptions) => coordinator.reconcileSource(ticketId, run),
  });
}

export type SupportLearningRuntime = ReturnType<typeof createSupportLearningRuntime>;

/**
 * Trusted host composition, returning only a Request handler. Original browser
 * coordinates and permission ceilings are created inside the existing handler;
 * no optimized access-taking method or authority observation escapes here.
 */
export function createSupportLearningBrowserHandlers(
  options: Omit<SupportLearningHandlerOptions, 'runtime'> & {
    readonly learning: Omit<SupportLearningRuntimeOptions, 'staffAccess'>;
  },
): (request: Request) => Promise<Response | null> {
  const { learning, ...browser } = options;
  const resolve = createAgentPrincipalResolver(browser);
  let runtime: SupportLearningRuntime | undefined;
  return createSupportLearningHandlers({
    ...browser,
    stagedReviewsEnabled: () => {
      try { return learning.stagedReviews?.enabled() === true; } catch { return false; }
    },
    runtime() {
      // SDK composition is lazy; disabled and unauthenticated requests do not
      // construct it. This closure retains no browser or permission snapshot.
      runtime ??= createLearningRuntime({
        ...learning,
        staffAccess: {
          async resolve(principalId, signal) {
            if (signal.aborted) throw new SupportLearningUnavailableError('staff_deadline');
            const access = await resolve(principalId);
            if (signal.aborted) throw new SupportLearningUnavailableError('staff_deadline');
            return access;
          },
        },
      }, browserLane);
      return runtime;
    },
  });
}
