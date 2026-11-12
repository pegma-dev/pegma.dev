import { systemClock, type Clock } from '@pegma/spine';
import { knowledgePermissions } from '@pegma/knowledge-base-contracts';
import { supportPermissions } from '@pegma/support-desk-application';
import type { SupportAssistantUsagePolicy } from './support-assistant-usage';
import {
  createSupportAssistantConfiguration,
  SUPPORT_ASSISTANT_ENDPOINT,
  SUPPORT_ASSISTANT_WIRE_VERSION,
  type ApprovedSupportAssistantRoute,
  type QualifiedSupportAssistantCounter,
} from './support-assistant-config';
import {
  SUPPORT_ANSWERING_DISCLOSURE_VERSION,
  type SupportAnsweringComposition,
} from './support-assistant-composition';
import { PEGMA_ACCESS_POLICY } from './support-access';

/** Environment JSON supplies bounded data only. All executable ports, provider
 * identities, credential routing and qualification audience rules live here. */
export interface SupportAssistantProductionEnvironment {
  readonly PEGMA_SUPPORT_ASSISTANT_ENABLED?: string;
  readonly PEGMA_SUPPORT_ASSISTANT_CUSTOMER_ADMISSION_ENABLED?: string;
  readonly PEGMA_SUPPORT_ASSISTANT_CONFIGURATION_JSON?: string;
  readonly SUPPORT_ASSISTANT_OPENROUTER_API_KEY?: string;
}

/** Reviewable operator data. References identify retained qualification; they
 * are neither credentials nor a mechanism for minting new approvals. */
export interface SupportAssistantProductionConfiguration {
  readonly version: 1;
  readonly route: ApprovedSupportAssistantRoute;
  readonly usagePolicy: SupportAssistantUsagePolicy;
  readonly audience: {
    readonly principalId: string;
    readonly collectionId: string;
    readonly audienceVersion: string;
    readonly applicability: {
      readonly productId: 'fictional-workspace';
      readonly productVersion: string;
      readonly buildId: string;
    };
  };
  readonly tokenizer: QualifiedSupportAssistantCounter['qualification'];
}

export const SUPPORT_ASSISTANT_CREDENTIAL_REF =
  'pegma-support-answering-openrouter';
export const SUPPORT_ASSISTANT_SYNTHETIC_ROLE = 'SupportAnsweringSynthetic';
const MODEL = 'openai/gpt-4.1-mini';
const PROVIDER = 'Azure';
const ENDPOINT_TAG = 'azure/swedencentral';
const FRAMING = 1024;
const WEEK = 7 * 24 * 60 * 60_000;
const recovery: SupportAnsweringComposition = Object.freeze({
  recoveryOnly: true,
});

function object(
  value: unknown,
  names: readonly string[],
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError();
  const result = value as Record<string, unknown>;
  if (
    Object.keys(result).length !== names.length ||
    names.some((name) => !Object.hasOwn(result, name))
  )
    throw new TypeError();
  return result;
}
function text(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 200 ||
    /[\u0000-\u001F\u007F]/u.test(value)
  )
    throw new TypeError();
  return value;
}
function integer(value: unknown, maximum: number): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > maximum
  )
    throw new TypeError();
  return value;
}
function instant(value: unknown): string {
  const result = text(value);
  if (
    !Number.isFinite(Date.parse(result)) ||
    new Date(result).toISOString() !== result
  )
    throw new TypeError();
  return result;
}
function fictional(value: unknown): string {
  const result = text(value);
  if (!/^fictional-[a-z0-9-]{1,100}$/u.test(result)) throw new TypeError();
  return result;
}
function pool(value: unknown): SupportAssistantUsagePolicy {
  const data = object(value, [
    'version',
    'scopeRef',
    'configurationVersion',
    'modelVersion',
    'pricingRef',
    'currency',
    'maxCostMicros',
    'maxReservationCostMicros',
    'maxReservations',
    'validFrom',
    'validUntil',
    'terminalRetentionMilliseconds',
  ]);
  const validFrom = instant(data.validFrom);
  const validUntil = instant(data.validUntil);
  if (
    Date.parse(validUntil) <= Date.parse(validFrom) ||
    Date.parse(validUntil) - Date.parse(validFrom) > WEEK ||
    data.currency !== 'USD'
  )
    throw new TypeError();
  const maxCostMicros = integer(data.maxCostMicros, 1_000_000);
  return Object.freeze({
    version: text(data.version),
    scopeRef: text(data.scopeRef),
    configurationVersion: text(data.configurationVersion),
    modelVersion: text(data.modelVersion),
    pricingRef: text(data.pricingRef),
    currency: 'USD',
    maxCostMicros,
    maxReservationCostMicros: integer(
      data.maxReservationCostMicros,
      maxCostMicros,
    ),
    maxReservations: integer(data.maxReservations, 32),
    validFrom,
    validUntil,
    terminalRetentionMilliseconds: integer(
      data.terminalRetentionMilliseconds,
      31 * 24 * 60 * 60_000,
    ),
  });
}

/** A fresh bundle per invocation over stable operator snapshots. This function
 * performs no Store or provider operation and never invents verification dates.
 * Invalid/off configuration retains only original browser/SDK receipt recovery. */
export async function createProductionSupportAnswering(
  environment: SupportAssistantProductionEnvironment,
  clock: Clock = systemClock,
): Promise<SupportAnsweringComposition> {
  try {
    const raw = environment.PEGMA_SUPPORT_ASSISTANT_CONFIGURATION_JSON;
    if (
      environment.PEGMA_SUPPORT_ASSISTANT_ENABLED !== 'true' ||
      typeof raw !== 'string' ||
      raw.length > 65_536 ||
      raw.length === 0
    )
      return recovery;
    const data = object(JSON.parse(raw), [
      'version',
      'route',
      'usagePolicy',
      'audience',
      'tokenizer',
    ]);
    if (data.version !== 1) return recovery;
    const audience = object(data.audience, [
      'principalId',
      'collectionId',
      'audienceVersion',
      'applicability',
    ]);
    const principalId = fictional(audience.principalId);
    const collectionId = fictional(audience.collectionId);
    const audienceVersion = text(audience.audienceVersion);
    const applies = object(audience.applicability, [
      'productId',
      'productVersion',
      'buildId',
    ]);
    if (applies.productId !== 'fictional-workspace') return recovery;
    const applicability = Object.freeze({
      productId: 'fictional-workspace',
      productVersion: text(applies.productVersion),
      buildId: fictional(applies.buildId),
    });
    const usagePolicy = pool(data.usagePolicy);
    const info = object(data.tokenizer, [
      'model',
      'modelVersion',
      'wireVersion',
      'framingTokens',
      'evidenceRef',
      'verifiedAt',
      'validUntil',
    ]);
    if (
      info.model !== MODEL ||
      info.wireVersion !== SUPPORT_ASSISTANT_WIRE_VERSION ||
      info.framingTokens !== FRAMING
    )
      return recovery;
    const qualification: QualifiedSupportAssistantCounter['qualification'] = {
      model: MODEL,
      modelVersion: text(info.modelVersion),
      wireVersion: SUPPORT_ASSISTANT_WIRE_VERSION,
      framingTokens: FRAMING,
      evidenceRef: text(info.evidenceRef),
      verifiedAt: instant(info.verifiedAt),
      validUntil: instant(info.validUntil),
    };
    const enabled = () =>
      environment.PEGMA_SUPPORT_ASSISTANT_ENABLED === 'true' &&
      environment.PEGMA_SUPPORT_ASSISTANT_CONFIGURATION_JSON === raw &&
      Date.parse(usagePolicy.validFrom) <= Date.parse(clock.now()) &&
      Date.parse(clock.now()) < Date.parse(usagePolicy.validUntil);
    const { createSupportAssistantTokenCounter } =
      await import('./support-assistant-token-counter');
    const counter = createSupportAssistantTokenCounter(qualification);
    const routeOptions = {
      counter,
      allowlist: [
        Object.freeze({
          model: MODEL,
          provider: PROVIDER,
          endpointTag: ENDPOINT_TAG,
          outputTokenParameter: 'max_tokens' as const,
        }),
      ],
      readRoute: () =>
        environment.PEGMA_SUPPORT_ASSISTANT_CONFIGURATION_JSON === raw
          ? data.route
          : undefined,
    };
    const checked = createSupportAssistantConfiguration({
      ...routeOptions,
      clock,
      isEnabled: enabled,
    });
    const result = await checked.configuration.resolve();
    const route = checked.currentRoute();
    if (
      result.outcome !== 'ready' ||
      route === undefined ||
      route.credentialRef !== SUPPORT_ASSISTANT_CREDENTIAL_REF ||
      route.endpoint !== SUPPORT_ASSISTANT_ENDPOINT ||
      route.configuration.framingTokens !== FRAMING ||
      route.configuration.budgets.maxAttempts !== 2 ||
      route.configuration.budgets.maxInputTokens > 4096 ||
      route.configuration.budgets.maxOutputTokens > 512 ||
      route.configuration.budgets.maxCostMicros > 2704 ||
      usagePolicy.scopeRef !== route.usageScopeRef ||
      usagePolicy.configurationVersion !== route.configuration.version ||
      usagePolicy.modelVersion !== route.configuration.modelVersion ||
      usagePolicy.pricingRef !== route.configuration.pricingRef ||
      route.configuration.budgets.maxCostMicros < 1 ||
      route.configuration.budgets.maxCostMicros >
        usagePolicy.maxReservationCostMicros
    )
      return recovery;
    // JSON values are private to this factory; returning an independent
    // snapshot prevents callers of readRoute from mutating its next observation.
    routeOptions.readRoute = () =>
      environment.PEGMA_SUPPORT_ASSISTANT_CONFIGURATION_JSON === raw
        ? structuredClone(route)
        : undefined;
    const composition: SupportAnsweringComposition = {
      recoveryOnly: true,
      enabled: () => enabled() && checked.currentRoute() !== undefined,
      customerAdmissionEnabled: () =>
        environment.PEGMA_SUPPORT_ASSISTANT_CUSTOMER_ADMISSION_ENABLED ===
        'true',
      configuration: {
        disclosureVersion: SUPPORT_ANSWERING_DISCLOSURE_VERSION,
        turns: Object.freeze({ maxAttempts: 2 }),
        route: routeOptions,
        usagePolicy,
        readApiKey: (reference: string) =>
          reference === SUPPORT_ASSISTANT_CREDENTIAL_REF
            ? environment.SUPPORT_ASSISTANT_OPENROUTER_API_KEY
            : undefined,
        customerPolicy: Object.freeze({
          ...PEGMA_ACCESS_POLICY,
          version: 'pegma.dev-synthetic-answering-1',
          roles: Object.freeze({
            ...PEGMA_ACCESS_POLICY.roles,
            [SUPPORT_ASSISTANT_SYNTHETIC_ROLE]: [
              knowledgePermissions.botRead,
              supportPermissions.assistantStart,
            ],
          }),
        }),
        selectAudience: (access) =>
          access.principalId === principalId &&
          access.roles.includes(SUPPORT_ASSISTANT_SYNTHETIC_ROLE)
            ? {
                audienceVersion,
                usageScopeRef: usagePolicy.scopeRef,
                collectionIds: [collectionId],
                applicability,
              }
            : null,
      },
    };
    return Object.freeze(composition);
  } catch {
    return recovery;
  }
}
