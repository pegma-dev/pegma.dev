import { createAgentAccess } from "@pegma/agent-access";
import type { EvidenceSubmission } from "@pegma/knowledge-base-core";
import { knowledgePermissions } from "@pegma/knowledge-base-contracts";
import { knowledgeAgentScopes } from "@pegma/knowledge-base-mcp";
import { createKnowledgeEvidenceReports } from "@pegma/knowledge-base-application";
import { createMemoryStore } from "@pegma/storage-core";
import { createSessionStore } from "@pegma/sessions";
import {
  createSupportDeskApplication,
  type ResolutionProductContextPort,
  type ResolutionTrustContext,
} from "@pegma/support-desk-application";
import { describe, expect, it } from "vitest";
import {
  createSupportLearningFixture,
  learningTicketId,
} from "./support-learning-fixtures";
import { KNOWLEDGE_EVIDENCE_CONFIRM_PERMISSION } from "./support-access";
import {
  createSupportLearningTestReceipts,
  LearningTestReceiptError,
  type LearningTestReceiptOptions,
  type PrepareLearningTestReceipt,
} from "./support-learning-test-receipts";

const privateCanary = "FICTIONAL_REPORT_BODY_NOT_FOR_ASSOCIATION_STORAGE";

async function fixture(
  options: {
    readonly sameOwner?: boolean;
    readonly delegated?: boolean;
    readonly observations?: boolean;
    readonly articleId?: string;
    readonly result?: EvidenceSubmission["result"];
    readonly status?: "pending" | "confirmed" | "rejected";
  } = {},
) {
  const store = createMemoryStore();
  const f = await createSupportLearningFixture(store);
  const state = {
    policyHook: undefined as (() => Promise<void>) | undefined,
  };
  const sessions = createSessionStore(store, { clock: f.clock });
  const sessionIds = new Map<string, string>();
  for (const actor of [f.actors.staff, f.actors.admin]) {
    const id = crypto.randomUUID().replaceAll("-", "") + "s".repeat(11);
    await sessions.create(id, { principalId: actor.principalId, data: "{}" });
    sessionIds.set(actor.principalId, id);
  }
  const productContext: ResolutionProductContextPort = {
    async resolve(context) {
      return {
        productId: f.product.productId,
        version: f.product.productVersion,
        buildId: f.product.buildId,
        binding: "synthetic-workspace-build-1",
        contextVersion: "synthetic-product-context-v1",
        receiptId: `product-${context.ticketId}-${context.resolutionCycle}`,
        verifiedAt: context.acceptedAt,
        validUntil: new Date(
          Date.parse(context.acceptedAt) + 60_000,
        ).toISOString(),
      };
    },
  };
  let application = f.application;
  const reports = options.observations
    ? createKnowledgeEvidenceReports({
        store,
        clock: f.clock,
        collectionName: "synthetic-support-learning-reports.v1",
        confirmationPermission: KNOWLEDGE_EVIDENCE_CONFIRM_PERMISSION,
        resolvePrincipal: f.resolve,
        authoringContext: f.knowledge,
        async readContext(access, articleId) {
          return (
            await f.knowledge.getAuthoringContext(access, {
              articleId,
              includeEvidence: true,
            })
          ).context;
        },
      })
    : f.reports;
  const configuration: LearningTestReceiptOptions = {
    store,
    clock: f.clock,
    support: () => application,
    knowledge: () => f.knowledge,
    reports: () => reports,
    productContext,
    resolvePrincipal: (id) => f.resolve(id),
    retentionMilliseconds: 120_000,
    async readGovernance(collectionId) {
      await state.policyHook?.();
      const access = await f.resolve(f.actors.admin.principalId);
      const governance = await f.knowledge.getGovernanceConfiguration(access, {
        collectionId,
      });
      return governance;
    },
  };
  const bridge = createSupportLearningTestReceipts(configuration);
  application = createSupportDeskApplication({
    store,
    clock: f.clock,
    resolutionLearning: { enabled: true, productContext, testReceipts: bridge },
  });
  const terminal = await f.terminal();
  await application.enrollResolutionLearning(f.actors.staff, {
    ticketId: learningTicketId,
    commandId: "enroll-for-test-binding",
    correlationId: "binding",
    expectedRevision: terminal.revision,
  });
  const articleId = options.articleId ?? "test-guide";
  const collectionId = "learning-guides";
  await f.knowledge.createDraft(f.actors.admin, {
    ...f.command("binding-draft"),
    articleId,
    collectionId,
    draft: {
      kind: "explanation",
      title: "Verify an export",
      summary: "Fictional controlled test.",
      content: {
        format: "plain_text",
        text: "Export the fictional workspace.",
      },
      tags: ["synthetic"],
      applicability: f.product,
    },
  });
  let grant:
    { revoke(): Promise<void>; refused(): Promise<unknown> } | undefined;
  let reporter = options.sameOwner ? f.actors.staff : f.actors.runner;
  if (options.delegated) {
    const issuer = "https://binding-agent.example.test";
    const resource = `${issuer}/mcp`;
    const clientId = "fictional-binding-client";
    const reportScope = knowledgeAgentScopes.evidenceSubmit;
    const service = createAgentAccess({
      store,
      clock: f.clock,
      resolvePrincipal: f.resolve,
      configuration: {
        issuer,
        resource,
        approvalPermission: KNOWLEDGE_EVIDENCE_CONFIRM_PERMISSION,
        endpoints: {
          authorize: `${issuer}/authorize`,
          deviceAuthorization: `${issuer}/device`,
          token: `${issuer}/token`,
          revocation: `${issuer}/revoke`,
          verification: `${issuer}/verify`,
          approval: `${issuer}/approval`,
          resourceMetadata: `${issuer}/.well-known/oauth-protected-resource/mcp`,
        },
        clients: [
          {
            clientId,
            name: "Fictional binding test",
            redirectUris: ["https://client.example.test/callback"],
            allowedScopes: [reportScope],
            grantTypes: ["device_code"],
          },
        ],
        scopes: [
          {
            name: reportScope,
            description: "Fictional report submission",
            version: "1",
            permissions: [
              knowledgePermissions.draftRead,
              knowledgePermissions.evidenceSubmit,
            ],
          },
        ],
      },
    });
    const browser = {
      authentication: "browser-session" as const,
      access: f.actors.staff,
    };
    const device = await service.beginDeviceAuthorization({
      clientId,
      resource,
      scopes: [reportScope],
    });
    const approval = await service.getDeviceApproval(browser, device.user_code);
    await service.approve(browser, {
      requestId: approval.requestId,
      userCode: device.user_code,
      decision: "approve",
      approvedScopes: [reportScope],
    });
    f.advance(device.interval * 1000);
    const token = await service.pollDeviceToken({
      clientId,
      resource,
      deviceCode: device.device_code,
    });
    const delegated = await service.authenticate({
      token: token.access_token,
      resource,
    });
    expect(delegated.access.principalId).toBe(f.actors.staff.principalId);
    expect(delegated.access.roles).toEqual([]);
    reporter = delegated.access;
    grant = {
      revoke: () => service.revokeGrant(browser, delegated.grantId),
      refused: () =>
        service.authenticate({ token: token.access_token, resource }),
    };
  }
  const currentDraft = await f.knowledge.getDraft(f.actors.staff, {
    articleId,
  });
  const requirements = await f.knowledge.getValidationRequirements(
    f.actors.staff,
    { collectionId, kind: "explanation" },
  );
  const check = requirements.checks[0];
  if (check === undefined) throw new Error("Actual KB requirement missing");
  const evidence: EvidenceSubmission = {
    id: "binding-evidence",
    articleId,
    articleRevision: currentDraft.revision.number,
    contentHash: currentDraft.revision.contentHash,
    validationPolicy: currentDraft.revision.validationPolicy,
    checkId: check.id,
    testKind: check.testKind,
    applicability: currentDraft.revision.applicability,
    stagingBuildId: requirements.expectedStagingBuildId,
    steps: ["Export a fictional workspace."],
    result: options.result ?? "passed",
    executedAt: f.clock.now(),
    runnerId: f.actors.runner.principalId,
    artifacts: [{ id: "fictional-output", hash: "a".repeat(64) }],
  };
  const ledger = await f.reports.ledger(reporter, { articleId });
  const acknowledgement = await f.reports.report(reporter, {
    commandId: "binding-report",
    articleId,
    ledgerEpoch: ledger.ledgerEpoch,
    evidence,
    report: { summary: "Fictional export test", details: privateCanary },
  });
  const reportKey = {
    articleId,
    ledgerEpoch: acknowledgement.ledgerEpoch,
    reportId: acknowledgement.reportId,
  };
  const before = await f.reports.read(f.actors.staff, reportKey);
  if ((options.status ?? "confirmed") !== "pending") {
    await f.reports.decide(
      f.actors.staff,
      {
        ...reportKey,
        commandId: "binding-confirm",
        expectedReportGeneration: before.expectedReportGeneration,
        reviewBindingHash: before.reviewBindingHash,
      },
      options.status ?? "confirmed",
    );
  }
  const input = async (
    actor = f.actors.staff,
    commandId = "prepare-test-1",
  ): Promise<PrepareLearningTestReceipt> => {
    const report = await f.reports.read(
      await f.resolve(actor.principalId),
      reportKey,
    );
    const source = await application.readResolutionLearningSource(
      await f.resolve(actor.principalId),
      learningTicketId,
    );
    return {
      ticketId: learningTicketId,
      expectedRevision: terminal.revision,
      resolutionCycle: source.resolutionCycle,
      solutionMessageId: "learning-solution",
      clientCommandId: commandId,
      report: {
        ...reportKey,
        expectedReportGeneration: report.reportGeneration,
        reviewBindingHash: report.reviewBindingHash,
        receipt: report.receipt,
      },
    };
  };
  const staff = (actor = f.actors.staff) => ({
    principalId: actor.principalId,
    async current() {
      const id = sessionIds.get(actor.principalId);
      const session = id === undefined ? null : await sessions.get(id);
      if (session === null || session.principalId !== actor.principalId) {
        throw new Error("Fictional original browser session is unavailable");
      }
      return f.resolve(session.principalId);
    },
  });
  const trust = async (
    prepared: PrepareLearningTestReceipt,
    actor = f.actors.staff,
  ) => {
    const value: ResolutionTrustContext = {
      ticketId: prepared.ticketId,
      ticketRevision: prepared.expectedRevision,
      resolutionCycle: prepared.resolutionCycle,
      actorId: actor.principalId,
      resolvedAt: terminal.resolvedAt!,
      acceptedAt: f.clock.now(),
    };
    const product = await productContext.resolve(
      value,
      new AbortController().signal,
    );
    if (product === null) throw new Error("Actual product unavailable");
    return { ...value, product };
  };
  const verify = async (
    receipt: string,
    prepared: PrepareLearningTestReceipt,
    actor = f.actors.staff,
  ) =>
    bridge.verify(
      receipt,
      await trust(prepared, actor),
      new AbortController().signal,
    );
  const acceptKB = async () => {
    const draft = await f.knowledge.getDraft(f.actors.staff, { articleId });
    const report = await f.reports.read(f.actors.staff, reportKey);
    return f.knowledge.submitEvidence(await f.resolve(reporter.principalId), {
      ...f.command("binding-kb-evidence", draft.generation),
      articleId,
      evidence,
      receipt: report.receipt,
    });
  };
  return {
    f,
    store,
    bridge,
    application,
    productContext,
    configuration,
    reports,
    state,
    grant,
    reporter,
    articleId,
    collectionId,
    evidence,
    reportKey,
    input,
    staff,
    trust,
    verify,
    acceptKB,
    async revokeBrowser() {
      const id = sessionIds.get(f.actors.staff.principalId);
      if (id === undefined) throw new Error("Original session missing");
      await sessions.destroy(id);
    },
  };
}

describe("staff-approved KB report associations", () => {
  it.each([false, true])(
    "uses actual paired report observations for original owner=%s without legacy hydration",
    async (sameOwner) => {
      const f = await fixture({
        observations: true,
        sameOwner,
        delegated: sameOwner,
      });
      if (f.grant !== undefined) {
        await f.grant.revoke();
        await expect(f.grant.refused()).rejects.toMatchObject({
          code: "invalid_token",
        });
      }
      const input = await f.input();
      const reports = {
        ...f.reports,
        async read(): Promise<never> {
          throw new Error("Legacy hydration must remain unused");
        },
        verifier: {
          async verify(): Promise<never> {
            throw new Error("Legacy owner verification must remain unused");
          },
        },
      };
      const knowledge = {
        ...f.f.knowledge,
        async getAuthoringContext(): Promise<never> {
          throw new Error(
            "The actual report capability owns context observation",
          );
        },
        async confirmAuthoringContext(): Promise<never> {
          throw new Error(
            "The actual report capability owns context confirmation",
          );
        },
      };
      const bridge = createSupportLearningTestReceipts({
        ...f.configuration,
        reports: () => reports,
        knowledge: () => knowledge,
      });
      const prepared = await bridge.prepare(f.staff(), input);
      expect(
        await bridge.verify(
          prepared.receipt,
          await f.trust(input),
          new AbortController().signal,
        ),
      ).toMatchObject({
        receiptId: prepared.receipt,
        runnerId: f.evidence.runnerId,
      });
      expect(await bridge.prepare(f.staff(), input)).toEqual(prepared);
    },
  );

  it.each(["report", "reviewer", "governance"] as const)(
    "closes %s changes with the actual report observation",
    async (change) => {
      const f = await fixture({ observations: true });
      const input = await f.input(f.f.actors.admin);
      f.state.policyHook = async () => {
        f.state.policyHook = undefined;
        if (change === "report") {
          const current = await f.f.reports.read(f.f.actors.staff, f.reportKey);
          await f.f.reports.decide(
            f.f.actors.staff,
            {
              ...f.reportKey,
              commandId: "paired-report-changed",
              expectedReportGeneration: current.reportGeneration,
              reviewBindingHash: current.reviewBindingHash,
            },
            "pending",
          );
        } else if (change === "reviewer") await f.f.revokeStaff();
        else {
          const current = await f.f.knowledge.getGovernanceConfiguration(
            f.f.actors.admin,
            { collectionId: f.collectionId },
          );
          await f.f.knowledge.putGovernanceConfiguration(f.f.actors.admin, {
            ...f.f.command("paired-governance-changed", current.generation),
            collectionId: f.collectionId,
            configuration: {
              ...current.configuration,
              expectedStagingBuildId: "another-current-build",
            },
          });
        }
      };
      await expect(
        f.bridge.prepare(f.staff(f.f.actors.admin), input),
      ).rejects.toBeInstanceOf(LearningTestReceiptError);
      expect(await f.bridge.cleanup({ limit: 32 })).toMatchObject({
        scanned: 0,
      });
    },
  );

  it("resolves original browser authority at admission, before commit and after commit", async () => {
    const f = await fixture();
    const input = await f.input();
    const browser = f.staff();
    let reads = 0;
    const prepared = await f.bridge.prepare(
      {
        ...browser,
        async current() {
          reads += 1;
          return browser.current();
        },
      },
      input,
    );
    expect(prepared.receipt).toMatch(/^kbtest1\./u);
    expect(reads).toBe(3);
  });

  it.each(["browser", "role", "configuration", "cancel"] as const)(
    "refuses %s loss during the closing product await without storing a binding",
    async (change) => {
      const f = await fixture();
      const input = await f.input();
      let available = true;
      let products = 0;
      const controller = new AbortController();
      const bridge = createSupportLearningTestReceipts({
        ...f.configuration,
        knowledge: () => (available ? f.f.knowledge : undefined),
        productContext: {
          async resolve(context, signal) {
            const product = await f.productContext.resolve(context, signal);
            products += 1;
            if (products === 2) {
              if (change === "browser") await f.revokeBrowser();
              if (change === "role") await f.f.revokeStaff();
              if (change === "configuration") available = false;
              if (change === "cancel") controller.abort();
            }
            return product;
          },
        },
      });
      await expect(
        bridge.prepare({ ...f.staff(), signal: controller.signal }, input),
      ).rejects.toThrow();
      expect(await bridge.cleanup({ limit: 32 })).toMatchObject({ scanned: 0 });
    },
  );

  it("finishes opaque authoring confirmation before the closing report read", async () => {
    const f = await fixture();
    const input = await f.input();
    let reads = 0;
    const knowledge = {
      ...f.f.knowledge,
      async confirmAuthoringContext(
        ...args: Parameters<typeof f.f.knowledge.confirmAuthoringContext>
      ) {
        await f.f.knowledge.confirmAuthoringContext(...args);
        const current = await f.f.reports.read(f.f.actors.staff, f.reportKey);
        await f.f.reports.decide(
          f.f.actors.staff,
          {
            ...f.reportKey,
            commandId: "change-after-opaque-confirmation",
            expectedReportGeneration: current.reportGeneration,
            reviewBindingHash: current.reviewBindingHash,
          },
          "pending",
        );
      },
    };
    const reports = {
      ...f.f.reports,
      async read(...args: Parameters<typeof f.f.reports.read>) {
        reads += 1;
        return f.f.reports.read(...args);
      },
    };
    const bridge = createSupportLearningTestReceipts({
      ...f.configuration,
      knowledge: () => knowledge,
      reports: () => reports,
    });
    await expect(bridge.prepare(f.staff(), input)).rejects.toMatchObject({
      code: "changed",
    });
    expect(reads).toBe(2);
    expect(await bridge.cleanup({ limit: 32 })).toMatchObject({ scanned: 0 });
  });

  it("refuses changed governance during closing public proof reads", async () => {
    const f = await fixture();
    const input = await f.input();
    let reads = 0;
    const bridge = createSupportLearningTestReceipts({
      ...f.configuration,
      async readGovernance(collectionId, signal) {
        reads += 1;
        if (reads === 2) {
          const current = await f.configuration.readGovernance(
            collectionId,
            signal,
          );
          if (current === null) throw new Error("Actual governance missing");
          await f.f.knowledge.putGovernanceConfiguration(f.f.actors.admin, {
            ...f.f.command("closing-governance-change", current.generation),
            collectionId,
            configuration: {
              ...current.configuration,
              expectedStagingBuildId: "changed-during-closing-proof",
            },
          });
        }
        return f.configuration.readGovernance(collectionId, signal);
      },
    });
    await expect(bridge.prepare(f.staff(), input)).rejects.toMatchObject({
      code: "changed",
    });
    expect(await bridge.cleanup({ limit: 32 })).toMatchObject({ scanned: 0 });
  });

  it("refuses Source withdrawal during closing Support reads", async () => {
    const f = await fixture();
    const input = await f.input();
    let reads = 0;
    const support = {
      ...f.application,
      async readResolutionLearningSource(
        ...args: Parameters<typeof f.application.readResolutionLearningSource>
      ) {
        reads += 1;
        if (reads === 2) {
          await f.application.withdrawResolutionLearningSource(
            f.f.actors.staff,
            {
              ticketId: input.ticketId,
              commandId: "withdraw-during-closing-source",
              correlationId: "binding",
              reason: "privacy_withdrawal",
            },
          );
        }
        return f.application.readResolutionLearningSource(...args);
      },
    };
    const bridge = createSupportLearningTestReceipts({
      ...f.configuration,
      support: () => support,
    });
    await expect(bridge.prepare(f.staff(), input)).rejects.toMatchObject({
      code: "changed",
    });
    expect(await bridge.cleanup({ limit: 32 })).toMatchObject({ scanned: 0 });
  });

  it("recovers the immutable accepted receipt after a closing authority read loses its ACK", async () => {
    const f = await fixture();
    const input = await f.input();
    const browser = f.staff();
    let reads = 0;
    await expect(
      f.bridge.prepare(
        {
          ...browser,
          async current() {
            reads += 1;
            if (reads === 3) throw new Error("Fictional closing read ACK lost");
            return browser.current();
          },
        },
        input,
      ),
    ).rejects.toThrow("Fictional closing read ACK lost");
    expect(await f.bridge.cleanup({ limit: 32 })).toMatchObject({ scanned: 1 });
    const accepted = await f.bridge.prepare(browser, input);
    expect(await f.bridge.prepare(browser, input)).toEqual(accepted);
    expect(await f.bridge.cleanup({ limit: 32 })).toMatchObject({ scanned: 1 });
  });

  it("constructs before the real Knowledge/report root and binds only its actual lazy instances", async () => {
    const f = await fixture();
    let knowledge: ReturnType<LearningTestReceiptOptions["knowledge"]>;
    let reports: ReturnType<LearningTestReceiptOptions["reports"]>;
    let getterReads = 0;
    const bridge = createSupportLearningTestReceipts({
      ...f.configuration,
      knowledge: () => {
        getterReads += 1;
        return knowledge;
      },
      reports: () => {
        getterReads += 1;
        return reports;
      },
    });
    expect(getterReads).toBe(0);
    const input = await f.input();
    await expect(bridge.prepare(f.staff(), input)).rejects.toMatchObject({
      code: "unavailable",
    });
    knowledge = f.f.knowledge;
    reports = f.f.reports;
    const prepared = await bridge.prepare(f.staff(), input);
    expect(
      await bridge.verify(
        prepared.receipt,
        await f.trust(input),
        new AbortController().signal,
      ),
    ).not.toBeNull();
    knowledge = undefined;
    expect(
      await bridge.verify(
        prepared.receipt,
        await f.trust(input),
        new AbortController().signal,
      ),
    ).toBeNull();
  });

  it("uses a confirmed passed report before separate KB evidence acceptance for different staff", async () => {
    const f = await fixture({ articleId: "x".repeat(200) });
    expect(
      (
        await f.f.knowledge.getEvidence(f.f.actors.staff, {
          articleId: f.articleId,
        })
      ).evidence,
    ).toEqual([]);
    const input = await f.input();
    const prepared = await f.bridge.prepare(f.staff(), input);
    expect(prepared.receipt.length).toBeLessThanOrEqual(200);
    const verified = await f.verify(prepared.receipt, input);
    expect(verified).toMatchObject({
      runnerId: f.evidence.runnerId,
      testId: f.evidence.checkId,
      productBinding: "synthetic-workspace-build-1",
      receiptId: prepared.receipt,
    });
    expect(f.reporter.principalId).not.toBe(f.f.actors.staff.principalId);
  });

  it("uses the same real owner browser after an actual delegated grant is revoked", async () => {
    const f = await fixture({ sameOwner: true, delegated: true });
    if (f.grant === undefined)
      throw new Error("Actual delegated grant missing");
    await f.grant.revoke();
    await expect(f.grant.refused()).rejects.toMatchObject({
      code: "invalid_token",
    });
    const input = await f.input();
    const prepared = await f.bridge.prepare(f.staff(), input);
    expect(await f.verify(prepared.receipt, input)).not.toBeNull();
  });

  for (const result of ["failed", "inconclusive"] as const) {
    it(`refuses a confirmed ${result} report`, async () => {
      const f = await fixture({ result });
      await expect(
        f.bridge.prepare(f.staff(), await f.input()),
      ).rejects.toBeInstanceOf(LearningTestReceiptError);
    });
  }
  for (const status of ["pending", "rejected"] as const) {
    it(`refuses a ${status} report`, async () => {
      const f = await fixture({ status });
      await expect(
        f.bridge.prepare(f.staff(), await f.input()),
      ).rejects.toBeInstanceOf(LearningTestReceiptError);
    });
  }

  it("prepares idempotently, preserves the historical receipt after proof changes, and refuses changed intent", async () => {
    const f = await fixture();
    const input = await f.input();
    const prepared = await f.bridge.prepare(f.staff(), input);
    expect(await f.bridge.prepare(f.staff(), input)).toEqual(prepared);
    const draft = await f.f.knowledge.getDraft(f.f.actors.staff, {
      articleId: f.articleId,
    });
    await f.f.knowledge.updateDraft(f.f.actors.staff, {
      ...f.f.command("edit-after-association", draft.generation),
      articleId: f.articleId,
      collectionId: f.collectionId,
      draft: {
        kind: draft.revision.kind,
        title: draft.revision.title,
        summary: draft.revision.summary,
        tags: draft.revision.tags,
        applicability: draft.revision.applicability,
        content: {
          format: "plain_text",
          text: "A genuine second content revision.",
        },
      },
    });
    expect(await f.bridge.prepare(f.staff(), input)).toEqual(prepared);
    expect(await f.verify(prepared.receipt, input)).toBeNull();
    await expect(
      f.bridge.prepare(f.staff(), { ...input, solutionMessageId: "changed" }),
    ).rejects.toMatchObject({ code: "changed" });
  });

  it("retains actual accepted Support replay after proof changes while a new command cannot qualify", async () => {
    const f = await fixture();
    const input = await f.input();
    const prepared = await f.bridge.prepare(f.staff(), input);
    const command = {
      ticketId: input.ticketId,
      commandId: "actual-successful-evidence",
      correlationId: "binding",
      expectedRevision: input.expectedRevision,
      resolutionCycle: input.resolutionCycle,
      evidence: {
        kind: "successful_test" as const,
        solutionMessageId: input.solutionMessageId,
        receipt: prepared.receipt,
      },
    };
    const accepted = await f.application.submitResolutionEvidence(
      f.f.actors.staff,
      command,
    );
    expect(accepted.state).toBe("eligible");
    const originalSource = await f.application.readResolutionLearningSource(
      f.f.actors.staff,
      input.ticketId,
    );
    await f.f.reports.decide(
      f.f.actors.staff,
      {
        ...f.reportKey,
        commandId: "reassess-after-support-ack",
        expectedReportGeneration: (
          await f.f.reports.read(f.f.actors.staff, f.reportKey)
        ).reportGeneration,
        reviewBindingHash: (
          await f.f.reports.read(f.f.actors.staff, f.reportKey)
        ).reviewBindingHash,
      },
      "pending",
    );
    expect(
      await f.application.submitResolutionEvidence(f.f.actors.staff, command),
    ).toEqual(accepted);
    const refused = await f.application.submitResolutionEvidence(
      f.f.actors.staff,
      { ...command, commandId: "new-after-proof-change" },
    );
    expect(refused).toMatchObject({
      state: "eligible",
      sourceGeneration: accepted.sourceGeneration,
      heldReason: "test_receipt_unverified",
    });
    const after = await f.application.readResolutionLearningSource(
      f.f.actors.staff,
      input.ticketId,
    );
    expect(after.evidence).toEqual(originalSource.evidence);
    expect(after.product).toEqual(originalSource.product);
    expect(after.pendingProofReference).toBe("new-after-proof-change");
  });

  it.each(["ticketRevision", "resolutionCycle", "actorId", "product"] as const)(
    "refuses a mismatched SDK %s binding",
    async (field) => {
      const f = await fixture();
      const input = await f.input();
      const prepared = await f.bridge.prepare(f.staff(), input);
      const context = await f.trust(input);
      const changed =
        field === "ticketRevision"
          ? { ...context, ticketRevision: context.ticketRevision + 1 }
          : field === "resolutionCycle"
            ? { ...context, resolutionCycle: context.resolutionCycle + 1 }
            : field === "actorId"
              ? { ...context, actorId: f.f.actors.admin.principalId }
              : {
                  ...context,
                  product: { ...context.product, buildId: "another-build" },
                };
      expect(
        await f.bridge.verify(
          prepared.receipt,
          changed,
          new AbortController().signal,
        ),
      ).toBeNull();
    },
  );

  it("refuses a fabricated confirmation ACK even though the report is confirmed", async () => {
    const f = await fixture();
    const input = await f.input();
    await expect(
      f.bridge.prepare(f.staff(), {
        ...input,
        report: { ...input.report, receipt: "forged-receipt" },
      }),
    ).rejects.toMatchObject({ code: "changed" });
  });

  it("refuses current reviewer role loss without adding a confirmation decision", async () => {
    const f = await fixture();
    const input = await f.input(f.f.actors.admin);
    await f.f.revokeStaff();
    await expect(
      f.bridge.prepare(f.staff(f.f.actors.admin), input),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("fences original browser and current role loss during the last qualification callback", async () => {
    for (const change of ["browser", "role"] as const) {
      const f = await fixture();
      const input = await f.input();
      f.state.policyHook = async () => {
        f.state.policyHook = undefined;
        if (change === "browser") await f.revokeBrowser();
        else await f.f.revokeStaff();
      };
      await expect(f.bridge.prepare(f.staff(), input)).rejects.toThrow();
      expect(
        (
          await f.store
            .collection({
              name: "pegma.support-learning-test-bindings.v1",
              key: (row: { partition: string; id: string }) => row,
              codec: {
                encode: (row) => row,
                decode: (row) => ({
                  partition: String(row.partition),
                  id: String(row.id),
                }),
              },
            })
            .scan({ limit: 32 })
        ).records,
      ).toEqual([]);
    }
  });

  it("rejects an exact revoked KB fact before creating a new association", async () => {
    const f = await fixture();
    await f.acceptKB();
    const evidence = await f.f.knowledge.getEvidence(f.f.actors.staff, {
      articleId: f.articleId,
    });
    const accepted = evidence.evidence[0];
    if (accepted === undefined)
      throw new Error("Actual accepted KB evidence missing");
    await f.f.knowledge.revokeEvidence(f.f.actors.admin, {
      ...f.f.command("revoke-accepted-report", evidence.generation),
      articleId: f.articleId,
      articleRevision: accepted.articleRevision,
      evidenceId: accepted.id,
      evidenceVersion: accepted.version,
      evidenceHash: accepted.hash,
      reason: "Fictional controlled revocation",
    });
    await expect(
      f.bridge.prepare(f.staff(), await f.input()),
    ).rejects.toMatchObject({ code: "changed" });
  });

  it("keeps bodies out of bounded link rows and conditionally cleans expired references", async () => {
    const f = await fixture();
    const prepared = await f.bridge.prepare(f.staff(), await f.input());
    expect(prepared).not.toHaveProperty("report");
    const rows = await f.store
      .collection({
        name: "pegma.support-learning-test-bindings.v1",
        key: (row: { partition: string; id: string }) => row,
        codec: {
          encode: (row) => row,
          decode: (row) => ({
            partition: String(row.partition),
            id: String(row.id),
            payload: String(row.payload),
          }),
        },
      })
      .scan({ limit: 32 });
    expect(JSON.stringify(rows)).not.toContain(privateCanary);
    f.f.advance(60_001);
    expect(await f.verify(prepared.receipt, await f.input())).toBeNull();
    f.f.advance(60_000);
    expect(await f.bridge.cleanup({ limit: 1 })).toMatchObject({
      scanned: 1,
      changed: 1,
      nextCursor: null,
    });
  });
  it("distinguishes a revoked old fact from a separately confirmed replacement with the same evidence ID", async () => {
    const f = await fixture();
    await f.acceptKB();
    const prior = await f.f.knowledge.getEvidence(f.f.actors.staff, {
      articleId: f.articleId,
    });
    const old = prior.evidence[0];
    if (old === undefined) throw new Error("Actual prior evidence missing");
    await f.f.knowledge.revokeEvidence(f.f.actors.admin, {
      ...f.f.command("revoke-prior-version", prior.generation),
      articleId: f.articleId,
      articleRevision: old.articleRevision,
      evidenceId: old.id,
      evidenceVersion: old.version,
      evidenceHash: old.hash,
      reason: "Fictional immutable prior-fact revocation",
    });
    const acknowledgement = await f.f.reports.report(f.reporter, {
      commandId: "separate-replacement-report",
      articleId: f.articleId,
      ledgerEpoch: f.reportKey.ledgerEpoch,
      evidence: f.evidence,
      report: {
        summary: "Separate fictional replacement test",
        details: "Checked again.",
      },
    });
    const key = {
      articleId: f.articleId,
      ledgerEpoch: acknowledgement.ledgerEpoch,
      reportId: acknowledgement.reportId,
    };
    const pending = await f.f.reports.read(f.f.actors.staff, key);
    const confirmed = await f.f.reports.decide(
      f.f.actors.staff,
      {
        ...key,
        commandId: "confirm-separate-replacement",
        expectedReportGeneration: pending.reportGeneration,
        reviewBindingHash: pending.reviewBindingHash,
      },
      "confirmed",
    );
    const draft = await f.f.knowledge.getDraft(f.f.actors.staff, {
      articleId: f.articleId,
    });
    await f.f.knowledge.submitEvidence(f.reporter, {
      ...f.f.command("accept-separate-replacement", draft.generation),
      articleId: f.articleId,
      evidence: f.evidence,
      receipt: confirmed.receipt,
    });
    const current = await f.f.knowledge.getEvidence(f.f.actors.staff, {
      articleId: f.articleId,
    });
    expect(current.evidence[0]?.id).toBe(old.id);
    expect(current.evidence[0]?.version).toBe(old.version + 1);
    await expect(
      f.bridge.prepare(f.staff(), await f.input()),
    ).rejects.toMatchObject({ code: "changed" });
    const view = await f.f.reports.read(f.f.actors.staff, key);
    const input = await f.input(f.f.actors.staff, "use-separate-replacement");
    const selected = {
      ...input,
      report: {
        ...key,
        expectedReportGeneration: view.reportGeneration,
        reviewBindingHash: view.reviewBindingHash,
        receipt: view.receipt,
      },
    };
    expect(await f.bridge.prepare(f.staff(), selected)).toHaveProperty(
      "receipt",
    );
  });

  it("requires current exact build/governance instead of trusting the historical confirmation ACK", async () => {
    const f = await fixture();
    const governance = await f.f.knowledge.getGovernanceConfiguration(
      f.f.actors.admin,
      { collectionId: f.collectionId },
    );
    await f.f.knowledge.putGovernanceConfiguration(f.f.actors.admin, {
      ...f.f.command("change-real-build", governance.generation),
      collectionId: f.collectionId,
      configuration: {
        ...governance.configuration,
        expectedStagingBuildId: "a-new-build",
      },
    });
    await expect(
      f.bridge.prepare(f.staff(), await f.input()),
    ).rejects.toMatchObject({ code: "changed" });
  });

  it("requires the originally observed Source facts even when ticket revision and cycle are unchanged", async () => {
    const f = await fixture();
    const input = await f.input();
    const prepared = await f.bridge.prepare(f.staff(), input);
    await f.application.invalidateResolutionEvidence(f.f.actors.staff, {
      ticketId: input.ticketId,
      commandId: "actual-source-invalidation",
      correlationId: "binding",
      reason: "product_binding_revoked",
    });
    expect(await f.verify(prepared.receipt, input)).toBeNull();
  });

  it("bounds a ticket to sixteen immutable preparations and retains every original ACK", async () => {
    const f = await fixture();
    const original = await f.input();
    const acknowledgements = [];
    for (let i = 0; i < 16; i += 1) {
      acknowledgements.push(
        await f.bridge.prepare(f.staff(), {
          ...original,
          clientCommandId: `bounded-command-${i}`,
        }),
      );
    }
    await expect(
      f.bridge.prepare(f.staff(), {
        ...original,
        clientCommandId: "one-too-many",
      }),
    ).rejects.toMatchObject({ code: "capacity" });
    expect(
      await f.bridge.prepare(f.staff(), {
        ...original,
        clientCommandId: "bounded-command-0",
      }),
    ).toEqual(acknowledgements[0]);
  });

  it("does not renew an old association after its fixed confirmation retention and cleanup", async () => {
    const f = await fixture();
    const input = await f.input();
    await f.bridge.prepare(f.staff(), input);
    f.f.advance(120_001);
    expect(await f.bridge.cleanup({ limit: 1 })).toMatchObject({ changed: 1 });
    await expect(f.bridge.prepare(f.staff(), input)).rejects.toMatchObject({
      code: "changed",
    });
  });
});
