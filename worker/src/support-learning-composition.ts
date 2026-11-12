import type { PrivateSourcesVerifier } from "@pegma/knowledge-base-application";
import type {
  ResolutionLearningKey,
  ResolutionLearningOptions,
} from "@pegma/support-desk-application";
import type {
  LearningCheckPolicyPort,
  LearningChecksPort,
} from "@pegma/support-desk-ai";
import { createAgentPrincipalResolver } from "./agent-authority";
import type { SupportRuntime } from "./support-desk";
import {
  createKnowledgeRuntime,
  type KnowledgeRuntime,
  type KnowledgeRuntimeOptions,
} from "./knowledge-runtime";
import {
  createSupportIndependentChecks,
  type IndependentCheckCapture,
  type SupportIndependentChecksOptions,
} from "./support-independent-checks";
import {
  createSupportLearningRuntime,
  createSupportLearningSourceBridge,
  type SupportLearningRuntimeOptions,
} from "./support-learning";
import {
  createProductionSupportLearning,
  type SupportLearningProductionOptions,
} from "./support-learning-production";

type Configuration = NonNullable<
  SupportLearningProductionOptions["configuration"]
>;
type Checks = ReturnType<typeof createSupportIndependentChecks>;
type KnowledgeOptions = Omit<
  KnowledgeRuntimeOptions,
  "store" | "clock" | "privateSources"
>;
type BrowserRuntime = Omit<SupportLearningRuntimeOptions, "staffAccess">;

/** Current operator-owned inputs only. The graph creates no identity, role,
 * credential, route approval, timer, queue or publication permission. */
export interface SupportLearningCompositionOptions {
  /** Current source authority and review governance, independent of generation.
   * Policy identity, expiry and revocation belong to the supplied resolver. */
  readonly source?: Pick<
    Configuration,
    "serviceAccess" | "knowledgeAccess" | "retirementAccess"
  > & {
    readonly reviewPolicy: LearningCheckPolicyPort;
  };
  /** Explicit human intake and current product proof, independent of paid ports. */
  readonly intake?: Pick<ResolutionLearningOptions, "enabled" | "productContext">;
  readonly production?: Omit<
    SupportLearningProductionOptions,
    "configuration"
  > & {
    readonly configuration?: Omit<Configuration, "readChecks">;
  };
  /** One controller shared by the root's learning and engineering composition.
   * Actual Support and KB applications are supplied only after construction. */
  readonly independentChecks?: Omit<
    SupportIndependentChecksOptions,
    "store" | "clock" | "application" | "knowledge" | "knowledgeAccess"
  >;
  /** Optional purpose-bound controller sharing the same durable checker pool. */
  readonly engineeringIndependentChecks?: SupportLearningCompositionOptions["independentChecks"];
  readonly readScheduling?: SupportLearningRuntimeOptions["readScheduling"];
  readonly deliveryMode?: SupportLearningRuntimeOptions["deliveryMode"];
}

/** Build before Support, bind its exact application, then construct KB here.
 * Keep this same sources object in answering and both KB maintenance factories. */
export function createSupportLearningComposition(
  options: SupportLearningCompositionOptions = {},
) {
  let support: SupportRuntime | undefined;
  let knowledge: KnowledgeRuntime | undefined;
  let knowledgeOptions: KnowledgeOptions | undefined;
  let checks: Checks | undefined;
  let engineeringChecks: Checks | undefined;
  let engineeringRepositories: SupportIndependentChecksOptions["repositories"];
  let verifier: PrivateSourcesVerifier | undefined;
  let failed = false;
  const supplied = options.production?.configuration;
  const configured =
    supplied !== undefined && options.independentChecks !== undefined;
  const readChecks = () => (failed ? undefined : checks);
  const production = createProductionSupportLearning(
    !configured
      ? {}
      : {
          ...options.production,
          configuration: { ...supplied, readChecks },
        },
  );

  const policy: Pick<LearningChecksPort, "resolvePolicy"> = Object.freeze({
    resolvePolicy: (...args) =>
      readChecks()?.resolvePolicy(...args) ??
      Promise.resolve({ outcome: "unavailable" as const }),
  });
  const source = options.source;
  const sourcePorts =
    source === undefined
      ? production.sourcePorts
      : [
            source.serviceAccess?.resolve,
            source.knowledgeAccess?.resolve,
            source.retirementAccess?.resolve,
            source.reviewPolicy?.resolvePolicy,
          ].every((value) => typeof value === "function")
        ? Object.freeze({
            serviceAccess: source.serviceAccess,
            knowledgeAccess: source.knowledgeAccess,
            retirementAccess: source.retirementAccess,
          })
        : undefined;
  const intake = options.intake;
  function intakeEnabled(): boolean {
    try {
      return (
        !failed &&
        sourcePorts !== undefined &&
        options.intake === intake &&
        intake?.enabled === true &&
        typeof intake.productContext?.resolve === "function"
      );
    } catch {
      return false;
    }
  }
  // Preserve every existing limit, test receipt and SDK check verifier. An
  // explicit intake choice replaces only the gate and trusted product binding.
  const application =
    intake === undefined
      ? production.application
      : Object.freeze<ResolutionLearningOptions>({
          ...production.application,
          enabled: intakeEnabled(),
          productContext: {
            async resolve(...args) {
              if (!intakeEnabled() || intake.productContext === undefined)
                return null;
              const product = await intake.productContext.resolve(...args);
              return intakeEnabled() ? product : null;
            },
          },
        });

  const unscopedChecks: LearningChecksPort = Object.freeze({
    ...policy,
    check: async () => ({ outcome: "held" as const }),
    verify: (...args: Parameters<LearningChecksPort["verify"]>) =>
      readChecks()?.learningSdkVerifier.verify(...args) ??
      Promise.resolve(null),
  });
  function ready(): boolean {
    return (
      !failed &&
      support !== undefined &&
      knowledge !== undefined &&
      sourcePorts !== undefined &&
      (source !== undefined || checks !== undefined)
    );
  }
  function sourceVerifier(): PrivateSourcesVerifier | undefined {
    if (!ready() || support === undefined || sourcePorts === undefined)
      return undefined;
    verifier ??= createSupportLearningSourceBridge({
      application: support.application,
      clock: support.clock,
      serviceAccess: sourcePorts.serviceAccess,
      reviewPolicy: source === undefined ? policy : source.reviewPolicy,
      ...(options.readScheduling === undefined
        ? {}
        : { readScheduling: options.readScheduling }),
    });
    return verifier;
  }
  // Only the real SDK verifier and exact application are memoized. Every call
  // retains the SDK's fresh authority, source and review-policy observations.
  const sources: PrivateSourcesVerifier = Object.freeze({
    canRead: (request: Parameters<PrivateSourcesVerifier["canRead"]>[0]) =>
      sourceVerifier()?.canRead(request) ?? Promise.resolve(false),
    canPublish: (
      request: Parameters<PrivateSourcesVerifier["canPublish"]>[0],
    ) => sourceVerifier()?.canPublish(request) ?? Promise.resolve(false),
    isCurrent: (request: Parameters<PrivateSourcesVerifier["isCurrent"]>[0]) =>
      sourceVerifier()?.isCurrent(request) ?? Promise.resolve(false),
  });
  function refuseBinding(): false {
    failed = true;
    checks = undefined;
    engineeringChecks = undefined;
    verifier = undefined;
    return false;
  }
  function runtimeOptions(): BrowserRuntime | undefined {
    if (!ready() || support === undefined || knowledge === undefined)
      return undefined;
    return {
      application: support.application,
      knowledge: knowledge.application,
      sources,
      clock: support.clock,
      processingEnabled: () => ready() && production.processingEnabled(),
      ports: { ...sourcePorts, checks: unscopedChecks },
      processingPortsFor: (key, capture) =>
        ready() ? production.createProcessingPorts(key, capture) : undefined,
      ...(options.readScheduling === undefined
        ? {}
        : { readScheduling: options.readScheduling }),
      ...(options.deliveryMode === undefined ? {} : { deliveryMode: options.deliveryMode }),
    };
  }
  return Object.freeze({
    application,
    sources,
    readChecks,
    readEngineeringChecks() {
      if (failed) return undefined;
      return options.engineeringIndependentChecks === undefined ? checks : engineeringChecks;
    },
    bindEngineeringRepositories(port: SupportIndependentChecksOptions["repositories"]) {
      if (engineeringRepositories !== undefined && engineeringRepositories !== port) return false;
      engineeringRepositories = port;
      return true;
    },
    ready,
    processingEnabled: () => ready() && production.processingEnabled(),
    bindSupport(runtime: SupportRuntime): boolean {
      if (failed || sourcePorts === undefined) return false;
      if (support !== undefined)
        return support.application === runtime.application &&
          support.store === runtime.store &&
          support.clock === runtime.clock
          ? true
          : refuseBinding();
      if (
        production.sourcePorts !== undefined &&
        !production.attachRuntime(runtime)
      )
        return refuseBinding();
      support = runtime;
      return true;
    },
    /** Forces the shared Store, Clock and verifier into the actual KB factory.
     * Rebinding this graph with different options is a closed configuration error. */
    createKnowledge(input: KnowledgeOptions): KnowledgeRuntime | undefined {
      if (failed || support === undefined || sourcePorts === undefined)
        return undefined;
      const binding = input as KnowledgeOptions &
        Partial<
          Pick<KnowledgeRuntimeOptions, "store" | "clock" | "privateSources">
        >;
      if (
        (binding.store !== undefined && binding.store !== support.store) ||
        (binding.clock !== undefined && binding.clock !== support.clock) ||
        (binding.privateSources !== undefined &&
          binding.privateSources !== sources)
      ) {
        refuseBinding();
        return undefined;
      }
      if (knowledge !== undefined) {
        if (knowledgeOptions === input) return knowledge;
        refuseBinding();
        return undefined;
      }
      try {
        knowledgeOptions = input;
        const current = support;
        knowledge = createKnowledgeRuntime({
          ...input,
          store: current.store,
          clock: current.clock,
          privateSources: sources,
        });
        if (options.independentChecks !== undefined && sourcePorts !== undefined) {
          checks = createSupportIndependentChecks({
            ...options.independentChecks!,
            store: current.store,
            clock: current.clock,
            application: () => {
              if (failed || support !== current)
                throw new TypeError("Learning Support binding unavailable");
              return current.application;
            },
            knowledge: knowledge.application,
            knowledgeAccess: sourcePorts.knowledgeAccess,
          });
        }
        if (sourcePorts !== undefined && options.engineeringIndependentChecks !== undefined) {
          const selected = options.engineeringIndependentChecks;
          engineeringChecks = createSupportIndependentChecks({
            ...selected,
            store: current.store,
            clock: current.clock,
            application: () => {
              if (failed || support !== current) throw new TypeError("Engineering Support binding unavailable");
              return current.application;
            },
            knowledge: knowledge.application,
            knowledgeAccess: sourcePorts.knowledgeAccess,
            repositories: engineeringRepositories ?? selected.repositories,
          });
        }
        return knowledge;
      } catch {
        refuseBinding();
        return undefined;
      }
    },
    browserRuntime: runtimeOptions,
    /** Reconciliation stays available when model generation or its route is OFF. */
    runtime(): ReturnType<typeof createSupportLearningRuntime> | undefined {
      const base = runtimeOptions();
      if (base === undefined || support === undefined) return undefined;
      const resolve = createAgentPrincipalResolver(support);
      return createSupportLearningRuntime({
        ...base,
        staffAccess: {
          async resolve(principalId, signal) {
            if (signal.aborted) return null;
            const access = await resolve(principalId);
            return signal.aborted ? null : access;
          },
        },
      });
    },
    processingFor(
      key: ResolutionLearningKey,
      capture: IndependentCheckCapture = {},
    ) {
      const base = runtimeOptions();
      if (base === undefined || support === undefined) return undefined;
      const ports = production.createProcessingPorts(key, capture);
      if (ports === undefined) return undefined;
      const resolve = createAgentPrincipalResolver(support);
      return createSupportLearningRuntime({
        ...base,
        ports,
        staffAccess: {
          async resolve(principalId, signal) {
            if (signal.aborted) return null;
            const access = await resolve(principalId);
            return signal.aborted ? null : access;
          },
        },
      });
    },
    /** Forward unchanged to ready/physical retrieval construction and answering. */
    retrievalOptions() {
      if (!ready() || support === undefined) return undefined;
      return Object.freeze({
        store: support.store,
        clock: support.clock,
        privateSources: sources,
      });
    },
    precomputePending: (...args: Parameters<Checks["precomputePending"]>) =>
      ready()
        ? production.precomputePending(...args)
        : Promise.resolve({ outcome: "held" as const }),
    discardChecks: (ticketId: string) => production.discardChecks(ticketId),
  });
}

export type SupportLearningComposition = ReturnType<
  typeof createSupportLearningComposition
>;
