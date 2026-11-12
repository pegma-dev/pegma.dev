import type {
  EngineeringConfigurationPort,
  EngineeringTokenCounter,
  VerifiedEngineeringConfiguration,
} from '@pegma/support-desk-ai';
import type { Clock } from '@pegma/spine';

export const SUPPORT_ENGINEERING_WIRE_VERSION =
  'openrouter-support-engineering-v1';
export const SUPPORT_ENGINEERING_ENDPOINT =
  'https://openrouter.ai/api/v1/chat/completions';

export interface SupportEngineeringAllowedRoute {
  readonly model: string;
  /** Exact response provider identity, independently qualified for this route. */
  readonly provider: string;
  /** Complete endpoint tag; a broad provider slug is not an endpoint lock. */
  readonly endpointTag: string;
  readonly outputTokenParameter: 'max_tokens' | 'max_completion_tokens';
}

export interface QualifiedSupportEngineeringCounter extends EngineeringTokenCounter {
  readonly qualification: {
    readonly model: string;
    readonly modelVersion: string;
    readonly wireVersion: typeof SUPPORT_ENGINEERING_WIRE_VERSION;
    /** Includes the fixed system text, schema and complete chat framing. */
    readonly framingTokens: number;
    readonly evidenceRef: string;
    readonly verifiedAt: string;
    readonly validUntil: string;
  };
}

/** Trusted operator assertions, not settings inferred from public metadata. */
export interface ApprovedSupportEngineeringRoute {
  readonly host: 'pegma.dev';
  readonly purpose: 'support_bug_assessment';
  readonly endpoint: typeof SUPPORT_ENGINEERING_ENDPOINT;
  readonly endpointTag: string;
  readonly outputTokenParameter: 'max_tokens' | 'max_completion_tokens';
  readonly credentialRef: string;
  readonly usageScopeRef: string;
  readonly configuration: VerifiedEngineeringConfiguration;
  readonly approval: {
    readonly configurationVersion: string;
    readonly wireVersion: typeof SUPPORT_ENGINEERING_WIRE_VERSION;
    readonly evidenceRef: string;
    readonly effectivePolicyRef: string;
    readonly evaluationRef: string;
    readonly responseIdentityRef: string;
    readonly tokenizerRef: string;
    readonly requestPolicySha256: string;
    readonly nativeCostCurrency: 'USD';
    readonly nativeCostUnit: 'openrouter_credits_usd';
    readonly rounding: 'ceil_micro';
    readonly zdr: true;
    readonly safetyRetention: false;
    readonly inputOutputLogging: false;
    readonly inputOutputUse: false;
    readonly broadcast: false;
    readonly responseCache: false;
    readonly unreviewedFeatures: false;
    /** Upstream implicit prompt caching requires its own accepted treatment. */
    readonly implicitCache: 'absent' | 'approved';
    readonly verifiedAt: string;
    readonly validUntil: string;
  };
}

export interface SupportEngineeringConfigurationOptions {
  readonly clock: Clock;
  readonly isEnabled?: () => boolean;
  /** Synchronous local trusted configuration. Never a request body or lookup. */
  readonly readRoute?: () => unknown;
  /** Empty by default; advertised candidates are not approved entries. */
  readonly allowlist?: readonly SupportEngineeringAllowedRoute[];
  readonly counter?: QualifiedSupportEngineeringCounter;
}

export interface SupportEngineeringConfiguration {
  readonly configuration: EngineeringConfigurationPort;
  readonly tokenCounter: EngineeringTokenCounter;
  /** Private host composition capability; never serialize it to a provider. */
  currentRoute(
    expectedVersion?: string,
  ): ApprovedSupportEngineeringRoute | undefined;
}

const BAD_SCALAR = /[\u0000-\u001F\u007F]/u;
const BAD_TEXT = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u;

function canonicalData(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value))
    return '[' + value.map(canonicalData).join(',') + ']';
  const data = value as Record<string, unknown>;
  return (
    '{' +
    Object.keys(data)
      .sort()
      .map((key) => JSON.stringify(key) + ':' + canonicalData(data[key]))
      .join(',') +
    '}'
  );
}

function policyText(
  route: Omit<ApprovedSupportEngineeringRoute, 'approval'>,
): string {
  return canonicalData({
    wireVersion: SUPPORT_ENGINEERING_WIRE_VERSION,
    host: route.host,
    purpose: route.purpose,
    endpoint: route.endpoint,
    endpointTag: route.endpointTag,
    outputTokenParameter: route.outputTokenParameter,
    credentialRef: route.credentialRef,
    usageScopeRef: route.usageScopeRef,
    configuration: route.configuration,
  });
}

/** Computes a binding, not an approval; no network or credential access. */
export async function supportEngineeringRoutePolicySha256(
  route: Omit<ApprovedSupportEngineeringRoute, 'approval'>,
): Promise<string> {
  const text = policyText(route);
  if (text.length > 65_536) throw new TypeError('Unbounded route policy');
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

function record(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Object.getOwnPropertySymbols(value).length !== 0
  )
    throw new TypeError('Invalid support engineering configuration');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Object.keys(descriptors).length !== keys.length ||
    keys.some((key) => !descriptors[key] || !('value' in descriptors[key]))
  )
    throw new TypeError('Invalid support engineering configuration');
  return value as Record<string, unknown>;
}

function scalar(value: unknown, maximum = 200): string {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.length > maximum ||
    BAD_SCALAR.test(value)
  )
    throw new TypeError('Invalid support engineering configuration');
  return value;
}

function integer(value: unknown, maximum: number, minimum = 0): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  )
    throw new TypeError('Invalid support engineering configuration');
  return value;
}

function instant(value: unknown): number {
  const text = scalar(value, 40);
  const result = Date.parse(text);
  if (!Number.isFinite(result) || new Date(result).toISOString() !== text)
    throw new TypeError('Invalid support engineering configuration');
  return result;
}

function validInterval(value: Record<string, unknown>, now: number): void {
  if (instant(value.verifiedAt) > now || instant(value.validUntil) <= now)
    throw new TypeError('Invalid support engineering configuration');
}

function checkedConfiguration(
  raw: unknown,
  now: number,
): VerifiedEngineeringConfiguration {
  const config = record(raw, [
    'purpose',
    'version',
    'promptVersion',
    'modelVersion',
    'parserVersion',
    'provider',
    'model',
    'pricingRef',
    'trustedInstructions',
    'framingTokens',
    'budgets',
    'dataControls',
  ]);
  if (config.purpose !== 'support_bug_assessment')
    throw new TypeError('Invalid support engineering purpose');
  for (const key of [
    'version',
    'promptVersion',
    'modelVersion',
    'parserVersion',
    'provider',
    'model',
    'pricingRef',
  ])
    scalar(config[key]);
  if (
    typeof config.trustedInstructions !== 'string' ||
    config.trustedInstructions.trim().length === 0 ||
    config.trustedInstructions.length > 16_384 ||
    BAD_TEXT.test(config.trustedInstructions)
  )
    throw new TypeError('Invalid support engineering configuration');
  const framingTokens = integer(config.framingTokens, 8_192);
  const budget = record(config.budgets, [
    'maxMessages',
    'maxInputBytes',
    'maxInputTokens',
    'maxContextTokens',
    'maxOutputBytes',
    'maxOutputTokens',
    'maxCandidateBytes',
    'maxDurationMilliseconds',
    'maxCostMicros',
    'currency',
    'maxAttempts',
    'maxRepositories',
    'maxRepositoryBytes',
  ]);
  for (const [key, maximum] of [
    ['maxMessages', 100],
    ['maxInputBytes', 262_144],
    ['maxInputTokens', 65_536],
    ['maxContextTokens', 131_072],
    ['maxOutputBytes', 32_000],
    ['maxOutputTokens', 8_192],
    ['maxDurationMilliseconds', 20_000],
    ['maxAttempts', 4],
    ['maxCandidateBytes', 16_000],
    ['maxRepositories', 20],
    ['maxRepositoryBytes', 65_536],
  ] as const)
    integer(budget[key], maximum, 1);
  if (
    framingTokens >= integer(budget.maxInputTokens, 65_536, 1) ||
    framingTokens + integer(budget.maxOutputTokens, 8_192, 1) >=
      integer(budget.maxContextTokens, 131_072, 1)
  )
    throw new TypeError('Impossible support engineering token budgets');
  integer(budget.maxCostMicros, Number.MAX_SAFE_INTEGER);
  if (budget.currency !== 'USD')
    throw new TypeError('Unsupported cost contract');
  const controls = record(config.dataControls, [
    'status',
    'purpose',
    'configurationBinding',
    'accountRef',
    'projectRef',
    'endpointRef',
    'modelRef',
    'featuresRef',
    'exceptionsRef',
    'intermediaryRefs',
    'verifiedAt',
    'validUntil',
  ]);
  if (
    controls.status !== 'verified' ||
    controls.purpose !== 'support_bug_assessment' ||
    controls.configurationBinding !== config.version
  )
    throw new TypeError('Unverified support engineering configuration');
  for (const key of [
    'configurationBinding',
    'accountRef',
    'projectRef',
    'endpointRef',
    'modelRef',
    'featuresRef',
    'exceptionsRef',
  ])
    scalar(controls[key]);
  if (
    !Array.isArray(controls.intermediaryRefs) ||
    controls.intermediaryRefs.length === 0 ||
    controls.intermediaryRefs.length > 16
  )
    throw new TypeError('Unverified support engineering configuration');
  if (
    Object.getOwnPropertySymbols(controls.intermediaryRefs).length !== 0 ||
    Object.getOwnPropertyNames(controls.intermediaryRefs).length !==
      controls.intermediaryRefs.length + 1
  )
    throw new TypeError('Unverified support engineering configuration');
  for (let index = 0; index < controls.intermediaryRefs.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(
      controls.intermediaryRefs,
      String(index),
    );
    if (!descriptor || !('value' in descriptor))
      throw new TypeError('Unverified support engineering configuration');
    scalar(descriptor.value);
  }
  validInterval(controls, now);
  // Every nested value above was checked as data before cloning.
  return structuredClone(raw) as VerifiedEngineeringConfiguration;
}

export function createSupportEngineeringConfiguration(
  options: SupportEngineeringConfigurationOptions,
): SupportEngineeringConfiguration {
  const counter = options.counter;
  let configuredAllowlist: readonly SupportEngineeringAllowedRoute[] = [];
  try {
    configuredAllowlist = structuredClone(options.allowlist ?? []);
  } catch {
    /* unavailable */
  }
  const countDescriptor =
    counter && Object.getOwnPropertyDescriptor(counter, 'count');
  const count: EngineeringTokenCounter['count'] | undefined =
    countDescriptor &&
    'value' in countDescriptor &&
    typeof countDescriptor.value === 'function'
      ? countDescriptor.value
      : undefined;
  let qualifiedPolicy: { text: string; digest: string } | undefined;
  const readCurrentRoute = (
    expectedVersion?: string,
    requireQualified = true,
  ): ApprovedSupportEngineeringRoute | undefined => {
    try {
      if (
        options.isEnabled?.() !== true ||
        !options.readRoute ||
        !counter ||
        typeof count !== 'function'
      )
        return undefined;
      const allowlist = configuredAllowlist;
      if (
        !Array.isArray(allowlist) ||
        allowlist.length === 0 ||
        allowlist.length > 8
      )
        return undefined;
      const allowed = allowlist.map((value) => {
        record(value, [
          'model',
          'provider',
          'endpointTag',
          'outputTokenParameter',
        ]);
        scalar(value.model);
        scalar(value.provider);
        scalar(value.endpointTag);
        if (
          !/^[a-z0-9-]+\/[a-z0-9._/-]+$/u.test(value.endpointTag) ||
          !['max_tokens', 'max_completion_tokens'].includes(
            value.outputTokenParameter,
          )
        )
          throw new TypeError('Invalid exact endpoint allowlist');
        return value;
      });
      const now = instant(options.clock.now());
      const raw = options.readRoute();
      const route = record(raw, [
        'host',
        'purpose',
        'endpoint',
        'endpointTag',
        'outputTokenParameter',
        'credentialRef',
        'usageScopeRef',
        'configuration',
        'approval',
      ]);
      if (
        route.host !== 'pegma.dev' ||
        route.purpose !== 'support_bug_assessment' ||
        route.endpoint !== SUPPORT_ENGINEERING_ENDPOINT
      )
        return undefined;
      scalar(route.credentialRef);
      scalar(route.usageScopeRef);
      scalar(route.endpointTag);
      const config = checkedConfiguration(route.configuration, now);
      if (expectedVersion !== undefined && config.version !== expectedVersion)
        return undefined;
      if (
        !allowed.some(
          (entry) =>
            entry.model === config.model &&
            entry.provider === config.provider &&
            entry.endpointTag === route.endpointTag &&
            entry.outputTokenParameter === route.outputTokenParameter,
        )
      )
        return undefined;
      const approval = record(route.approval, [
        'configurationVersion',
        'wireVersion',
        'evidenceRef',
        'effectivePolicyRef',
        'evaluationRef',
        'responseIdentityRef',
        'tokenizerRef',
        'requestPolicySha256',
        'nativeCostCurrency',
        'nativeCostUnit',
        'rounding',
        'zdr',
        'safetyRetention',
        'inputOutputLogging',
        'inputOutputUse',
        'broadcast',
        'responseCache',
        'unreviewedFeatures',
        'implicitCache',
        'verifiedAt',
        'validUntil',
      ]);
      for (const key of [
        'evidenceRef',
        'effectivePolicyRef',
        'evaluationRef',
        'responseIdentityRef',
        'tokenizerRef',
      ])
        scalar(approval[key]);
      if (
        typeof approval.requestPolicySha256 !== 'string' ||
        !/^[a-f0-9]{64}$/u.test(approval.requestPolicySha256)
      )
        return undefined;
      if (
        approval.configurationVersion !== config.version ||
        approval.wireVersion !== SUPPORT_ENGINEERING_WIRE_VERSION ||
        approval.nativeCostCurrency !== 'USD' ||
        approval.nativeCostUnit !== 'openrouter_credits_usd' ||
        approval.rounding !== 'ceil_micro' ||
        approval.zdr !== true ||
        approval.safetyRetention !== false ||
        approval.inputOutputLogging !== false ||
        approval.inputOutputUse !== false ||
        approval.broadcast !== false ||
        approval.responseCache !== false ||
        approval.unreviewedFeatures !== false ||
        (approval.implicitCache !== 'absent' &&
          approval.implicitCache !== 'approved')
      )
        return undefined;
      validInterval(approval, now);
      const qualificationDescriptor = Object.getOwnPropertyDescriptor(
        counter,
        'qualification',
      );
      if (
        !qualificationDescriptor ||
        !('value' in qualificationDescriptor) ||
        Object.getOwnPropertyDescriptor(counter, 'count')?.value !== count
      )
        return undefined;
      const qualification = record(qualificationDescriptor.value, [
        'model',
        'modelVersion',
        'wireVersion',
        'framingTokens',
        'evidenceRef',
        'verifiedAt',
        'validUntil',
      ]);
      scalar(qualification.evidenceRef);
      validInterval(qualification, now);
      if (
        qualification.model !== config.model ||
        qualification.modelVersion !== config.modelVersion ||
        qualification.wireVersion !== SUPPORT_ENGINEERING_WIRE_VERSION ||
        qualification.framingTokens !== config.framingTokens ||
        qualification.evidenceRef !== approval.tokenizerRef ||
        instant(approval.validUntil) > instant(qualification.validUntil) ||
        instant(approval.validUntil) >
          Date.parse(config.dataControls.validUntil)
      )
        return undefined;
      const result = structuredClone({
        ...route,
        configuration: config,
      }) as ApprovedSupportEngineeringRoute;
      if (
        requireQualified &&
        (!qualifiedPolicy ||
          qualifiedPolicy.text !== policyText(result) ||
          qualifiedPolicy.digest !== approval.requestPolicySha256)
      )
        return undefined;
      return result;
    } catch {
      return undefined;
    }
  };
  const currentRoute = (expectedVersion?: string) =>
    readCurrentRoute(expectedVersion);
  return {
    configuration: {
      async resolve(expectedVersion, signal) {
        try {
          if (signal.aborted) return { outcome: 'unavailable' };
          if (options.isEnabled?.() !== true) return { outcome: 'disabled' };
          const route = readCurrentRoute(expectedVersion, false);
          if (!route) return { outcome: 'unavailable' };
          const digest = await supportEngineeringRoutePolicySha256(route);
          if (digest !== route.approval.requestPolicySha256)
            return { outcome: 'unavailable' };
          const latest = readCurrentRoute(expectedVersion, false);
          if (
            signal.aborted ||
            !latest ||
            canonicalData(latest) !== canonicalData(route)
          )
            return { outcome: 'unavailable' };
          qualifiedPolicy = { text: policyText(latest), digest };
          return { outcome: 'ready', configuration: latest.configuration };
        } catch {
          return { outcome: 'unavailable' };
        }
      },
    },
    tokenCounter: {
      count(text) {
        if (
          typeof text !== 'string' ||
          text.length > 262_144 ||
          !currentRoute() ||
          !count ||
          !counter
        )
          throw new TypeError(
            'Qualified support engineering counter unavailable',
          );
        const result = count.call(counter, text);
        return integer(result, Number.MAX_SAFE_INTEGER, text.length ? 1 : 0);
      },
    },
    currentRoute,
  };
}
