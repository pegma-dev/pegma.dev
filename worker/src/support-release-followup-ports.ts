import type {
  EngineeringFollowupOptions,
  EngineeringFollowupKey,
  EngineeringFollowupReleaseEvidencePort,
} from '@pegma/support-desk-application';
import type { SupportDeskReleaseFollowupOptions } from '@pegma/support-desk-ai';
import type { SupportModelUsagePolicy } from './support-model-usage-ledger';
import type { SupportFollowupMappings } from './support-release-followup-mapping';
import type { LearningServiceAccessPort } from '@pegma/support-desk-ai';
import type { SupportFollowupRetests } from './support-release-followup-retests';
import type { SupportReleaseFollowupPaidOptions } from './support-release-followup-production';

/** Trusted current facts, never a webhook body, release tag or browser assertion. */
export interface SupportReleaseFollowupConfiguration {
  readonly releaseEvidence: EngineeringFollowupReleaseEvidencePort;
  readonly checks: SupportDeskReleaseFollowupOptions['checks'];
  readonly checksFor?: (
    key: EngineeringFollowupKey,
  ) => SupportDeskReleaseFollowupOptions['checks'];
  readonly reassessmentChecksFor?: (
    key: EngineeringFollowupKey,
    authority: LearningServiceAccessPort,
  ) => SupportDeskReleaseFollowupOptions['checks'];
  readonly reassessmentUsageScopeRef?: string;
  readonly targets: SupportDeskReleaseFollowupOptions['targets'];
  readonly retestReceipts: NonNullable<
    EngineeringFollowupOptions['retestReceipts']
  >;
  readonly knowledge?: SupportDeskReleaseFollowupOptions['knowledge'];
  readonly knowledgeAccess?: SupportDeskReleaseFollowupOptions['knowledgeAccess'];
  readonly application?: Omit<
    EngineeringFollowupOptions,
    'enabled' | 'releaseEvidence' | 'checks' | 'retestReceipts'
  >;
  /** Initial candidates require separately evaluated purpose-specific ports. */
  readonly generation?: Pick<
    SupportDeskReleaseFollowupOptions,
    'serviceAccess' | 'configuration' | 'evaluations' | 'model' | 'tokenCounter'
  > & {
    readonly usagePolicy: SupportModelUsagePolicy;
  };
}

/** Omission is OFF. No environment value manufactures proof or provider authority. */
export interface SupportReleaseFollowupComposition {
  readonly enabled?: () => boolean;
  readonly configuration?: SupportReleaseFollowupConfiguration;
  readonly mappings?: SupportFollowupMappings;
  readonly retests?: SupportFollowupRetests;
  readonly production?: SupportReleaseFollowupPaidOptions;
  readonly governanceAccess?: {
    resolve(collectionId: string, signal: AbortSignal): Promise<{
      readonly access: import('@pegma/authorization-core').AccessContext;
      readonly authorityVersion: string;
    } | null>;
  };
}

/** Presence selects the default binder; a legacy injected bundle keeps ownership. */
export function supportReleaseFollowupUsesDefault(
  value?: SupportReleaseFollowupComposition,
) {
  try {
    return value === undefined ||
      (value !== null && Object.hasOwn(value, 'production'));
  } catch {
    return false;
  }
}
export function supportReleaseFollowupPaidSelection(
  value?: SupportReleaseFollowupComposition,
) {
  try {
    return value?.production;
  } catch {
    return undefined;
  }
}

export function supportReleaseFollowupEnabled(
  value: SupportReleaseFollowupComposition = {},
): boolean {
  try {
    const config = value.configuration;
    return (
      value.enabled?.() === true &&
      config !== undefined &&
      typeof config.releaseEvidence?.verifyInput === 'function' &&
      typeof config.releaseEvidence?.confirm === 'function' &&
      typeof config.checks?.resolvePolicy === 'function' &&
      typeof config.checks?.check === 'function' &&
      typeof config.checks?.verify === 'function' &&
      typeof config.retestReceipts?.verify === 'function' &&
      typeof config.targets?.resolve === 'function'
    );
  } catch {
    return false;
  }
}

export function supportReleaseFollowupApplicationOptions(
  value: SupportReleaseFollowupComposition = {},
): EngineeringFollowupOptions | undefined {
  if (!supportReleaseFollowupEnabled(value)) return undefined;
  const config = value.configuration!;
  return {
    ...config.application,
    enabled: true,
    releaseEvidence: config.releaseEvidence,
    checks: config.checks,
    retestReceipts: config.retestReceipts,
  };
}

/** Client command identity is stable; correlation additionally binds actor and operation. */
export async function supportReleaseFollowupIdentity(
  actorId: string,
  ticketId: string,
  operation: string,
  commandId: string,
) {
  for (const value of [actorId, ticketId, operation, commandId]) {
    if (
      typeof value !== 'string' ||
      value.length < 1 ||
      value.length > 200 ||
      /[\u0000-\u001F\u007F]/u.test(value)
    )
      throw new TypeError('Invalid follow-up command identity');
  }
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(
        JSON.stringify([
          'pegma.support-release-followup.v1',
          actorId,
          ticketId,
          operation,
          commandId,
        ]),
      ),
    ),
  );
  return {
    commandId,
    correlationId:
      'followup:' +
      [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join(''),
  };
}
