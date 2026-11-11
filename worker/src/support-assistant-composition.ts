import { hasPermission, resolveAccess, type AccessContext } from '@pegma/authorization-core';
import { knowledgePermissions } from '@pegma/knowledge-base-contracts';
import type { PolicyDocumentV1 } from '@pegma/authorization-policy';
import type { PrivateSourcesVerifier } from '@pegma/knowledge-base-application';
import { supportPermissions, type AssistantTurnOptions } from '@pegma/support-desk-application';
import type { Logger } from '@pegma/spine';
import type { SupportRuntime } from './support-desk';
import { createKnowledgeRuntime } from './knowledge-runtime';
import {
  createSupportAssistantCustomerAuthority,
  createSupportAssistantRuntime,
  type SupportAssistantOptions,
} from './support-assistant';
import {
  createSupportAssistantConfiguration,
  type SupportAssistantConfigurationOptions,
} from './support-assistant-config';
import {
  createSupportAssistantOpenRouterModel,
  type SupportAssistantOpenRouterModelOptions,
} from './support-assistant-model';
import {
  createSupportAssistantUsage,
  type SupportAssistantUsagePolicy,
} from './support-assistant-usage';

export const SUPPORT_ANSWERING_DISCLOSURE_VERSION = 'pegma-support-answering-1';

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const data = value as Record<string, unknown>;
  return (
    '{' +
    Object.keys(data)
      .sort()
      .map((key) => JSON.stringify(key) + ':' + canonical(data[key]))
      .join(',') +
    '}'
  );
}

/** Trusted source configuration only. No browser or environment JSON supplies these ports. */
export interface SupportAnsweringComposition {
  readonly enabled?: () => boolean;
  /** Independent fresh-intake switch; scheduled processing does not imply consent. */
  readonly customerAdmissionEnabled?: () => boolean;
  /** Installed receipt recovery needs no current model configuration or credential. */
  readonly recoveryOnly?: boolean;
  readonly configuration?: {
    readonly disclosureVersion: typeof SUPPORT_ANSWERING_DISCLOSURE_VERSION;
    readonly turns: AssistantTurnOptions;
    readonly route: Omit<SupportAssistantConfigurationOptions, 'clock' | 'isEnabled'>;
    readonly readApiKey: SupportAssistantOpenRouterModelOptions['readApiKey'];
    readonly fetch?: SupportAssistantOpenRouterModelOptions['fetch'];
    readonly usagePolicy: SupportAssistantUsagePolicy;
    readonly customerPolicy: PolicyDocumentV1;
    readonly selectAudience: NonNullable<SupportAssistantOptions['selectAudience']>;
    readonly privateSources?: PrivateSourcesVerifier;
  };
}

export function supportAnsweringEnabled(options: SupportAnsweringComposition = {}): boolean {
  try {
    const attempts = options.configuration?.turns.maxAttempts;
    return (
      typeof attempts === 'number' &&
      Number.isSafeInteger(attempts) &&
      attempts >= 2 &&
      options.enabled?.() === true
    );
  } catch {
    return false;
  }
}

export function supportAnsweringAdmissionEnabled(
  options: SupportAnsweringComposition = {},
): boolean {
  try {
    return supportAnsweringEnabled(options) && options.customerAdmissionEnabled?.() === true;
  } catch {
    return false;
  }
}

/** Preserve the actual application cap, including a later reduction. A reduced
 * cap disables fresh staged intake without preventing accepted receipt replay. */
export function supportAnsweringTurns(options: SupportAnsweringComposition = {}) {
  const value = options.configuration?.turns;
  if (value === undefined) return undefined;
  return { ...value };
}

/** Same real Store/Identity/RoleStore and Support application as ordinary human routes. */
export function composeSupportAnswering(
  runtime: SupportRuntime,
  logger: Logger,
  options: SupportAnsweringComposition,
  environmentEnabled: () => boolean,
) {
  const supplied = options.configuration;
  if (supplied === undefined) {
    if (options.recoveryOnly !== true) throw new TypeError('Answering is not configured.');
    return Object.freeze({
      enabled: () => false,
      admissionEnabled: () => false,
      disclosureVersion: SUPPORT_ANSWERING_DISCLOSURE_VERSION,
      admission: async (_principalId: string) => null,
      runTick: async () => ({ outcome: 'disabled' as const, checkpointSaved: false as const }),
    });
  }
  const enabled = () =>
    options.configuration === supplied && environmentEnabled() && supportAnsweringEnabled(options);
  const admissionEnabled = () => enabled() && supportAnsweringAdmissionEnabled(options);
  const bundle = createSupportAssistantConfiguration({
    ...supplied.route,
    clock: runtime.clock,
    isEnabled: enabled,
  });
  const usage = createSupportAssistantUsage({
    store: runtime.store,
    clock: runtime.clock,
    policy: supplied.usagePolicy,
  });
  const authority = {
    identity: runtime.identity,
    identityLinkFromClaims: runtime.identityLinkFromClaims,
    roleStore: runtime.roleStore,
    customerPolicy: supplied.customerPolicy,
    selectAudience: supplied.selectAudience,
    isEnabled: enabled,
  };
  const customer = createSupportAssistantCustomerAuthority(authority);

  async function admission(principalId: string) {
    if (
      !admissionEnabled() ||
      supplied === undefined ||
      supplied.disclosureVersion !== SUPPORT_ANSWERING_DISCLOSURE_VERSION
    )
      return null;
    const resolved = await bundle.configuration.resolve();
    if (resolved.outcome !== 'ready' || resolved.configuration.budgets.maxAttempts < 2) return null;
    const route = bundle.currentRoute(resolved.configuration.version);
    const pool = supplied.usagePolicy;
    const now = Date.parse(runtime.clock.now());
    if (
      !route ||
      pool.scopeRef !== route.usageScopeRef ||
      pool.configurationVersion !== resolved.configuration.version ||
      pool.modelVersion !== resolved.configuration.modelVersion ||
      pool.pricingRef !== resolved.configuration.pricingRef ||
      pool.currency !== resolved.configuration.budgets.currency ||
      !(Date.parse(pool.validFrom) <= now && now < Date.parse(pool.validUntil))
    )
      return null;
    const current = await customer.resolve(principalId);
    if (
      current.outcome !== 'ready' ||
      current.authority.usageScopeRef !== route.usageScopeRef ||
      !hasPermission(current.authority.access, supportPermissions.create) ||
      !hasPermission(current.authority.access, supportPermissions.assistantStart) ||
      !admissionEnabled()
    )
      return null;
    const binding = JSON.stringify({ route, authority: current.authority, pool });
    const policy = JSON.stringify(supplied.customerPolicy);
    const poolText = JSON.stringify(pool);
    return {
      access: current.authority.access,
      binding,
      assertCurrent(browserAccess: AccessContext) {
        const latest = bundle.currentRoute(resolved.configuration.version);
        const at = Date.parse(runtime.clock.now());
        // Re-project the roles just read by the original browser fence. This
        // closes a role/mapping change during its awaits without another read
        // or inventing grants from a previous customer observation.
        const projected = resolveAccess(
          { principalId: browserAccess.principalId, roles: browserAccess.roles },
          supplied.customerPolicy,
        );
        const selected = supplied.selectAudience(projected);
        const latestAuthority =
          selected === null
            ? null
            : { ...selected, access: projected, policyVersion: projected.policyVersion };
        if (
          !admissionEnabled() ||
          !latest ||
          JSON.stringify(latest) !== JSON.stringify(route) ||
          JSON.stringify(supplied.customerPolicy) !== policy ||
          JSON.stringify(supplied.usagePolicy) !== poolText ||
          !hasPermission(projected, knowledgePermissions.botRead) ||
          !hasPermission(projected, knowledgePermissions.articleRead) ||
          !hasPermission(projected, supportPermissions.assistantStart) ||
          canonical(latestAuthority) !== canonical(current.authority) ||
          !(Date.parse(pool.validFrom) <= at && at < Date.parse(pool.validUntil))
        )
          throw new Error('Answering admission changed.');
        return true as const;
      },
    };
  }

  return Object.freeze({
    enabled,
    admissionEnabled,
    disclosureVersion: supplied.disclosureVersion,
    admission,
    async runTick() {
      if (!enabled()) return { outcome: 'disabled' as const, checkpointSaved: false as const };
      // This direct KB instance uses the same published evidence verifier and
      // current source gates as the browser composition, with the qualified counter.
      const knowledge = createKnowledgeRuntime({
        ...authority,
        store: runtime.store,
        clock: runtime.clock,
        sessions: runtime.sessions,
        logger,
        agentAccess: null,
        isEnabled: enabled,
        retrieval: { tokenCounter: bundle.tokenCounter },
        ...(supplied.privateSources === undefined
          ? {}
          : { privateSources: supplied.privateSources }),
      }).application;
      return createSupportAssistantRuntime({
        ...authority,
        store: runtime.store,
        clock: runtime.clock,
        application: runtime.application,
        knowledge,
        configuration: bundle.configuration,
        tokenCounter: bundle.tokenCounter,
        usage,
        model: createSupportAssistantOpenRouterModel({
          clock: runtime.clock,
          configuration: bundle,
          readApiKey: supplied.readApiKey,
          ...(supplied.fetch === undefined ? {} : { fetch: supplied.fetch }),
        }),
      }).runTick();
    },
  });
}

export type SupportAnsweringRuntime = ReturnType<typeof composeSupportAnswering>;
