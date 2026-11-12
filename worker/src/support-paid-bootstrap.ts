import { systemClock, type Clock } from '@pegma/spine';
import { knowledgeLimits } from '@pegma/knowledge-base-core';
import { engineeringPolicyRecords } from '@pegma/support-desk-application';
import type { LearningCheckPolicyPort, LearningTargetPort } from '@pegma/support-desk-ai';
import type { IndependentCheckReceiptKey } from './support-independent-checks';
import { createSupportIndependentCheckModel as createCheckModel } from './support-independent-checks-model';
import {
  createSupportLearningBootstrap,
  type SupportLearningSourceEnvironment,
} from './support-learning-bootstrap';
import { createSupportBackgroundServiceAccess } from './support-background-service-access';
import { createSupportLearningModelPorts } from './support-learning-model';
import { createSupportEngineeringModelPorts } from './support-engineering-model';
import { createSupportAssistantTokenCounter } from './support-assistant-token-counter';
import { SUPPORT_ASSISTANT_CREDENTIAL_REF } from './support-assistant-production';
import { canonical } from './support-openrouter-model';
import { knowledgeDigest } from './knowledge-evidence';
import {
  readSupportPaidProfile,
  SUPPORT_PAID_PROFILE_SETTING,
  type SupportPaidProfile,
} from './support-paid-profile';
import type { SupportLearningRootComposition } from './index';
import type { SupportEngineeringProductionOptions } from './support-engineering-production';
import type { SupportEngineeringHumanComposition } from './support-engineering-composition';

export interface SupportPaidEnvironment extends SupportLearningSourceEnvironment {
  readonly SUPPORT_PAID_CONFIGURATION_JSON?: string;
  readonly SUPPORT_ASSISTANT_OPENROUTER_API_KEY?: string;
  readonly SUPPORT_INDEPENDENT_CHECK_RECEIPT_KEY_BASE64?: string;
  readonly SUPPORT_ENGINEERING_APP_JWT?: string;
  readonly SUPPORT_ENGINEERING_INSTALLATION_TOKEN?: string;
  readonly PEGMA_SUPPORT_INDEPENDENT_CHECKS_ENABLED?: string;
  readonly PEGMA_SUPPORT_ENGINEERING_PROCESSING_ENABLED?: string;
  readonly PEGMA_SUPPORT_LEARNING_WORKER_ENABLED?: string;
  readonly PEGMA_SUPPORT_ENGINEERING_REPOSITORY_ENABLED?: string;
  readonly PEGMA_SUPPORT_ENGINEERING_ISSUE_WRITE_ENABLED?: string;
}
export interface SupportReceiptKeyProvider {
  resolve(reference: string, signal: AbortSignal): Promise<IndependentCheckReceiptKey | null>;
  current(key: IndependentCheckReceiptKey): boolean;
}
interface Options {
  readonly clock?: Clock;
  readonly currentEnv?: () => SupportPaidEnvironment;
  readonly isSelected?: () => boolean;
  readonly keyProvider?: SupportReceiptKeyProvider;
  readonly fetch?: typeof globalThis.fetch;
}
const allowed = Object.freeze([
  {
    model: 'openai/gpt-4.1-mini',
    provider: 'Azure',
    endpointTag: 'azure/swedencentral',
    outputTokenParameter: 'max_tokens' as const,
  },
]);
function live(value: { verifiedAt?: string; validUntil: string }, clock: Clock) {
  const now = Date.parse(clock.now());
  return (
    Number.isFinite(now) &&
    (value.verifiedAt === undefined || Date.parse(value.verifiedAt) <= now) &&
    now < Date.parse(value.validUntil)
  );
}
/** Dedicated operator key binding only. Never derive a receipt key from a
 * provider/session key or generate a replacement when this binding is absent. */
export function createSupportReceiptKeyProvider(
  env: SupportPaidEnvironment,
  descriptor: SupportPaidProfile['checks']['receiptKey'],
  current: () => boolean,
  clock: Clock,
  readEnv: () => SupportPaidEnvironment = () => env,
): SupportReceiptKeyProvider {
  let selected: { raw: string; key: IndependentCheckReceiptKey } | undefined;
  const provider: SupportReceiptKeyProvider = {
    async resolve(reference, signal) {
      if (
        signal.aborted ||
        !current() ||
        reference !== descriptor.reference ||
        !live(descriptor, clock)
      )
        return null;
      const raw = readEnv().SUPPORT_INDEPENDENT_CHECK_RECEIPT_KEY_BASE64;
      if (typeof raw !== 'string' || !/^[A-Za-z0-9+/]{43,86}={0,2}$/u.test(raw)) return null;
      try {
        const bytes = Uint8Array.from(atob(raw), (value) => value.charCodeAt(0));
        if (bytes.length < 32 || bytes.length > 64 || btoa(String.fromCharCode(...bytes)) !== raw)
          return null;
        const key = await crypto.subtle.importKey(
          'raw',
          bytes,
          { name: 'HMAC', hash: 'SHA-256' },
          false,
          ['sign', 'verify'],
        );
        if (
          signal.aborted ||
          !current() ||
          readEnv().SUPPORT_INDEPENDENT_CHECK_RECEIPT_KEY_BASE64 !== raw ||
          !live(descriptor, clock)
        )
          return null;
        const bound = Object.freeze({ id: descriptor.id, key, validUntil: descriptor.validUntil });
        selected = { raw, key: bound };
        return bound;
      } catch {
        return null;
      }
    },
    current(key) {
      return (
        current() &&
        live(key, clock) &&
        selected?.key === key &&
        selected.raw === readEnv().SUPPORT_INDEPENDENT_CHECK_RECEIPT_KEY_BASE64
      );
    },
  };
  return Object.freeze(provider);
}
function counter<Q extends { readonly model: string }>(qualification: Q) {
  if (qualification.model !== 'openai/gpt-4.1-mini')
    throw new TypeError('Unsupported tokenizer implementation');
  const implementation = createSupportAssistantTokenCounter(
    qualification as unknown as Parameters<typeof createSupportAssistantTokenCounter>[0],
  );
  return Object.freeze({
    qualification: Object.freeze({ ...qualification }),
    count: (text: string) => implementation.count(text),
  });
}
function targets(
  profile: NonNullable<SupportPaidProfile['learning']>,
  product: { productId: string; version: string; buildId: string },
  current: () => boolean,
): LearningTargetPort {
  const scope = profile.target;
  const port: LearningTargetPort = {
    async resolveScope(observed, context) {
      if (
        !current() ||
        context.signal.aborted ||
        observed.productId !== product.productId ||
        observed.version !== product.version ||
        observed.buildId !== product.buildId
      )
        return { outcome: 'held' };
      return {
        outcome: 'ready',
        scope: {
          version: scope.version,
          collectionId: scope.collectionId,
          kind: scope.kind,
          searchQuery: scope.searchQuery,
          explicitDraftIds: scope.explicitDraftIds,
        },
      };
    },
    async select(input, context) {
      if (
        !current() ||
        context.signal.aborted ||
        canonical(input.scope) !==
          canonical({
            version: scope.version,
            collectionId: scope.collectionId,
            kind: scope.kind,
            searchQuery: scope.searchQuery,
            explicitDraftIds: scope.explicitDraftIds,
          })
      )
        return { outcome: 'held' };
      // Existing or unpublished guidance requires an explicit merge policy.
      // This initial default policy never silently overwrites either.
      if (input.publishedMatches.length || input.explicitDrafts.length) return { outcome: 'held' };
      const candidate = input.candidate;
      const content = [
        candidate.problem,
        ...candidate.steps,
        candidate.solution,
        ...candidate.validationRequirements,
      ].join('\n\n');
      if (new TextEncoder().encode(content).length > knowledgeLimits.contentBytes)
        return { outcome: 'held' };
      let summary = candidate.problem
        .replace(/\s+/gu, ' ')
        .trim()
        .slice(0, knowledgeLimits.summaryCharacters);
      if (/[\uD800-\uDBFF]$/u.test(summary)) summary = summary.slice(0, -1);
      summary = summary.trimEnd();
      if (!summary) return { outcome: 'held' };
      return {
        outcome: 'selected',
        operation: 'create',
        articleId: input.newArticleId,
        draft: {
          kind: scope.kind,
          title: scope.title,
          summary,
          content: { format: 'plain_text', text: content },
          tags: scope.tags,
          applicability: {
            productId: candidate.applicability.productId,
            productVersion: candidate.applicability.version,
            buildId: candidate.applicability.buildId,
          },
        },
      };
    },
  };
  return Object.freeze(port);
}
/** One current immutable operator selection, with no Store or App construction.
 * Missing/unready paid ports cannot disable the separately selected Source graph. */
export async function createSupportPaidBootstrap(
  env: SupportPaidEnvironment,
  options: Options = {},
) {
  const raw = env[SUPPORT_PAID_PROFILE_SETTING];
  const profile = readSupportPaidProfile(raw);
  if (!profile) return undefined;
  const clock = options.clock ?? systemClock;
  const currentEnv = options.currentEnv ?? (() => env);
  const sourceRaw = env.SUPPORT_LEARNING_SOURCE_CONFIGURATION_JSON;
  const current = () => {
    try {
      return (
        (options.isSelected?.() ?? true) &&
        currentEnv()[SUPPORT_PAID_PROFILE_SETTING] === raw &&
        currentEnv().SUPPORT_LEARNING_SOURCE_CONFIGURATION_JSON === sourceRaw &&
        currentEnv().PEGMA_KNOWLEDGE_ENABLED === 'true'
      );
    } catch {
      return false;
    }
  };
  try {
    const version = profile.revision + ':' + (await knowledgeDigest(profile));
    if (!current()) return undefined;
    const checkCounter = counter(profile.checks.qualification);
    const readApiKey = (reference: string) =>
      current() && reference === SUPPORT_ASSISTANT_CREDENTIAL_REF
        ? currentEnv().SUPPORT_ASSISTANT_OPENROUTER_API_KEY
        : undefined;
    const policyModel = createCheckModel({
      clock,
      enabled: current,
      readRoute: () => (current() ? profile.checks.route : undefined),
      allowlist: allowed,
      counter: checkCounter,
    });
    const reviewPolicy: LearningCheckPolicyPort = {
      async resolvePolicy(expected, signal) {
        const resolved = await policyModel.resolve(undefined, signal);
        return current() &&
          resolved &&
          (expected === undefined || expected === resolved.policy.version)
          ? { outcome: 'ready', policy: resolved.policy }
          : { outcome: 'unavailable' };
      },
    };
    const source = createSupportLearningBootstrap(env, {
      clock,
      currentEnv,
      isSelected: current,
      reviewPolicy,
    });
    if (!source || source.configuration.revision !== profile.sourceRevision) return undefined;
    if (
      profile.learning &&
      !source.configuration.collectionIds.includes(profile.learning.target.collectionId)
    )
      return undefined;
    const checkedPolicy = await policyModel.resolve(undefined, new AbortController().signal);
    const checkRoute = profile.checks.route;
    const checkPool = profile.checks.usagePolicy;
    if (
      !checkedPolicy ||
      checkRoute.usageScopeRef !== checkPool.scopeRef ||
      checkedPolicy.configuration.version !== checkPool.configurationVersion ||
      checkedPolicy.configuration.modelVersion !== checkPool.modelVersion ||
      checkedPolicy.configuration.pricingRef !== checkPool.pricingRef ||
      checkedPolicy.configuration.budgets.maxCostMicros > checkPool.maxReservationCostMicros ||
      !live({ verifiedAt: checkPool.validFrom, validUntil: checkPool.validUntil }, clock)
    )
      return Object.freeze({
        profile,
        current,
        learning: source.learning,
        engineeringProduction: {} as SupportEngineeringProductionOptions,
        engineering: {} as SupportEngineeringHumanComposition,
      });
    const receipt = profile.checks.receiptKey;
    const keyProvider =
      options.keyProvider ??
      createSupportReceiptKeyProvider(env, receipt, current, clock, currentEnv);
    let receiptKey: IndependentCheckReceiptKey | null = null;
    const checksFlag = () =>
      current() && currentEnv().PEGMA_SUPPORT_INDEPENDENT_CHECKS_ENABLED === 'true';
    if (checksFlag()) {
      try {
        receiptKey = await keyProvider.resolve(receipt.reference, new AbortController().signal);
      } catch {
        receiptKey = null;
      }
    }
    const currentKey = () => {
      try {
        return current() &&
          receiptKey &&
          receiptKey.id === receipt.id &&
          receiptKey.validUntil === receipt.validUntil &&
          live(receiptKey, clock) &&
          receiptKey.key.type === 'secret' &&
          receiptKey.key.algorithm.name === 'HMAC' &&
          'hash' in receiptKey.key.algorithm &&
          (receiptKey.key.algorithm.hash as KeyAlgorithm).name === 'SHA-256' &&
          receiptKey.key.usages.includes('sign') &&
          receiptKey.key.usages.includes('verify') &&
          keyProvider.current(receiptKey)
          ? receiptKey
          : null;
      } catch {
        return null;
      }
    };
    const paid = () =>
      checksFlag() &&
      checkRoute.credentialRef === SUPPORT_ASSISTANT_CREDENTIAL_REF &&
      currentKey() !== null;
    const intrinsic = (scope: string, gate: () => boolean) =>
      createSupportBackgroundServiceAccess({
        readProfile: (_kind, signal) =>
          current() && gate() && !signal.aborted
            ? { enabled: true, version, usageScopeRef: scope }
            : { enabled: false },
      });
    const checkerAuthority = intrinsic(profile.checks.usagePolicy.scopeRef, current);
    const independentChecks = {
      clock,
      enabled: paid,
      authority: checkerAuthority.learning.serviceAccess,
      readRoute: () => (current() ? profile.checks.route : undefined),
      allowlist: allowed,
      counter: checkCounter,
      readApiKey,
      fetch: options.fetch,
      usagePolicy: profile.checks.usagePolicy,
      readReceiptKey: currentKey,
    };
    const engineeringChecks = {
      ...independentChecks,
      authority: checkerAuthority.engineering.serviceAccess,
    };
    let learning: SupportLearningRootComposition = {
      ...source.learning,
      independentChecks,
      engineeringIndependentChecks: engineeringChecks,
      deliveryMode: 'staged',
    };
    if (profile.learning) {
      const selected = profile.learning;
      const enabled = () =>
        paid() &&
        selected.route.credentialRef === SUPPORT_ASSISTANT_CREDENTIAL_REF &&
        currentEnv().PEGMA_SUPPORT_LEARNING_WORKER_ENABLED === 'true';
      const generationAuthority = intrinsic(selected.usagePolicy.scopeRef, current);
      const model = {
        readRoute: () => (current() ? selected.route : undefined),
        allowlist: allowed,
        counter: counter(selected.qualification),
        readApiKey,
        fetch: options.fetch,
      };
      const validation = createSupportLearningModelPorts({ ...model, clock, enabled: current });
      if (
        !enabled() ||
        (await validation.configuration.resolve(undefined, new AbortController().signal))
          .outcome === 'ready'
      ) {
        learning = {
          ...learning,
          production: {
            enabled,
            configuration: {
              ...source.learning.source!,
              serviceAccess: generationAuthority.learning.serviceAccess,
              productContext: source.learning.intake!.productContext!,
              targets: targets(selected, source.configuration.product, current),
              model,
              usagePolicy: selected.usagePolicy,
            },
          },
        };
      }
    }
    let engineeringProduction: SupportEngineeringProductionOptions = {};
    let engineering: SupportEngineeringHumanComposition = {};
    if (profile.engineering) {
      const selected = profile.engineering;
      const repositories = selected.repositories;
      for (const item of repositories) {
        if (
          ['repositoryId', 'owner', 'name', 'visibility'].some(
            (key) =>
              item.repository[key as keyof typeof item.repository] !==
              item.descriptor[key as keyof typeof item.descriptor],
          )
        )
          throw new TypeError(
            'Repository descriptor does not match its immutable connector identity',
          );
      }
      const enabled = () =>
        paid() &&
        selected.route.credentialRef === SUPPORT_ASSISTANT_CREDENTIAL_REF &&
        currentEnv().PEGMA_SUPPORT_ENGINEERING_PROCESSING_ENABLED === 'true';
      const repositoryEnabled = () =>
        current() && currentEnv().PEGMA_SUPPORT_ENGINEERING_REPOSITORY_ENABLED === 'true';
      const authority = intrinsic(selected.usagePolicy.scopeRef, repositoryEnabled);
      const productContext = {
        async resolve(
          context: import('@pegma/support-desk-application').EngineeringTrustContext,
          signal: AbortSignal,
        ) {
          return source.resolveProduct(context, signal);
        },
      };
      const routing: NonNullable<
        NonNullable<SupportEngineeringProductionOptions['configuration']>['routing']
      > = {
        async resolve(signal) {
          return current() && !signal.aborted && live(selected.routing.calibration, clock)
            ? { outcome: 'ready', calibration: selected.routing.calibration }
            : { outcome: 'unavailable' };
        },
        async check(input, context) {
          if (!current() || context.signal.aborted) return { outcome: 'unavailable' };
          const entry = selected.routing.decisions.find(
            (item) =>
              canonical(item.proof.binding) === canonical(input.binding) && live(item.proof, clock),
          );
          return entry?.proof.outcome === 'accepted'
            ? { outcome: 'checked', receipt: entry.receipt }
            : entry?.proof.outcome === 'restricted'
              ? { outcome: 'restricted' }
              : { outcome: 'human_required' };
        },
        async verify(value, binding) {
          return current()
            ? (selected.routing.decisions.find(
                (item) =>
                  item.receipt === value &&
                  canonical(item.proof.binding) === canonical(binding) &&
                  live(item.proof, clock),
              )?.proof ?? null)
            : null;
        },
      };
      // Validate descriptors with the public codec; this synthetic envelope is
      // validation only and is never stored or claimed to be an authorized head.
      engineeringPolicyRecords.codec.decode({
        partition: 'instance',
        id: 'policy',
        json: JSON.stringify({
          kind: 'engineering_policy',
          partition: 'instance',
          id: 'policy',
          generation: 1,
          policyHash: '0'.repeat(64),
          policy: { enabled: true, repositories: repositories.map((item) => item.descriptor) },
        }),
      });
      const model = {
        readRoute: () => (current() ? selected.route : undefined),
        allowlist: allowed,
        counter: counter(selected.qualification),
        readApiKey,
        fetch: options.fetch,
      };
      const validation = createSupportEngineeringModelPorts({
        ...model,
        clock,
        isEnabled: current,
      });
      if (
        !enabled() ||
        (await validation.configuration.resolve(undefined, new AbortController().signal))
          .outcome === 'ready'
      ) {
        engineeringProduction = {
          clock,
          enabled,
          configuration: {
            application: { enabled: selected.intakeEnabled },
            productContext,
            serviceAccess: intrinsic(selected.usagePolicy.scopeRef, current).engineering
              .serviceAccess,
            reconciliationAccess: authority.engineering.reconciliationAccess,
            routing,
            model,
            usagePolicy: selected.usagePolicy,
            independentChecks: engineeringChecks,
            repository: {
              enabled: repositoryEnabled,
              issueCreationEnabled: () =>
                repositoryEnabled() &&
                currentEnv().PEGMA_SUPPORT_ENGINEERING_ISSUE_WRITE_ENABLED === 'true',
              repositories: repositories.map((item) => item.repository),
              fetch: options.fetch,
              authentication: {
                async resolve(repository, signal) {
                  const item = repositories.find(
                    (entry) => entry.repository.repositoryId === repository.repositoryId,
                  );
                  if (
                    !item ||
                    signal.aborted ||
                    !repositoryEnabled() ||
                    !live(item.authentication, clock)
                  )
                    return null;
                  const liveEnv = currentEnv();
                  const appJwt = liveEnv.SUPPORT_ENGINEERING_APP_JWT,
                    installationToken = liveEnv.SUPPORT_ENGINEERING_INSTALLATION_TOKEN;
                  if (typeof appJwt !== 'string' || typeof installationToken !== 'string')
                    return null;
                  return {
                    active: true,
                    binding: item.authentication.binding,
                    version: item.authentication.version,
                    validUntil: item.authentication.validUntil,
                    appId: repository.appId,
                    installationId: repository.installationId,
                    appJwt,
                    installationToken,
                  };
                },
              },
            },
            proposals: {
              readDuplicateQuery: (descriptor) =>
                current()
                  ? (repositories.find(
                      (item) => item.repository.repositoryId === descriptor.repositoryId,
                    )?.duplicateQuery ?? null)
                  : null,
              readSettings: (input) =>
                current()
                  ? (repositories.find(
                      (item) => item.repository.repositoryId === input.repository.repositoryId,
                    )?.settings ?? null)
                  : null,
            },
          },
        };
        engineering = {
          enabled: () => current() && selected.intakeEnabled,
          reviewEnabled: () => current() && selected.reviewEnabled,
          configuration: {
            application: { enabled: selected.intakeEnabled },
            repositories: repositories.map((item) => ({
              key: item.key,
              descriptor: item.descriptor,
            })),
          },
        };
      }
    }
    if (!current()) return undefined;
    return Object.freeze({
      profile,
      current,
      learning: Object.freeze(learning),
      engineeringProduction,
      engineering,
    });
  } catch {
    return undefined;
  }
}
