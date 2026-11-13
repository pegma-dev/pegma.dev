import { resolveAccess } from '@pegma/authorization-core';
import { knowledgePermissions } from '@pegma/knowledge-base-contracts';
import { systemClock, type Clock } from '@pegma/spine';
import type { LearningCheckPolicyPort } from '@pegma/support-desk-ai';
import type { ResolutionTrustContext } from '@pegma/support-desk-application';
import type { SupportLearningRootComposition } from './index';
import { createSupportBackgroundServiceAccess } from './support-background-service-access';
import { canonical, object, strictJson } from './support-openrouter-model';

export const SUPPORT_LEARNING_SOURCE_SETTING =
  'SUPPORT_LEARNING_SOURCE_CONFIGURATION_JSON';
export const SUPPORT_LEARNING_GOVERNANCE_READER =
  'pegma/support-learning-governance-reader';
export interface SupportLearningSourceEnvironment {
  readonly SUPPORT_LEARNING_SOURCE_CONFIGURATION_JSON?: string;
  readonly PEGMA_KNOWLEDGE_ENABLED?: string;
  readonly PEGMA_SUPPORT_LEARNING_INTAKE_ENABLED?: string;
}
export interface SupportLearningSourceConfiguration {
  readonly version: 1;
  readonly revision: string;
  readonly namespace: string;
  readonly intakeEnabled: boolean;
  readonly product: {
    readonly productId: string;
    readonly version: string;
    readonly buildId: string;
  };
  readonly collectionIds: readonly string[];
  readonly testEvidence?: { readonly retentionMilliseconds: number };
}
interface BootstrapOptions {
  readonly clock?: Clock;
  readonly currentEnv?: () => SupportLearningSourceEnvironment;
  readonly isSelected?: () => boolean;
  readonly reviewPolicy?: LearningCheckPolicyPort;
}
const encoder = new TextEncoder();
function text(value: unknown, maximum = 200): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > maximum ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(value)
  )
    throw new TypeError('Invalid Source configuration reference');
  return value;
}
/** Trusted environment configuration only. It carries no authority, credentials,
 * provider/check approval or periodic Source-renewal requirement. */
export function readSupportLearningSourceConfiguration(
  raw: unknown,
): SupportLearningSourceConfiguration | undefined {
  try {
    if (typeof raw !== 'string' || encoder.encode(raw).byteLength > 16_384)
      return undefined;
    const value = object(
      strictJson(raw).value,
      [
        'version',
        'revision',
        'namespace',
        'intakeEnabled',
        'product',
        'collectionIds',
        'testEvidence',
      ],
      [
        'version',
        'revision',
        'namespace',
        'intakeEnabled',
        'product',
        'collectionIds',
      ],
    );
    const product = object(value.product, ['productId', 'version', 'buildId']);
    if (
      value.version !== 1 ||
      typeof value.intakeEnabled !== 'boolean' ||
      !Array.isArray(value.collectionIds) ||
      value.collectionIds.length < 1 ||
      value.collectionIds.length > 20
    )
      return undefined;
    const ids = value.collectionIds.map((id) => text(id));
    if (new Set(ids).size !== ids.length) return undefined;
    let testEvidence: SupportLearningSourceConfiguration['testEvidence'];
    if (Object.hasOwn(value, 'testEvidence')) {
      const evidence = object(value.testEvidence, ['retentionMilliseconds']);
      if (
        typeof evidence.retentionMilliseconds !== 'number' ||
        !Number.isSafeInteger(evidence.retentionMilliseconds) ||
        evidence.retentionMilliseconds < 1
      )
        return undefined;
      testEvidence = Object.freeze({
        retentionMilliseconds: evidence.retentionMilliseconds,
      });
    }
    return Object.freeze({
      version: 1,
      revision: text(value.revision, 80),
      namespace: text(value.namespace, 80),
      intakeEnabled: value.intakeEnabled,
      product: Object.freeze({
        productId: text(product.productId),
        version: text(product.version),
        buildId: text(product.buildId),
      }),
      collectionIds: Object.freeze(ids),
      ...(testEvidence === undefined ? {} : { testEvidence }),
    });
  } catch {
    return undefined;
  }
}
async function digest(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest(
    'SHA-256',
    encoder.encode(canonical(value)),
  );
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

/** Select one existing Source composition. It constructs no application, Store,
 * model, key reader or worker. The ordinary root owns the exact App/KB graph. */
export function createSupportLearningBootstrap(
  env: SupportLearningSourceEnvironment,
  options: BootstrapOptions = {},
) {
  const raw = env[SUPPORT_LEARNING_SOURCE_SETTING];
  const configuration = readSupportLearningSourceConfiguration(raw);
  if (configuration === undefined) return undefined;
  const currentConfiguration = configuration;
  const clock = options.clock ?? systemClock;
  const currentEnv = options.currentEnv ?? (() => env);
  function current(): boolean {
    try {
      const live = currentEnv();
      return (
        (options.isSelected?.() ?? true) &&
        live.PEGMA_KNOWLEDGE_ENABLED === 'true' &&
        live[SUPPORT_LEARNING_SOURCE_SETTING] === raw
      );
    } catch {
      return false;
    }
  }
  const profileVersion = async () =>
    configuration.revision + ':' + (await digest(configuration));
  const intrinsic = createSupportBackgroundServiceAccess({
    async readProfile(kind, signal) {
      if (!current() || signal.aborted || !kind.startsWith('learning-'))
        return { enabled: false };
      const version = await profileVersion();
      return current() && !signal.aborted
        ? {
            enabled: true,
            version,
            usageScopeRef: 'pg-source/' + configuration.namespace,
          }
        : { enabled: false };
    },
  });
  async function resolveProduct(
    context: Pick<ResolutionTrustContext, 'ticketId' | 'ticketRevision' | 'acceptedAt'>,
    signal: AbortSignal,
  ) {
    if (!current() || signal.aborted) return null;
    const accepted = Date.parse(context.acceptedAt),
      now = Date.parse(clock.now());
    if (
      !Number.isFinite(accepted) ||
      !Number.isFinite(now) ||
      accepted > now ||
      now >= accepted + 300_000 ||
      new Date(accepted).toISOString() !== context.acceptedAt
    )
      return null;
    const version = await profileVersion();
    const binding = await digest([
      currentConfiguration.namespace,
      currentConfiguration.product,
      currentConfiguration.collectionIds,
    ]);
    const receipt = await digest([
      version,
      context.ticketId,
      context.ticketRevision,
      context.acceptedAt,
    ]);
    const closing = Date.parse(clock.now());
    if (
      !current() ||
      signal.aborted ||
      !Number.isFinite(closing) ||
      closing < accepted ||
      closing >= accepted + 300_000
    )
      return null;
    return {
      ...currentConfiguration.product,
      binding,
      contextVersion: version,
      receiptId: 'pg-source-context:' + receipt,
      verifiedAt: context.acceptedAt,
      validUntil: new Date(accepted + 300_000).toISOString(),
    };
  }
  const selectedPolicy = options.reviewPolicy;
  const learning: SupportLearningRootComposition = {
    source: {
      ...intrinsic.learning,
      reviewPolicy: {
        async resolvePolicy(expected, signal) {
          if (!current() || signal.aborted || selectedPolicy === undefined)
            return { outcome: 'unavailable' };
          const value = await selectedPolicy.resolvePolicy(expected, signal);
          return current() &&
            !signal.aborted &&
            options.reviewPolicy === selectedPolicy
            ? value
            : { outcome: 'unavailable' };
        },
      },
    },
    intake: {
      enabled: configuration.intakeEnabled,
      productContext: {
        resolve: resolveProduct,
      },
    },
    readScheduling: 'sdk',
  };
  if (configuration.testEvidence !== undefined) {
    const evidence = configuration.testEvidence;
    const governanceCurrent = (collectionId: string, signal: AbortSignal) => {
      try {
        return (
          current() &&
          !signal.aborted &&
          configuration.intakeEnabled &&
          currentEnv().PEGMA_SUPPORT_LEARNING_INTAKE_ENABLED === 'true' &&
          configuration.collectionIds.includes(collectionId)
        );
      } catch {
        return false;
      }
    };
    const testEvidence: NonNullable<
      SupportLearningRootComposition['testEvidence']
    > = {
      retentionMilliseconds: evidence.retentionMilliseconds,
      governanceAccess: {
        async resolve(collectionId, signal) {
          if (!governanceCurrent(collectionId, signal)) return null;
          const authorityVersion = await profileVersion();
          // AccessContext is instance-wide. This internal callback restricts its use
          // to current selected collections before Root's actual governance read.
          if (!governanceCurrent(collectionId, signal)) return null;
          const access = resolveAccess(
            { principalId: SUPPORT_LEARNING_GOVERNANCE_READER },
            {
              version: 'pg-learning-governance-reader-v1',
              defaults: [knowledgePermissions.validationManage],
            },
          );
          return { access, authorityVersion };
        },
      },
    };
    return Object.freeze({
      configuration,
      current,
      resolveProduct,
      learning: Object.freeze({ ...learning, testEvidence }),
    });
  }
  return Object.freeze({
    configuration,
    current,
    resolveProduct,
    learning: Object.freeze(learning),
  });
}
