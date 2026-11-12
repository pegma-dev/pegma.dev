import {
  hasPermission,
  serializeAccessContext,
  type AccessContext,
} from "@pegma/authorization-core";
import type { Clock } from "@pegma/spine";
import { defineCollection, type Store } from "@pegma/storage-core";
import { knowledgeDigest as evidenceDigest } from "@pegma/knowledge-base-core";
import { knowledgePermissions } from "@pegma/knowledge-base-contracts";
import type {
  GovernanceConfigurationDto,
  KnowledgeBaseApplication,
  KnowledgeEvidenceReports,
} from "@pegma/knowledge-base-application";
import {
  KnowledgeEvidenceReportsError,
  KnowledgeEvidenceReportsUnavailableError,
} from "@pegma/knowledge-base-application";
import {
  supportPermissions,
  type ResolutionProductContext,
  type ResolutionProductContextPort,
  type ResolutionTestReceiptPort,
  type ResolutionTrustContext,
  type SupportDeskApplication,
} from "@pegma/support-desk-application";
import { knowledgeDigest } from "./knowledge-evidence";
import { KNOWLEDGE_EVIDENCE_CONFIRM_PERMISSION } from "./support-access";

const MAX_REFERENCES = 16;
const MAX_ROW_BYTES = 65_536;
const MAX_ATTEMPTS = 3;
const encoder = new TextEncoder();

export interface TestReceiptStaffContext {
  readonly principalId: string;
  readonly signal?: AbortSignal;
  readonly current: (signal: AbortSignal) => Promise<AccessContext>;
}

export interface PrepareLearningTestReceipt {
  readonly ticketId: string;
  readonly expectedRevision: number;
  readonly resolutionCycle: number;
  readonly solutionMessageId: string;
  readonly clientCommandId: string;
  readonly report: {
    readonly articleId: string;
    readonly ledgerEpoch: number;
    readonly reportId: string;
    readonly expectedReportGeneration: number;
    readonly reviewBindingHash: string;
    readonly receipt: string;
  };
}

type SupportReads = Pick<
  SupportDeskApplication,
  "readStaffTicket" | "readResolutionLearningSource"
>;
type KnowledgeReads = Pick<
  KnowledgeBaseApplication,
  "getAuthoringContext" | "confirmAuthoringContext"
>;
type ReportReads = Pick<
  KnowledgeEvidenceReports,
  "read" | "verifier" | "observations"
>;
interface BoundPorts {
  readonly support: SupportReads;
  readonly knowledge: KnowledgeReads;
  readonly reports: ReportReads;
}

type ProductBinding = Pick<
  ResolutionProductContext,
  "productId" | "version" | "buildId" | "binding" | "contextVersion"
>;

export interface LearningTestReceiptOptions {
  readonly store: Store;
  readonly clock: Clock;
  readonly support: () => SupportReads | undefined;
  readonly knowledge: () => KnowledgeReads | undefined;
  readonly reports: () => ReportReads | undefined;
  readonly productContext: ResolutionProductContextPort;
  /** Current server-resolved facts only. This never acts as another principal. */
  readonly resolvePrincipal: (
    principalId: string,
    signal: AbortSignal,
  ) => Promise<AccessContext | null>;
  /** Root-owned actual public KB reads under existing governance authority.
   * The association actor is not granted validation-management permission. */
  readonly readGovernance: (
    collectionId: string,
    signal: AbortSignal,
  ) => Promise<GovernanceConfigurationDto | null>;
  readonly retentionMilliseconds: number;
  readonly operationMilliseconds?: number;
}

interface Reference {
  readonly id: string;
  readonly commandHash: string;
  readonly inputHash: string;
  readonly actorId: string;
  readonly prepared: PrepareLearningTestReceipt;
  readonly resolvedAt: string;
  readonly sourceFingerprint: string;
  readonly product: ProductBinding;
  readonly reportFingerprint: string;
  readonly reportSubmitterId: string;
  readonly reportReviewerId: string;
  readonly reportConfirmedAt: string;
  readonly executionId: string;
  readonly runnerId: string;
  readonly testId: string;
  readonly executedAt: string;
  readonly verifiedAt: string;
  readonly validUntil: string;
  readonly retainUntil: string;
}
interface BindingRow {
  readonly partition: string;
  readonly id: "bindings";
  readonly ticketId: string;
  readonly references: readonly Reference[];
}

export class LearningTestReceiptError extends Error {
  readonly name = "LearningTestReceiptError";
  constructor(
    readonly code:
      "invalid" | "forbidden" | "changed" | "unavailable" | "capacity",
  ) {
    super("The approved test association is unavailable.");
  }
}

function refuse(code: LearningTestReceiptError["code"]): never {
  throw new LearningTestReceiptError(code);
}
async function reportBoundary<Value>(
  read: () => Promise<Value>,
): Promise<Value> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof KnowledgeEvidenceReportsUnavailableError)
      refuse("unavailable");
    if (error instanceof KnowledgeEvidenceReportsError)
      refuse(error.code === "forbidden" ? "forbidden" : "changed");
    throw error;
  }
}
function text(value: unknown, maximum = 200): asserts value is string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maximum ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    refuse("invalid");
}
function exactKeys(value: unknown, fields: readonly string[]): void {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((field) => !fields.includes(field)) ||
    fields.some((field) => !Object.hasOwn(value, field))
  )
    refuse("invalid");
}
function positive(value: number) {
  if (!Number.isSafeInteger(value) || value < 1) refuse("invalid");
}
function instant(value: string): number {
  const result = Date.parse(value);
  if (!Number.isFinite(result)) refuse("invalid");
  return result;
}
function stableProduct(product: ResolutionProductContext): ProductBinding {
  return {
    productId: product.productId,
    version: product.version,
    buildId: product.buildId,
    binding: product.binding,
    contextVersion: product.contextVersion,
  };
}
function authority(access: AccessContext) {
  return JSON.stringify(serializeAccessContext(access));
}
function actorPermissions(access: AccessContext) {
  for (const permission of [
    supportPermissions.learningEvidenceSubmit,
    knowledgePermissions.draftRead,
    knowledgePermissions.evidenceRead,
  ]) {
    if (!hasPermission(access, permission)) refuse("forbidden");
  }
}
function reviewerPermissions(access: AccessContext) {
  for (const permission of [
    KNOWLEDGE_EVIDENCE_CONFIRM_PERMISSION,
    knowledgePermissions.draftRead,
    knowledgePermissions.evidenceRead,
  ]) {
    if (!hasPermission(access, permission)) refuse("forbidden");
  }
  if (
    !hasPermission(access, knowledgePermissions.evidenceSubmit) &&
    !hasPermission(access, knowledgePermissions.draftWrite)
  )
    refuse("forbidden");
}
function validateInput(input: PrepareLearningTestReceipt) {
  exactKeys(input, [
    "ticketId",
    "expectedRevision",
    "resolutionCycle",
    "solutionMessageId",
    "clientCommandId",
    "report",
  ]);
  exactKeys(input.report, [
    "articleId",
    "ledgerEpoch",
    "reportId",
    "expectedReportGeneration",
    "reviewBindingHash",
    "receipt",
  ]);
  for (const value of [
    input.ticketId,
    input.solutionMessageId,
    input.clientCommandId,
    input.report.articleId,
    input.report.reportId,
    input.report.receipt,
  ])
    text(value);
  for (const value of [
    input.expectedRevision,
    input.resolutionCycle,
    input.report.ledgerEpoch,
    input.report.expectedReportGeneration,
  ])
    positive(value);
  if (!/^[a-f0-9]{64}$/u.test(input.report.reviewBindingHash))
    refuse("invalid");
}
function validateRow(row: BindingRow) {
  exactKeys(row, ["partition", "id", "ticketId", "references"]);
  if (
    row.id !== "bindings" ||
    !/^[a-f0-9]{64}$/u.test(row.partition) ||
    !Array.isArray(row.references) ||
    row.references.length > MAX_REFERENCES ||
    encoder.encode(JSON.stringify(row)).byteLength > MAX_ROW_BYTES
  )
    refuse("invalid");
  text(row.ticketId);
  const ids = new Set<string>();
  const commands = new Set<string>();
  for (const ref of row.references) {
    if (
      !/^[a-f0-9-]{36}$/u.test(ref.id) ||
      ids.has(ref.id) ||
      commands.has(ref.commandHash) ||
      ![
        ref.commandHash,
        ref.inputHash,
        ref.reportFingerprint,
        ref.sourceFingerprint,
      ].every((v) => /^[a-f0-9]{64}$/u.test(v))
    )
      refuse("invalid");
    ids.add(ref.id);
    commands.add(ref.commandHash);
    validateInput(ref.prepared);
    if (ref.prepared.ticketId !== row.ticketId) refuse("invalid");
    text(ref.actorId);
    for (const value of Object.values(ref.product)) text(value);
    for (const value of [ref.executionId, ref.runnerId, ref.testId])
      text(value);
    for (const value of [
      ref.resolvedAt,
      ref.reportConfirmedAt,
      ref.executedAt,
      ref.verifiedAt,
      ref.validUntil,
      ref.retainUntil,
    ])
      instant(value);
  }
  return row;
}
const bindings = defineCollection<BindingRow>({
  name: "pegma.support-learning-test-bindings.v1",
  key: (row) => ({ partition: row.partition, id: row.id }),
  codec: {
    encode(value) {
      validateRow(value);
      const stored = {
        partition: value.partition,
        id: value.id,
        payload: JSON.stringify(value),
      };
      if (encoder.encode(JSON.stringify(stored)).byteLength > MAX_ROW_BYTES)
        refuse("capacity");
      return stored;
    },
    decode(raw) {
      if (
        typeof raw.payload !== "string" ||
        encoder.encode(raw.payload).byteLength > MAX_ROW_BYTES
      )
        refuse("invalid");
      const value: BindingRow = JSON.parse(raw.payload);
      validateRow(value);
      if (raw.partition !== value.partition || raw.id !== value.id)
        refuse("invalid");
      return value;
    },
  },
});

export interface LearningTestReceiptCleanupInput {
  readonly limit: number;
  readonly cursor?: string;
}

/** Nonpaid retention work over the body-free association ledger. No current
 * Source, model, principal, configuration or application ports are needed. */
export async function cleanupSupportLearningTestReceipts(
  options: { readonly store: Store; readonly clock: Clock },
  input: LearningTestReceiptCleanupInput,
) {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 32)
    refuse("invalid");
  const records = options.store.collection(bindings);
  const now = () => instant(options.clock.now());
  const page = await records.scan(input);
  let changed = 0;
  for (const entry of page.records) {
    const row = entry.value;
    if (row.partition !== entry.key.partition || row.id !== entry.key.id)
      refuse("changed");
    const references = row.references.filter(
      (ref) => instant(ref.retainUntil) > now(),
    );
    if (references.length === row.references.length) continue;
    const committed =
      references.length === 0
        ? await records.deleteIfUnchanged(entry.key, entry.version)
        : await records.putIfUnchanged({ ...row, references }, entry.version);
    if (committed) changed += 1;
  }
  return {
    scanned: page.records.length,
    changed,
    nextCursor: page.nextCursor,
  };
}

/** One immutable association ledger over the existing Support Store. It creates
 * no route, authority, model call or background process. Separate KB/Support
 * observations are not a cross-store transaction. */
export function createSupportLearningTestReceipts(
  options: LearningTestReceiptOptions,
) {
  positive(options.retentionMilliseconds);
  const duration = options.operationMilliseconds ?? 2500;
  positive(duration);
  if (duration > 10_000) refuse("invalid");
  const records = options.store.collection(bindings);
  const now = () => instant(options.clock.now());
  let bound: BoundPorts | undefined;
  function ports(): BoundPorts {
    let current: BoundPorts;
    try {
      const support = options.support();
      const knowledge = options.knowledge();
      const reports = options.reports();
      if (
        support === undefined ||
        knowledge === undefined ||
        reports === undefined
      )
        refuse("unavailable");
      current = { support, knowledge, reports };
    } catch {
      refuse("unavailable");
    }
    if (
      bound !== undefined &&
      (bound.support !== current.support ||
        bound.knowledge !== current.knowledge ||
        bound.reports !== current.reports)
    )
      refuse("changed");
    bound ??= Object.freeze(current);
    return bound;
  }
  const receipt = (reference: Reference) => `kbtest1.${reference.id}`;

  async function operation<T>(
    parent: AbortSignal | undefined,
    work: (signal: AbortSignal, check: () => void) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    parent?.addEventListener("abort", abort, { once: true });
    if (parent?.aborted) controller.abort();
    const check = () => {
      if (controller.signal.aborted) refuse("unavailable");
    };
    let rejectTimeout: ((error: Error) => void) | undefined;
    const expired = new Promise<never>((_, reject) => {
      rejectTimeout = reject;
    });
    const timer = setTimeout(() => {
      controller.abort();
      rejectTimeout?.(new LearningTestReceiptError("unavailable"));
    }, duration);
    try {
      check();
      return await Promise.race([work(controller.signal, check), expired]);
    } finally {
      clearTimeout(timer);
      parent?.removeEventListener("abort", abort);
    }
  }

  function accessWindow(
    actorId: string,
    resolve: (signal: AbortSignal) => Promise<AccessContext | null>,
    signal: AbortSignal,
    check: () => void,
  ) {
    let original: string | undefined;
    return async () => {
      check();
      const current = await resolve(signal);
      check();
      if (current === null || current.principalId !== actorId)
        refuse("forbidden");
      actorPermissions(current);
      const snapshot = authority(current);
      if (original !== undefined && snapshot !== original) refuse("changed");
      original = snapshot;
      return Object.freeze({
        ...current,
        roles: Object.freeze([...current.roles]),
        entitlements: Object.freeze([...current.entitlements]),
        permissions: Object.freeze([...current.permissions]),
      });
    };
  }

  async function supportFacts(
    access: AccessContext,
    prepared: PrepareLearningTestReceipt,
    actorId: string,
    signal: AbortSignal,
    check: () => void,
  ) {
    const application = ports().support;
    const [ticket, source] = await Promise.all([
      application.readStaffTicket(access, prepared.ticketId),
      application.readResolutionLearningSource(access, prepared.ticketId),
    ]);
    check();
    const value = ticket.ticket;
    if (
      value.id !== prepared.ticketId ||
      value.revision !== prepared.expectedRevision ||
      source.resolutionCycle !== prepared.resolutionCycle ||
      value.resolvedAt === undefined ||
      !["resolved", "closed"].includes(value.status) ||
      source.state === "withdrawn" ||
      !ticket.messages.some(
        (message) =>
          message.id === prepared.solutionMessageId &&
          message.visibility === "customer",
      )
    )
      refuse("changed");
    const trust: ResolutionTrustContext = {
      ticketId: value.id,
      ticketRevision: value.revision,
      resolutionCycle: source.resolutionCycle,
      resolvedAt: value.resolvedAt,
      actorId,
      acceptedAt: options.clock.now(),
    };
    const product = await options.productContext.resolve(trust, signal);
    check();
    if (
      product === null ||
      instant(product.verifiedAt) > now() ||
      instant(product.validUntil) <= now()
    )
      refuse("changed");
    for (const field of Object.values(stableProduct(product))) text(field);
    return { trust, product, sourceFingerprint: await knowledgeDigest(source) };
  }

  async function qualify(
    access: AccessContext,
    prepared: PrepareLearningTestReceipt,
    product: ResolutionProductContext,
    signal: AbortSignal,
    check: () => void,
  ) {
    const key = {
      articleId: prepared.report.articleId,
      ledgerEpoch: prepared.report.ledgerEpoch,
      reportId: prepared.report.reportId,
    };
    const actual = ports();
    const observations = actual.reports.observations;
    if (
      observations !== undefined &&
      (typeof observations.observe !== "function" ||
        typeof observations.confirm !== "function")
    )
      refuse("unavailable");
    const reportObservation =
      observations === undefined
        ? undefined
        : await reportBoundary(() => observations.observe(access, key));
    const view =
      reportObservation?.view ?? (await actual.reports.read(access, key));
    if (typeof view.receipt !== "string") refuse("unavailable");
    if (
      view.status !== "confirmed" ||
      view.confirmation === null ||
      view.receipt !== prepared.report.receipt ||
      view.reportGeneration !== prepared.report.expectedReportGeneration ||
      view.reviewBindingHash !== prepared.report.reviewBindingHash
    )
      refuse("changed");
    const observed =
      reportObservation === undefined
        ? await actual.knowledge.getAuthoringContext(access, {
            articleId: key.articleId,
            includeEvidence: true,
          })
        : undefined;
    const context =
      reportObservation?.context ?? observed?.context ?? refuse("unavailable");
    const draft = context.draft.revision;
    const requirements = context.requirements;
    if (
      context.evidence === undefined ||
      (await knowledgeDigest(view.draft)) !==
        (await knowledgeDigest(context.draft)) ||
      (await knowledgeDigest(view.requirements)) !==
        (await knowledgeDigest(requirements))
    )
      refuse("changed");
    const policy = await options.readGovernance(draft.collectionId, signal);
    check();
    if (policy === null) refuse("unavailable");
    const configuration = policy.configuration;
    const submission = view.evidence;
    const confirmation = view.confirmation;
    // The paired SDK capability observes and confirms the current reviewer.
    // Legacy structural report ports retain their independent host checks.
    const reviewer =
      observations === undefined
        ? await options.resolvePrincipal(confirmation.reviewerId, signal)
        : undefined;
    if (observations === undefined) {
      if (
        reviewer === null ||
        reviewer === undefined ||
        reviewer.principalId !== confirmation.reviewerId
      )
        refuse("forbidden");
      reviewerPermissions(reviewer);
    }
    const checkRule = requirements.checks.find(
      (rule) =>
        rule.id === submission.checkId && rule.testKind === submission.testKind,
    );
    if (
      submission.result !== "passed" ||
      checkRule === undefined ||
      !configuration.trustedAttesterIds.includes(confirmation.reviewerId) ||
      submission.articleId !== draft.articleId ||
      submission.articleRevision !== draft.number ||
      submission.contentHash !== draft.contentHash ||
      (await knowledgeDigest(submission.applicability)) !==
        (await knowledgeDigest(draft.applicability)) ||
      (await knowledgeDigest(submission.validationPolicy)) !==
        (await knowledgeDigest(requirements.validationPolicy)) ||
      (await knowledgeDigest(draft.validationPolicy)) !==
        (await knowledgeDigest(requirements.validationPolicy)) ||
      (await knowledgeDigest(configuration.validationPolicy)) !==
        (await knowledgeDigest(requirements.validationPolicy)) ||
      policy.generation !== requirements.governanceGeneration ||
      configuration.expectedStagingBuildId !==
        requirements.expectedStagingBuildId ||
      submission.stagingBuildId !== requirements.expectedStagingBuildId ||
      submission.applicability.productId !== product.productId ||
      submission.applicability.productVersion !== product.version ||
      submission.stagingBuildId !== product.buildId ||
      (submission.applicability.buildId !== undefined &&
        submission.applicability.buildId !== product.buildId) ||
      instant(submission.executedAt) < instant(draft.createdAt) ||
      instant(submission.executedAt) > instant(confirmation.confirmedAt) ||
      instant(confirmation.confirmedAt) > now() ||
      now() - instant(submission.executedAt) > checkRule.maxAgeMilliseconds ||
      (await knowledgeDigest(submission)) !== view.submissionHash ||
      (await knowledgeDigest(requirements)) !== view.governanceHash
    )
      refuse("changed");
    const attestation = {
      id: view.receipt,
      verifiedBy: confirmation.reviewerId,
      verifiedAt: confirmation.confirmedAt,
    };
    for (const revoked of context.evidence.revokedEvidence) {
      if (
        revoked.id === submission.id &&
        revoked.articleRevision === submission.articleRevision &&
        revoked.hash ===
          (await evidenceDigest({
            ...submission,
            version: revoked.version,
            attestation,
          }))
      )
        refuse("changed");
    }
    const ownerVerification =
      access.principalId === view.submittedBy &&
      hasPermission(access, knowledgePermissions.evidenceSubmit)
        ? {
            access,
            article: draft,
            submission,
            receipt: view.receipt,
            configuration,
          }
        : undefined;
    if (observations !== undefined && reportObservation !== undefined) {
      const [confirmed, latestPolicy] = await Promise.all([
        reportBoundary(() =>
          observations.confirm(
            access,
            reportObservation.observation,
            ownerVerification,
          ),
        ),
        options.readGovernance(draft.collectionId, signal),
      ]);
      if (
        ports().reports.observations !== observations ||
        confirmed.receipt !== view.receipt ||
        (ownerVerification !== undefined &&
          (confirmed.attestation === null ||
            (await knowledgeDigest(confirmed.attestation)) !==
              (await knowledgeDigest(attestation)))) ||
        (await knowledgeDigest(latestPolicy)) !==
          (await knowledgeDigest(policy))
      )
        refuse("changed");
    } else {
      if (ownerVerification !== undefined) {
        const verified =
          await actual.reports.verifier.verify(ownerVerification);
        if (
          verified === null ||
          (await knowledgeDigest(verified)) !==
            (await knowledgeDigest(attestation))
        )
          refuse("changed");
      }
      // Legacy ports retain the complete public report and KB closing reads.
      if (observed === undefined) refuse("unavailable");
      await actual.knowledge.confirmAuthoringContext(
        access,
        observed.observation,
      );
      const [final, latestPolicy, latestReviewer] = await Promise.all([
        actual.reports.read(access, key),
        options.readGovernance(draft.collectionId, signal),
        options.resolvePrincipal(confirmation.reviewerId, signal),
      ]);
      if (
        latestReviewer === null ||
        reviewer === undefined ||
        reviewer === null ||
        authority(latestReviewer) !== authority(reviewer) ||
        (await knowledgeDigest(final)) !== (await knowledgeDigest(view)) ||
        (await knowledgeDigest(latestPolicy)) !==
          (await knowledgeDigest(policy))
      )
        refuse("changed");
    }
    check();
    ports();
    return {
      fingerprint: await knowledgeDigest({
        articleId: key.articleId,
        ledgerEpoch: key.ledgerEpoch,
        reportId: key.reportId,
        generation: view.reportGeneration,
        receipt: view.receipt,
        reportHash: view.reportHash,
        submissionHash: view.submissionHash,
        governanceHash: view.governanceHash,
        draft: await knowledgeDigest(context.draft),
        requirements: await knowledgeDigest(requirements),
        governance: await knowledgeDigest(policy),
        confirmation,
      }),
      executionId: `kbtest:${await knowledgeDigest({ key, receipt: view.receipt, submission: view.submissionHash })}`,
      reportSubmitterId: view.submittedBy,
      reportReviewerId: confirmation.reviewerId,
      reportConfirmedAt: confirmation.confirmedAt,
      runnerId: submission.runnerId,
      testId: submission.checkId,
      executedAt: submission.executedAt,
      expiry: Math.min(
        instant(product.validUntil),
        instant(submission.executedAt) + checkRule.maxAgeMilliseconds,
        instant(confirmation.confirmedAt) + options.retentionMilliseconds,
      ),
      retainUntil:
        instant(confirmation.confirmedAt) + options.retentionMilliseconds,
    };
  }

  async function prepare(
    original: TestReceiptStaffContext,
    input: PrepareLearningTestReceipt,
  ) {
    const prepared = structuredClone(input);
    validateInput(prepared);
    text(original.principalId);
    return operation(original.signal, async (signal, check) => {
      const current = accessWindow(
        original.principalId,
        original.current,
        signal,
        check,
      );
      const partition = await knowledgeDigest(prepared.ticketId);
      const key = { partition, id: "bindings" };
      const commandHash = await knowledgeDigest([
        original.principalId,
        prepared.clientCommandId,
      ]);
      const inputHash = await knowledgeDigest({
        actorId: original.principalId,
        prepared,
      });
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
        // Reuse this immutable admitted actor only for internal public reads.
        // Refresh the original credentials after proof awaits and after CAS.
        const access = await current();
        const saved = await records.getVersioned(key);
        if (
          saved !== null &&
          (saved.value.ticketId !== prepared.ticketId ||
            saved.value.partition !== partition)
        )
          refuse("changed");
        const previous = saved?.value.references.find(
          (ref) => ref.commandHash === commandHash,
        );
        if (previous !== undefined) {
          if (previous.inputHash !== inputHash) refuse("changed");
          await current();
          ports();
          return {
            receipt: receipt(previous),
            validUntil: previous.validUntil,
          };
        }
        const facts = await supportFacts(
          access,
          prepared,
          original.principalId,
          signal,
          check,
        );
        const qualified = await qualify(
          access,
          prepared,
          facts.product,
          signal,
          check,
        );
        const closing = await supportFacts(
          access,
          prepared,
          original.principalId,
          signal,
          check,
        );
        if (
          closing.trust.resolvedAt !== facts.trust.resolvedAt ||
          closing.sourceFingerprint !== facts.sourceFingerprint ||
          (await knowledgeDigest(stableProduct(closing.product))) !==
            (await knowledgeDigest(stableProduct(facts.product)))
        )
          refuse("changed");
        const created = now();
        const validUntil = Math.min(
          qualified.expiry,
          instant(closing.product.validUntil),
          created + options.retentionMilliseconds,
        );
        if (validUntil <= created) refuse("changed");
        const reference: Reference = {
          id: crypto.randomUUID(),
          commandHash,
          inputHash,
          actorId: original.principalId,
          prepared,
          resolvedAt: facts.trust.resolvedAt,
          sourceFingerprint: facts.sourceFingerprint,
          product: stableProduct(facts.product),
          reportFingerprint: qualified.fingerprint,
          reportSubmitterId: qualified.reportSubmitterId,
          reportReviewerId: qualified.reportReviewerId,
          reportConfirmedAt: qualified.reportConfirmedAt,
          executionId: qualified.executionId,
          runnerId: qualified.runnerId,
          testId: qualified.testId,
          executedAt: qualified.executedAt,
          verifiedAt: new Date(created).toISOString(),
          validUntil: new Date(validUntil).toISOString(),
          retainUntil: new Date(qualified.retainUntil).toISOString(),
        };
        const references = [...(saved?.value.references ?? []), reference];
        if (references.length > MAX_REFERENCES) refuse("capacity");
        const value: BindingRow = {
          partition,
          id: "bindings",
          ticketId: prepared.ticketId,
          references,
        };
        validateRow(value);
        await current();
        check();
        ports();
        const written =
          saved === null
            ? (await records.insertIfAbsent(value)).inserted
            : await records.putIfUnchanged(value, saved.version);
        await current();
        ports();
        if (written)
          return {
            receipt: receipt(reference),
            validUntil: reference.validUntil,
          };
      }
      refuse("unavailable");
    });
  }

  const verify: ResolutionTestReceiptPort["verify"] = async (
    token,
    context,
    parent,
  ) => {
    try {
      return await operation(parent, async (signal, check) => {
        if (!/^kbtest1\.[a-f0-9-]{36}$/u.test(token)) return null;
        const current = accessWindow(
          context.actorId,
          (active) => options.resolvePrincipal(context.actorId, active),
          signal,
          check,
        );
        const access = await current();
        const row = await records.get({
          partition: await knowledgeDigest(context.ticketId),
          id: "bindings",
        });
        if (row !== null && row.ticketId !== context.ticketId) return null;
        const reference = row?.references.find((ref) => receipt(ref) === token);
        if (
          reference === undefined ||
          reference.actorId !== context.actorId ||
          reference.prepared.expectedRevision !== context.ticketRevision ||
          reference.prepared.resolutionCycle !== context.resolutionCycle ||
          reference.resolvedAt !== context.resolvedAt ||
          instant(reference.validUntil) < now() ||
          (await knowledgeDigest(reference.product)) !==
            (await knowledgeDigest(stableProduct(context.product)))
        )
          return null;
        const before = await supportFacts(
          access,
          reference.prepared,
          reference.actorId,
          signal,
          check,
        );
        const qualified = await qualify(
          access,
          reference.prepared,
          context.product,
          signal,
          check,
        );
        const closing = await supportFacts(
          access,
          reference.prepared,
          reference.actorId,
          signal,
          check,
        );
        if (
          qualified.fingerprint !== reference.reportFingerprint ||
          before.sourceFingerprint !== reference.sourceFingerprint ||
          closing.sourceFingerprint !== reference.sourceFingerprint ||
          (await knowledgeDigest(stableProduct(before.product))) !==
            (await knowledgeDigest(reference.product)) ||
          (await knowledgeDigest(stableProduct(closing.product))) !==
            (await knowledgeDigest(reference.product))
        )
          return null;
        await current();
        check();
        ports();
        return {
          executionId: reference.executionId,
          runnerId: reference.runnerId,
          testId: reference.testId,
          productBinding: context.product.binding,
          executedAt: reference.executedAt,
          receiptId: token,
          verifiedAt: reference.verifiedAt,
          validUntil: new Date(
            Math.min(instant(reference.validUntil), qualified.expiry),
          ).toISOString(),
        };
      });
    } catch {
      return null;
    }
  };

  function cleanup(input: LearningTestReceiptCleanupInput) {
    return cleanupSupportLearningTestReceipts(
      { store: options.store, clock: options.clock },
      input,
    );
  }

  return Object.freeze({ prepare, verify, cleanup });
}
