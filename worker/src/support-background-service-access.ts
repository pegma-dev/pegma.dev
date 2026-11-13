import { resolveAccess } from '@pegma/authorization-core';
import { supportPermissions as support } from '@pegma/support-desk-application';
import { knowledgePermissions as knowledge } from '@pegma/knowledge-base-contracts';
import type {
  SupportDeskLearningOptions,
  SupportDeskEngineeringOptions,
} from '@pegma/support-desk-ai';

type LearningOptions = SupportDeskLearningOptions;
type EngineeringOptions = SupportDeskEngineeringOptions;
export type SupportBackgroundServiceKind =
  | 'learning-source'
  | 'learning-draft'
  | 'learning-retirement'
  | 'engineering-process'
  | 'release-followup-process'
  | 'engineering-reconcile';
/** Version identifies the current trusted profile AND its product/target scope.
 * It is host policy identity, without provider/build/check/funding attestation. */
export type SupportBackgroundServiceProfile =
  | { readonly enabled: false }
  | {
      readonly enabled: true;
      readonly version: string;
      readonly usageScopeRef?: string;
    };
export interface SupportBackgroundServiceAccessOptions {
  readProfile?: (
    kind: SupportBackgroundServiceKind,
    signal: AbortSignal,
  ) =>
    | SupportBackgroundServiceProfile
    | undefined
    | Promise<SupportBackgroundServiceProfile | undefined>;
}
export interface SupportBackgroundServiceAccess {
  readonly learning: Pick<
    LearningOptions,
    'serviceAccess' | 'knowledgeAccess' | 'retirementAccess'
  >;
  readonly engineering: Pick<
    EngineeringOptions,
    'serviceAccess' | 'reconciliationAccess'
  >;
  readonly releaseFollowup: { readonly serviceAccess: LearningOptions['serviceAccess'] };
}
export const SUPPORT_BACKGROUND_SERVICE_IDS = Object.freeze({
  'learning-source': 'pegma/support-learning-source',
  'learning-draft': 'pegma/support-learning-draft',
  'learning-retirement': 'pegma/support-learning-retirement',
  'engineering-process': 'pegma/support-engineering-worker',
  'release-followup-process': 'pegma/support-release-followup-worker',
  'engineering-reconcile': 'pegma/support-engineering-reconciler',
});
const sourceRead = Object.freeze([
  support.queueRead,
  support.learningRead,
  support.learningProcess,
]);
const ceilings = Object.freeze({
  'learning-source': sourceRead,
  'learning-draft': Object.freeze([
    ...sourceRead,
    knowledge.articleRead,
    knowledge.draftRead,
    knowledge.draftWrite,
    knowledge.provenanceRead,
    knowledge.provenanceWrite,
  ]),
  'learning-retirement': Object.freeze([
    ...sourceRead,
    knowledge.draftRead,
    knowledge.provenanceRead,
    knowledge.retire,
  ]),
  'engineering-process': Object.freeze([
    support.queueRead,
    support.engineeringRead,
    support.engineeringProcess,
  ]),
  'release-followup-process': Object.freeze([
    support.queueRead,
    support.engineeringFollowupRead,
    support.engineeringFollowupProcess,
  ]),
  'engineering-reconcile': Object.freeze([support.engineeringReconcile]),
});
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError('Invalid background service profile');
  const prototype = Object.getPrototypeOf(value);
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    Object.getOwnPropertySymbols(value).length !== 0 ||
    Object.values(Object.getOwnPropertyDescriptors(value)).some(
      (descriptor) => !('value' in descriptor) || !descriptor.enumerable,
    )
  )
    throw new TypeError('Invalid background service profile data');
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 200 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(value)
  )
    throw new TypeError('Invalid background service profile reference');
  return value;
}
function profile(raw: unknown, requireUsageScope: boolean) {
  if (raw === undefined) return undefined;
  const value = object(raw);
  if (
    Object.keys(value).some(
      (key) => !['enabled', 'version', 'usageScopeRef'].includes(key),
    )
  )
    throw new TypeError('Invalid background service profile fields');
  if (value.enabled === false) return undefined;
  if (value.enabled !== true)
    throw new TypeError('Invalid background service enablement');
  const version = text(value.version);
  const usageScopeRef =
    value.usageScopeRef === undefined ? undefined : text(value.usageScopeRef);
  if (requireUsageScope && usageScopeRef === undefined)
    throw new TypeError('Background service usage scope unavailable');
  return { version, usageScopeRef };
}

/** Intrinsic jobs have no human account, session, role grant or external token.
 * These access contexts are instance-wide. Existing SDK target/source, provenance,
 * check, current-authority and commit fences continue bounding their operations. */
export function createSupportBackgroundServiceAccess(
  options: SupportBackgroundServiceAccessOptions = {},
): SupportBackgroundServiceAccess {
  async function resolve(
    kind: SupportBackgroundServiceKind,
    requireUsageScope: boolean,
    signal: AbortSignal,
  ) {
    const read = options.readProfile;
    if (signal.aborted || read === undefined)
      return { outcome: 'inactive' as const };
    try {
      const observed = await read(kind, signal);
      if (signal.aborted) return { outcome: 'inactive' as const };
      if (options.readProfile !== read)
        return { outcome: 'unavailable' as const };
      const selected = profile(observed, requireUsageScope);
      if (selected === undefined) return { outcome: 'inactive' as const };
      const access = resolveAccess(
        { principalId: SUPPORT_BACKGROUND_SERVICE_IDS[kind] },
        {
          version: 'pg-background-' + kind + '-v1',
          defaults: ceilings[kind],
        },
      );
      return {
        outcome: 'ready' as const,
        authority: {
          access,
          authorityVersion: selected.version,
          ...(selected.usageScopeRef === undefined
            ? {}
            : { usageScopeRef: selected.usageScopeRef }),
        },
      };
    } catch {
      return { outcome: 'unavailable' as const };
    }
  }
  function service(
    kind: SupportBackgroundServiceKind,
  ): LearningOptions['serviceAccess'] {
    return Object.freeze<LearningOptions['serviceAccess']>({
      async resolve(signal) {
        const read = options.readProfile;
        const result = await resolve(kind, true, signal);
        if (signal.aborted) return { outcome: 'inactive' };
        if (options.readProfile !== read) return { outcome: 'unavailable' };
        if (result.outcome !== 'ready') return result;
        const usageScopeRef = result.authority.usageScopeRef;
        if (usageScopeRef === undefined) return { outcome: 'unavailable' };
        return {
          outcome: 'ready',
          authority: { ...result.authority, usageScopeRef },
        };
      },
    });
  }
  function knowledgePort(
    kind: SupportBackgroundServiceKind,
  ): LearningOptions['knowledgeAccess'] {
    return Object.freeze<LearningOptions['knowledgeAccess']>({
      async resolve(signal) {
        const read = options.readProfile;
        const result = await resolve(kind, false, signal);
        if (signal.aborted) return { outcome: 'inactive' };
        if (options.readProfile !== read) return { outcome: 'unavailable' };
        if (result.outcome !== 'ready') return result;
        return {
          outcome: 'ready',
          authority: {
            access: result.authority.access,
            authorityVersion: result.authority.authorityVersion,
          },
        };
      },
    });
  }
  return Object.freeze({
    learning: Object.freeze({
      serviceAccess: service('learning-source'),
      knowledgeAccess: knowledgePort('learning-draft'),
      retirementAccess: knowledgePort('learning-retirement'),
    }),
    engineering: Object.freeze({
      serviceAccess: service('engineering-process'),
      reconciliationAccess: service('engineering-reconcile'),
    }),
    releaseFollowup: Object.freeze({ serviceAccess: service('release-followup-process') }),
  });
}
