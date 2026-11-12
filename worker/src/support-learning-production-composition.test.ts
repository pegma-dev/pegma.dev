import { createMemoryStore } from "@pegma/storage-core";
import { identityLinkKeyFromVerifiedIdentityClaims } from "@pegma/authorization-identity";
import { KnowledgeBaseNotFoundError } from "@pegma/knowledge-base-application";
import type { PrivateSourcesVerifier } from "@pegma/knowledge-base-application";
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

async function fixture() {
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
  const options: SupportLearningCompositionOptions = {
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

  it("suppresses actual published guidance on source reopen with generation OFF and retains reconciliation", async () => {
    const {
      f,
      graph,
      support,
      knowledgeOptions,
      articleId,
      modelCalls,
      keyReads,
    } = await fixture();
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
  });

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
