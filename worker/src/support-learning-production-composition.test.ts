import { createMemoryStore } from "@pegma/storage-core";
import {
  SupportDeskNotFoundError,
  type ResolutionLearningOptions,
} from "@pegma/support-desk-application";
import { createSupportLearningRuntime } from "./support-learning";
import { customerAccessContext } from "./support-access";
import { identityLinkKeyFromVerifiedIdentityClaims } from "@pegma/authorization-identity";
import { KnowledgeBaseNotFoundError } from "@pegma/knowledge-base-application";
import type { PrivateSourcesVerifier } from "@pegma/knowledge-base-application";
import type { LearningCheckPolicyPort } from "@pegma/support-desk-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createIdentityRuntime } from "./identity-runtime";
import { createSupportRuntime } from "./support-desk";
import {
  createSupportIndependentChecks,
  type SupportIndependentChecksOptions,
} from "./support-independent-checks";
import {
  createSupportLearningComposition,
  type SupportLearningCompositionOptions,
} from "./support-learning-composition";
import {
  createSupportLearningFixture,
  learningTicketId,
} from "./support-learning-fixtures";
import { SUPPORT_LEARNING_WIRE_VERSION } from "./support-learning-model";

// Independent model qualification is covered by its real adapter tests. Only
// its current check policy is substituted here; source state and all Support,
// KB, evidence, publication and source-verifier operations use the actual SDK.
vi.mock("./support-independent-checks", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./support-independent-checks")>();
  return {
    ...actual,
    createSupportIndependentChecks: vi.fn(
      actual.createSupportIndependentChecks,
    ),
  };
});

const checkerFactory = vi.mocked(createSupportIndependentChecks);
beforeEach(() => {
  checkerFactory.mockClear();
});

async function fixture(sourceOnly = false, intake?: boolean) {
  const f = await createSupportLearningFixture(createMemoryStore());
  await f.enrollAndVerify();
  const delivered = await f.delivered();
  await f.review(delivered.articleId);
  await f.evidenceAndPublish(delivered.articleId);
  const source = await f.application.readResolutionLearningSource(
    f.actors.staff,
    learningTicketId,
  );
  if (source.product === undefined)
    throw new Error("Actual accepted product required");
  const observed = await f.ports.configuration.resolve(
    undefined,
    new AbortController().signal,
  );
  if (observed.outcome !== "ready")
    throw new Error("Actual fixture configuration required");
  const config = observed.configuration;
  const until = config.dataControls.validUntil;
  const modelCalls = vi.fn(async () => {
    throw new Error("Generation must stay OFF");
  });
  const keyReads = vi.fn(() => undefined);
  let generationEnabled = false;
  let currentPolicy = await f.ports.checks.resolvePolicy(
    undefined,
    new AbortController().signal,
  );
  if (currentPolicy.outcome !== "ready")
    throw new Error("Actual approved fixture policy required");
  const approvedPolicy = structuredClone(currentPolicy.policy);
  const reviewPolicy: LearningCheckPolicyPort = {
    resolvePolicy: vi.fn(async (expected, signal) => {
      if (
        signal.aborted ||
        (currentPolicy.outcome === "ready" &&
          expected !== undefined &&
          expected !== currentPolicy.policy.version)
      )
        return { outcome: "unavailable" as const };
      return structuredClone(currentPolicy);
    }),
  };
  const original = await vi.importActual<
    typeof import("./support-independent-checks")
  >("./support-independent-checks");
  checkerFactory.mockImplementation((options) => {
    const controller = original.createSupportIndependentChecks(options);
    return {
      ...controller,
      resolvePolicy: f.ports.checks.resolvePolicy,
      learningSdkVerifier: f.ports.checks,
      learningFor: vi.fn(() => f.ports.checks),
    };
  });
  const options: SupportLearningCompositionOptions = sourceOnly
    ? {
        source: {
          serviceAccess: f.ports.serviceAccess,
          knowledgeAccess: f.ports.knowledgeAccess,
          retirementAccess: f.ports.retirementAccess,
          reviewPolicy,
        },
        readScheduling: "sdk",
      }
    : {
        production: {
          intakeEnabled: false,
          enabled: () => generationEnabled,
          configuration: {
            productContext: { resolve: async () => source.product! },
            serviceAccess: f.ports.serviceAccess,
            knowledgeAccess: f.ports.knowledgeAccess,
            retirementAccess: f.ports.retirementAccess,
            targets: f.ports.targets,
            model: {
              readRoute: () => undefined,
              allowlist: [
                {
                  model: config.model,
                  provider: config.provider,
                  endpointTag: "fictional/learning",
                  outputTokenParameter: "max_tokens",
                },
              ],
              counter: {
                count: (text) => Math.max(1, text.length),
                qualification: {
                  model: config.model,
                  modelVersion: config.modelVersion,
                  wireVersion: SUPPORT_LEARNING_WIRE_VERSION,
                  framingTokens: config.framingTokens,
                  evidenceRef: "fictional-tokenizer",
                  verifiedAt: f.clock.now(),
                  validUntil: until,
                },
              },
              readApiKey: keyReads,
              fetch: modelCalls,
            },
            usagePolicy: {
              version: "fictional-composition-funding",
              scopeRef: "synthetic-learning-only-usage",
              configurationVersion: config.version,
              modelVersion: config.modelVersion,
              pricingRef: config.pricingRef,
              currency: "USD",
              maxCostMicros: 100_000,
              maxReservationCostMicros: 10_000,
              maxReservations: 4,
              validFrom: f.clock.now(),
              validUntil: until,
              terminalRetentionMilliseconds: 60_000,
            },
          },
        },
        independentChecks: {
          authority: f.ports.serviceAccess,
          enabled: () => false,
          readApiKey: keyReads,
          fetch: modelCalls,
        },
        readScheduling: "sdk",
      };
  if (intake !== undefined) {
    Reflect.set(options, "intake", {
      enabled: intake,
      productContext: { resolve: async () => source.product! },
    });
  }
  const graph = createSupportLearningComposition(options);
  const logger = { log() {} };
  const identity = createIdentityRuntime(
    {
      store: f.store,
      emailCodeSecretBase64: btoa("s".repeat(32)),
      emailFrom: "Pegma <synthetic@example.test>",
      emailEnabled: false,
    },
    logger,
  );
  const support = createSupportRuntime({
    store: f.store,
    clock: f.clock,
    identity: identity.identity,
    sessions: identity.sessions,
    logger,
    identityLinkFromClaims: identityLinkKeyFromVerifiedIdentityClaims,
    resolutionLearning: graph.application,
  });
  const knowledgeOptions = {
    logger,
    sessions: identity.sessions,
    identity: identity.identity,
    identityLinkFromClaims: identityLinkKeyFromVerifiedIdentityClaims,
    roleStore: support.roleStore,
    agentAccess: null,
  };
  return {
    f,
    graph,
    support,
    knowledgeOptions,
    options,
    articleId: delivered.articleId,
    modelCalls,
    keyReads,
    setGeneration(value: boolean) {
      generationEnabled = value;
    },
    reviewPolicy,
    approvedPolicy,
    setPolicy(
      value: Awaited<ReturnType<LearningCheckPolicyPort["resolvePolicy"]>>,
    ) {
      currentPolicy = value;
    },
  };
}

describe("shared production learning graph", () => {
  it("defaults OFF and refuses verifier work before actual applications are bound", async () => {
    const graph = createSupportLearningComposition();
    expect(graph.application.enabled).toBe(false);
    expect(graph.ready()).toBe(false);
    expect(graph.readChecks()).toBeUndefined();
    expect(graph.browserRuntime()).toBeUndefined();
    expect(graph.runtime()).toBeUndefined();
    expect(
      graph.processingFor({ ticketId: "unbound", sourceGeneration: 1 }),
    ).toBeUndefined();
    expect(graph.retrievalOptions()).toBeUndefined();
    expect(
      await graph.precomputePending("unbound", {
        deadline: "2026-11-12T00:00:00.000Z",
        signal: new AbortController().signal,
      }),
    ).toEqual({ outcome: "held" });
    expect(checkerFactory).not.toHaveBeenCalled();
  });

  it("binds one exact Support/KB pair and propagates one verifier while generation stays OFF", async () => {
    const {
      f,
      graph,
      support,
      knowledgeOptions,
      articleId,
      modelCalls,
      keyReads,
    } = await fixture();
    const reference = (
      await f.knowledge.getProvenance(f.actors.staff, { articleId })
    ).snapshot.references[0]!;
    const request = { access: f.actors.staff, articleId, reference };
    expect(await graph.sources.canRead(request)).toBe(false);
    expect(graph.bindSupport(support)).toBe(true);
    expect(await graph.sources.canRead(request)).toBe(false);
    const knowledge = graph.createKnowledge(knowledgeOptions);
    if (knowledge === undefined) throw new Error("Expected bound KB runtime");
    expect(graph.ready()).toBe(true);
    expect(graph.processingEnabled()).toBe(false);
    expect(graph.bindSupport(support)).toBe(true);
    expect(graph.createKnowledge(knowledgeOptions)).toBe(knowledge);
    expect(checkerFactory).toHaveBeenCalledOnce();
    const checkerOptions: SupportIndependentChecksOptions =
      checkerFactory.mock.calls[0]![0];
    expect(checkerOptions.application()).toBe(support.application);
    expect(checkerOptions.knowledge).toBe(knowledge.application);
    expect(checkerOptions.store).toBe(support.store);
    expect(checkerOptions.clock).toBe(support.clock);
    expect(graph.browserRuntime()?.application).toBe(support.application);
    expect(graph.browserRuntime()?.knowledge).toBe(knowledge.application);
    expect(graph.browserRuntime()?.sources).toBe(graph.sources);
    expect(graph.retrievalOptions()?.privateSources).toBe(graph.sources);
    expect(await graph.sources.canRead(request)).toBe(true);
    expect(
      await knowledge.application.getPublishedArticle(f.actors.customer, {
        articleId,
      }),
    ).toMatchObject({ articleId });
    expect(graph.runtime()).toBeDefined();
    const source = await support.application.readResolutionLearningSource(
      f.actors.staff,
      learningTicketId,
    );
    expect(
      graph.processingFor({
        ticketId: learningTicketId,
        sourceGeneration: source.sourceGeneration,
      }),
    ).toBeDefined();
    expect(modelCalls).not.toHaveBeenCalled();
    expect(keyReads).not.toHaveBeenCalled();
  });

  it("serves approved guidance with source governance alone and no provider or receipt configuration", async () => {
    const {
      f,
      graph,
      support,
      knowledgeOptions,
      options,
      articleId,
      reviewPolicy,
      approvedPolicy,
    } = await fixture(true);
    expect(options.production).toBeUndefined();
    expect(options.independentChecks).toBeUndefined();
    expect(graph.application.enabled).toBe(false);
    expect(graph.bindSupport(support)).toBe(true);
    const knowledge = graph.createKnowledge(knowledgeOptions);
    if (knowledge === undefined) throw new Error("Expected source-only KB");
    expect(graph.ready()).toBe(true);
    expect(graph.readChecks()).toBeUndefined();
    expect(checkerFactory).not.toHaveBeenCalled();
    expect(graph.processingEnabled()).toBe(false);
    expect(graph.browserRuntime()?.application).toBe(support.application);
    expect(graph.browserRuntime()?.sources).toBe(graph.sources);
    expect(graph.retrievalOptions()?.privateSources).toBe(graph.sources);
    await expect(
      knowledge.application.getPublishedArticle(f.actors.customer, {
        articleId,
      }),
    ).resolves.toMatchObject({ articleId });
    expect(reviewPolicy.resolvePolicy).toHaveBeenCalledWith(
      undefined,
      expect.any(AbortSignal),
    );
    expect(reviewPolicy.resolvePolicy).toHaveBeenCalledWith(
      approvedPolicy.version,
      expect.any(AbortSignal),
    );
    // Serving governance cannot grant new receipt or review authority.
    await expect(
      graph
        .browserRuntime()
        ?.ports?.checks?.resolvePolicy(
          approvedPolicy.version,
          new AbortController().signal,
        ),
    ).resolves.toEqual({ outcome: "unavailable" });
    expect(
      graph.processingFor({ ticketId: learningTicketId, sourceGeneration: 1 }),
    ).toBeUndefined();
    expect(f.state.modelCalls).toBe(1);
  });

  it.each(["revoked", "expired", "changed"] as const)(
    "suppresses approved guidance when source governance is %s",
    async (condition) => {
      const {
        f,
        graph,
        support,
        knowledgeOptions,
        articleId,
        approvedPolicy,
        setPolicy,
      } = await fixture(true);
      expect(graph.bindSupport(support)).toBe(true);
      const knowledge = graph.createKnowledge(knowledgeOptions);
      if (knowledge === undefined) throw new Error("Expected source-only KB");
      await expect(
        knowledge.application.getPublishedArticle(f.actors.customer, {
          articleId,
        }),
      ).resolves.toMatchObject({ articleId });
      setPolicy(
        condition === "revoked"
          ? { outcome: "disabled" }
          : {
              outcome: "ready",
              policy: {
                ...approvedPolicy,
                ...(condition === "expired"
                  ? { validUntil: f.clock.now() }
                  : {
                      version: `${approvedPolicy.version}-next`,
                      binding: `${approvedPolicy.binding}-next`,
                    }),
              },
            },
      );
      await expect(
        knowledge.application.getPublishedArticle(f.actors.customer, {
          articleId,
        }),
      ).rejects.toBeInstanceOf(KnowledgeBaseNotFoundError);
      expect(graph.ready()).toBe(true);
      expect(checkerFactory).not.toHaveBeenCalled();
    },
  );

  it.each(["serviceAccess", "reviewPolicy"] as const)(
    "fails closed for an explicit source input missing %s",
    async (field) => {
      const { options, support } = await fixture(true);
      const graph = createSupportLearningComposition({
        ...options,
        source: {
          ...options.source!,
          [field]: undefined,
        } as unknown as NonNullable<
          SupportLearningCompositionOptions["source"]
        >,
      });
      expect(graph.bindSupport(support)).toBe(false);
      expect(graph.ready()).toBe(false);
      expect(graph.runtime()).toBeUndefined();
      expect(graph.retrievalOptions()).toBeUndefined();
      expect(checkerFactory).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    "suppresses actual published guidance on source reopen and retains reconciliation (source-only %s)",
    async (sourceOnly) => {
      const {
        f,
        graph,
        support,
        knowledgeOptions,
        articleId,
        modelCalls,
        keyReads,
      } = await fixture(sourceOnly);
      expect(graph.bindSupport(support)).toBe(true);
      const knowledge = graph.createKnowledge(knowledgeOptions);
      if (knowledge === undefined) throw new Error("Expected bound KB runtime");
      expect(
        await knowledge.application.getPublishedArticle(f.actors.customer, {
          articleId,
        }),
      ).toMatchObject({ articleId });
      const before = await support.application.readResolutionLearningSource(
        f.actors.staff,
        learningTicketId,
      );
      await support.application.reopenTicket(f.actors.staff, {
        ...f.command("composition-reopen"),
        ticketId: learningTicketId,
      });
      const after = await support.application.readResolutionLearningSource(
        f.actors.staff,
        learningTicketId,
      );
      expect(after.state).toBe("held");
      expect(after.sourceGeneration).toBeGreaterThan(before.sourceGeneration);
      expect(after.reconciliationPending).toBe(true);
      await expect(
        knowledge.application.getPublishedArticle(f.actors.customer, {
          articleId,
        }),
      ).rejects.toBeInstanceOf(KnowledgeBaseNotFoundError);
      const runtime = graph.runtime();
      if (runtime === undefined)
        throw new Error("Source maintenance must remain composed");
      expect(graph.processingEnabled()).toBe(false);
      await expect(
        runtime.processWork({
          ticketId: learningTicketId,
          sourceGeneration: after.sourceGeneration,
          workerId: "fictional-disabled-worker",
          leaseMilliseconds: 10_000,
        }),
      ).resolves.toMatchObject({ outcome: "held" });
      expect(
        (await runtime.scanMaintenanceCandidates({ limit: 1 })).physicalRows,
      ).toBe(1);
      const reconciled = await runtime.reconcileSource(learningTicketId);
      expect(reconciled.outcome).toBe("reconciled");
      expect(
        (
          await support.application.readResolutionLearningSource(
            f.actors.staff,
            learningTicketId,
          )
        ).state,
      ).toBe("held");
      expect(f.state.modelCalls).toBe(1);
      expect(modelCalls).not.toHaveBeenCalled();
      expect(keyReads).not.toHaveBeenCalled();
    },
  );

  it.each(["application", "store", "clock"] as const)(
    "refuses a conflicting Support %s binding",
    async (field) => {
      const { graph, support, knowledgeOptions } = await fixture();
      expect(graph.bindSupport(support)).toBe(true);
      expect(graph.createKnowledge(knowledgeOptions)).toBeDefined();
      const other =
        field === "application"
          ? {
              ...support,
              application: createSupportRuntime({
                ...support,
                logger: { log() {} },
              }).application,
            }
          : field === "store"
            ? { ...support, store: createMemoryStore() }
            : { ...support, clock: { now: support.clock.now } };
      expect(graph.bindSupport(other)).toBe(false);
      expect(graph.ready()).toBe(false);
      expect(graph.readChecks()).toBeUndefined();
      expect(graph.browserRuntime()).toBeUndefined();
      expect(checkerFactory).toHaveBeenCalledOnce();
    },
  );

  it("refuses conflicting KB configuration and a different explicit source verifier", async () => {
    const { graph, support, knowledgeOptions } = await fixture();
    expect(graph.bindSupport(support)).toBe(true);
    const other: PrivateSourcesVerifier = {
      canRead: async () => true,
      canPublish: async () => true,
      isCurrent: async () => true,
    };
    const conflicting = { ...knowledgeOptions, privateSources: other };
    expect(graph.createKnowledge(conflicting)).toBeUndefined();
    expect(graph.ready()).toBe(false);
    expect(checkerFactory).not.toHaveBeenCalled();
  });
});


async function humanIntakeFixture(enabled = true, withProduct = true) {
  const f = await createSupportLearningFixture(createMemoryStore(), {
    intake: false,
    processing: false,
  });
  const check = vi.spyOn(f.ports.checks, "check");
  const verify = vi.spyOn(f.ports.checks, "verify");
  const productContext: NonNullable<
    ResolutionLearningOptions["productContext"]
  > = {
    resolve: vi.fn(async (context) => ({
      productId: f.product.productId,
      version: f.product.productVersion,
      buildId: f.product.buildId,
      binding: "synthetic-human-intake-build",
      contextVersion: "synthetic-human-intake-v1",
      receiptId: "synthetic-human-product-" + context.ticketId,
      verifiedAt: context.acceptedAt,
      validUntil: new Date(
        Date.parse(context.acceptedAt) + 60_000,
      ).toISOString(),
    })),
  };
  const options: SupportLearningCompositionOptions = {
    source: {
      serviceAccess: f.ports.serviceAccess,
      knowledgeAccess: f.ports.knowledgeAccess,
      retirementAccess: f.ports.retirementAccess,
      reviewPolicy: {
        resolvePolicy: (...args) => f.ports.checks.resolvePolicy(...args),
      },
    },
    intake: { enabled, ...(withProduct ? { productContext } : {}) },
    readScheduling: "sdk",
  };
  const graph = createSupportLearningComposition(options);
  const logger = { log() {} };
  const identity = createIdentityRuntime(
    {
      store: f.store,
      emailCodeSecretBase64: btoa("s".repeat(32)),
      emailFrom: "Pegma <synthetic@example.test>",
      emailEnabled: false,
    },
    logger,
  );
  const support = createSupportRuntime({
    store: f.store,
    clock: f.clock,
    identity: identity.identity,
    sessions: identity.sessions,
    logger,
    identityLinkFromClaims: identityLinkKeyFromVerifiedIdentityClaims,
    resolutionLearning: graph.application,
  });
  const bound = graph.bindSupport(support);
  const knowledge = graph.createKnowledge({
    logger,
    sessions: identity.sessions,
    identity: identity.identity,
    identityLinkFromClaims: identityLinkKeyFromVerifiedIdentityClaims,
    roleStore: support.roleStore,
    agentAccess: null,
  });
  const browser = graph.browserRuntime();
  const runtime =
    browser === undefined
      ? undefined
      : createSupportLearningRuntime({
          ...browser,
          staffAccess: {
            async resolve(principalId, signal) {
              if (signal.aborted) return null;
              const access = await f.resolve(principalId);
              return signal.aborted ? null : access;
            },
          },
        });
  return {
    f,
    graph,
    options,
    support,
    knowledge,
    bound,
    browser,
    runtime,
    productContext,
    check,
    verify,
  };
}

async function verifyHumanTicket(
  t: Awaited<ReturnType<typeof humanIntakeFixture>>,
) {
  if (t.runtime === undefined)
    throw new Error("Expected source-ready human runtime");
  const ticket = await t.f.terminal();
  await t.runtime.enroll(t.f.actors.staff, {
    clientCommandId: "HUMAN-ENROLL",
    ticketId: learningTicketId,
    expectedRevision: ticket.revision,
  });
  const source = await t.runtime.readSource(t.f.actors.staff, learningTicketId);
  const packet = {
    clientCommandId: "HUMAN-VERIFIED-FIX",
    ticketId: learningTicketId,
    expectedRevision: ticket.revision,
    resolutionCycle: source.resolutionCycle,
    evidence: {
      kind: "staff_verified_fix" as const,
      solutionMessageId: "learning-solution",
      verificationReference: "SYNTHETIC_PRIVATE_HUMAN_VERIFICATION",
    },
  };
  const accepted = await t.runtime.submitVerifiedFix(t.f.actors.staff, packet);
  return { ticket, packet, accepted };
}

describe("explicit nonpaid learning intake", () => {
  it("admits actual staff evidence to eligible Source and pending Work with every paid port absent", async () => {
    const t = await humanIntakeFixture();
    expect(t.bound).toBe(true);
    expect(t.graph.ready()).toBe(true);
    expect(t.knowledge).toBeDefined();
    expect(t.browser?.application).toBe(t.support.application);
    expect(t.graph.application.enabled).toBe(true);
    if (t.runtime === undefined)
      throw new Error("Expected source-ready human runtime");
    const { packet, accepted } = await verifyHumanTicket(t);
    expect(accepted.state).toBe("eligible");
    const key = {
      ticketId: learningTicketId,
      sourceGeneration: accepted.sourceGeneration,
    };
    const work = await t.runtime.readWork(t.f.actors.staff, key);
    expect(work.status).toBe("pending");
    expect(work.candidate).toBeUndefined();
    expect(t.graph.processingEnabled()).toBe(false);
    expect(
      await t.runtime.processWork({
        ...key,
        workerId: "human-only",
        leaseMilliseconds: 10_000,
      }),
    ).toMatchObject({ outcome: "held" });
    expect(await t.runtime.submitVerifiedFix(t.f.actors.staff, packet)).toEqual(
      accepted,
    );
    expect(t.f.state.modelCalls).toBe(0);
    expect(t.check).not.toHaveBeenCalled();
    expect(t.verify).not.toHaveBeenCalled();
    expect(checkerFactory).not.toHaveBeenCalled();
  });

  it("admits real owner success confirmation to Source and pending Work without model readiness", async () => {
    const t = await humanIntakeFixture();
    const customer = customerAccessContext(t.f.actors.customer.principalId);
    const command = (label: string) => {
      const { commandId, correlationId } = t.f.command(label);
      return { commandId, correlationId, ticketId: learningTicketId };
    };
    await t.support.application.createCustomerTicket(customer, {
      ...command("human-create"),
      messageId: "human-learning-question",
      subject: "Synthetic learning question",
      body: "How do I export a workspace?",
    });
    await t.support.application.replyAsStaff(t.f.actors.staff, {
      ...command("human-solution"),
      messageId: "human-learning-solution",
      body: "Open Workspace and choose Export.",
    });
    await t.support.application.resolveTicket(
      t.f.actors.staff,
      command("human-resolve"),
    );
    const ticket = (
      await t.support.application.readStaffTicket(
        t.f.actors.staff,
        learningTicketId,
      )
    ).ticket;
    const packet = {
      ...command("human-customer-success"),
      lastSeenVisibleMessageId: "human-learning-solution",
    };
    const result = await t.support.application.confirmCustomerSuccess(
      customer,
      packet,
    );
    expect(result).toBeDefined();
    const source = await t.support.application.readResolutionLearningSource(
      t.f.actors.staff,
      ticket.id,
    );
    expect(source.state).toBe("eligible");
    const work = await t.support.application.readResolutionLearningWork(
      t.f.actors.staff,
      {
        ticketId: ticket.id,
        sourceGeneration: source.sourceGeneration,
      },
    );
    expect(work.status).toBe("pending");
    expect(t.graph.processingEnabled()).toBe(false);
    expect(t.graph.readChecks()).toBeUndefined();
    expect(t.f.state.modelCalls).toBe(0);
    expect(t.check).not.toHaveBeenCalled();
    expect(t.verify).not.toHaveBeenCalled();
    expect(checkerFactory).not.toHaveBeenCalled();
  });
});

describe("explicit human intake boundaries", () => {
  it.each(["off", "missing-product"] as const)(
    "keeps %s intake disabled while recording normal owner success",
    async (condition) => {
      const t = await humanIntakeFixture(
        condition !== "off",
        condition !== "missing-product",
      );
      expect(t.graph.ready()).toBe(true);
      expect(t.graph.application.enabled).toBe(false);
      const ticket = await t.f.terminal();
      const customer = customerAccessContext(t.f.actors.customer.principalId);
      const { commandId, correlationId } = t.f.command(
        "disabled-intake-success",
      );
      await t.support.application.confirmCustomerSuccess(customer, {
        commandId,
        correlationId,
        ticketId: ticket.id,
        lastSeenVisibleMessageId: "learning-solution",
      });
      expect(
        await t.support.application.readCustomerSuccessConfirmations(
          t.f.actors.admin,
          ticket.id,
        ),
      ).toHaveLength(1);
      await expect(
        t.support.application.readResolutionLearningSource(
          t.f.actors.staff,
          ticket.id,
        ),
      ).rejects.toBeInstanceOf(SupportDeskNotFoundError);
      expect(t.productContext.resolve).not.toHaveBeenCalled();
      expect(t.f.state.modelCalls).toBe(0);
      expect(t.check).not.toHaveBeenCalled();
      expect(t.verify).not.toHaveBeenCalled();
    },
  );

  it("does not create intake authority from a product resolver without valid Source ports", async () => {
    const t = await humanIntakeFixture();
    const graph = createSupportLearningComposition({
      ...t.options,
      source: undefined,
    });
    expect(graph.application.enabled).toBe(false);
    expect(graph.bindSupport(t.support)).toBe(false);
    expect(graph.ready()).toBe(false);
    expect(graph.browserRuntime()).toBeUndefined();
    expect(t.productContext.resolve).not.toHaveBeenCalled();
    expect(checkerFactory).not.toHaveBeenCalled();
  });

  it("rechecks the actual stored staff role before admitting evidence", async () => {
    const t = await humanIntakeFixture();
    if (t.runtime === undefined)
      throw new Error("Expected source-ready human runtime");
    const ticket = await t.f.terminal();
    await t.f.revokeStaff();
    await expect(
      t.runtime.enroll(t.f.actors.staff, {
        clientCommandId: "REVOKED-HUMAN-ENROLL",
        ticketId: ticket.id,
        expectedRevision: ticket.revision,
      }),
    ).rejects.toThrow();
    await expect(
      t.support.application.readResolutionLearningSource(
        t.f.actors.staff,
        ticket.id,
      ),
    ).rejects.toBeInstanceOf(SupportDeskNotFoundError);
    expect(t.productContext.resolve).not.toHaveBeenCalled();
    expect(t.f.state.modelCalls).toBe(0);
  });

  it("preserves legacy limits, test receipts and SDK check-verifier capability", async () => {
    const t = await fixture();
    const production = t.options.production;
    if (production?.configuration === undefined)
      throw new Error("Expected legacy configuration");
    const testReceipts: NonNullable<ResolutionLearningOptions["testReceipts"]> =
      {
        verify: vi.fn(async () => null),
      };
    const retained = {
      maxGenerations: 7,
      maxTargets: 3,
      maxReviewBindings: 5,
      trustTimeoutMilliseconds: 500,
      maxModelAttempts: 2,
      testReceipts,
    };
    const options = {
      ...t.options,
      production: {
        ...production,
        configuration: { ...production.configuration, application: retained },
      },
    };
    const legacy = createSupportLearningComposition(options);
    const productContext = { resolve: vi.fn(async () => null) };
    const overridden = createSupportLearningComposition({
      ...options,
      intake: { enabled: false, productContext },
    });
    expect(legacy.application.productContext).toBe(
      production.configuration.productContext,
    );
    for (const graph of [legacy, overridden]) {
      expect(graph.application).toMatchObject(retained);
      expect(graph.application.testReceipts).toBe(testReceipts);
      expect(graph.application.checks?.verify).toBeTypeOf("function");
    }
    expect(overridden.application.enabled).toBe(false);
    expect(overridden.application.productContext).not.toBe(
      legacy.application.productContext,
    );
    expect(productContext.resolve).not.toHaveBeenCalled();
    expect(testReceipts.verify).not.toHaveBeenCalled();
  });

  it("keeps SDK enabled-false claims null and retained pending Work unchanged", async () => {
    const t = await humanIntakeFixture();
    const { accepted } = await verifyHumanTicket(t);
    const key = {
      ticketId: learningTicketId,
      sourceGeneration: accepted.sourceGeneration,
    };
    const before = await t.support.application.readResolutionLearningWork(
      t.f.actors.staff,
      key,
    );
    const graph = createSupportLearningComposition({
      ...t.options,
      intake: { enabled: false, productContext: t.productContext },
    });
    const support = createSupportRuntime({
      ...t.support,
      logger: { log() {} },
      resolutionLearning: graph.application,
    });
    const authority = await t.f.ports.serviceAccess.resolve(
      new AbortController().signal,
    );
    if (authority.outcome !== "ready")
      throw new Error("Expected actual current service role");
    expect(
      await support.application.claimResolutionLearningWork(
        authority.authority.access,
        {
          ...key,
          workerId: "disabled-application",
          claimId: "disabled-application-claim",
          leaseMilliseconds: 10_000,
        },
      ),
    ).toBeNull();
    expect(
      await support.application.readResolutionLearningWork(
        t.f.actors.staff,
        key,
      ),
    ).toEqual(before);
    expect(t.f.state.modelCalls).toBe(0);
    expect(t.check).not.toHaveBeenCalled();
    expect(t.verify).not.toHaveBeenCalled();
  });

  it.each(["reopen", "withdraw"] as const)(
    "continues hiding private guidance after %s with explicit intake and the model OFF",
    async (operation) => {
      const t = await fixture(true, true);
      expect(t.graph.application.enabled).toBe(true);
      expect(t.graph.bindSupport(t.support)).toBe(true);
      const knowledge = t.graph.createKnowledge(t.knowledgeOptions);
      if (knowledge === undefined) throw new Error("Expected actual bound KB");
      await expect(
        knowledge.application.getPublishedArticle(t.f.actors.customer, {
          articleId: t.articleId,
        }),
      ).resolves.toMatchObject({ articleId: t.articleId });
      if (operation === "reopen") {
        const { commandId, correlationId } = t.f.command("human-intake-reopen");
        await t.support.application.replyToCustomerTicket(
          customerAccessContext(t.f.actors.customer.principalId),
          {
            commandId,
            correlationId,
            ticketId: learningTicketId,
            messageId: "human-customer-reopen",
            body: "The export issue has returned.",
          },
        );
      } else {
        const browser = t.graph.browserRuntime();
        if (browser === undefined)
          throw new Error("Expected current source-ready browser runtime");
        const runtime = createSupportLearningRuntime({
          ...browser,
          staffAccess: {
            async resolve(principalId, signal) {
              return signal.aborted ? null : t.f.resolve(principalId);
            },
          },
        });
        await runtime.withdraw(t.f.actors.staff, {
          ticketId: learningTicketId,
          clientCommandId: "HUMAN-INTAKE-WITHDRAW",
          reason: "privacy_withdrawal",
        });
      }
      await expect(
        knowledge.application.getPublishedArticle(t.f.actors.customer, {
          articleId: t.articleId,
        }),
      ).rejects.toBeInstanceOf(KnowledgeBaseNotFoundError);
      expect(t.graph.ready()).toBe(true);
      expect(t.graph.processingEnabled()).toBe(false);
      expect(t.modelCalls).not.toHaveBeenCalled();
      expect(t.keyReads).not.toHaveBeenCalled();
      expect(t.f.state.modelCalls).toBe(1);
      expect(checkerFactory).not.toHaveBeenCalled();
    },
  );
});
