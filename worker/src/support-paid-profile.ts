import { z } from 'zod';
import { articleKinds } from '@pegma/knowledge-base-contracts';
import { knowledgeLimits } from '@pegma/knowledge-base-core';
import type { VerifiedEngineeringCalibration } from '@pegma/support-desk-ai';
import type {
  EngineeringRepositoryDescriptor,
  VerifiedEngineeringRouting,
} from '@pegma/support-desk-application';
import type {
  IndependentCheckCounter,
  IndependentCheckRoute,
  SupportModelUsagePolicy,
  ApprovedSupportReleaseFollowupRoute,
  QualifiedSupportReleaseFollowupCounter,
} from '@pegma/support-desk-ai/openrouter';
import { strictJson } from './support-openrouter-model';
import type {
  ApprovedSupportLearningRoute,
  QualifiedSupportLearningCounter,
} from './support-learning-model';
import type {
  ApprovedSupportEngineeringRoute,
  QualifiedSupportEngineeringCounter,
} from './support-engineering-config';
import type { SupportEngineeringRepository } from './support-engineering-repository';

export const SUPPORT_PAID_PROFILE_SETTING = 'SUPPORT_PAID_CONFIGURATION_JSON';
const scalar = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[^\u0000-\u001f\u007f-\u009f]+$/u)
  .refine((value) => value.trim() === value);
const time = z.string().datetime({ precision: 3 });
const integer = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const data = <T>() =>
  z.custom<T>((value) => value !== null && typeof value === 'object' && !Array.isArray(value));
const qualification = z
  .object({
    model: scalar,
    modelVersion: scalar,
    wireVersion: scalar,
    framingTokens: z.number().int().min(0).max(8192),
    evidenceRef: scalar,
    verifiedAt: time,
    validUntil: time,
  })
  .strict();
const usage = z
  .object({
    version: scalar,
    scopeRef: scalar,
    configurationVersion: scalar,
    modelVersion: scalar,
    pricingRef: scalar,
    currency: z.literal('USD'),
    maxCostMicros: integer,
    maxReservationCostMicros: integer,
    maxReservations: integer.max(10000),
    validFrom: time,
    validUntil: time,
    terminalRetentionMilliseconds: integer,
  })
  .strict();
const model = <T>() => z.object({ route: data<T>(), qualification, usagePolicy: usage }).strict();
const binding = z
  .object({
    sourceBindingHash: hash,
    evidenceFingerprint: hash,
    candidateHash: hash,
    inputFingerprint: hash,
    routingHash: hash,
    policyGeneration: integer,
    policyHash: hash,
    modelVersion: scalar,
    promptVersion: scalar,
    parserVersion: scalar,
    repositoryId: scalar,
  })
  .strict();
const proof = z
  .object({
    binding,
    outcome: z.enum(['accepted', 'human_required', 'restricted']),
    verifierReceiptId: scalar,
    verifierVersion: scalar,
    verifiedAt: time,
    validUntil: time,
  })
  .strict();
const calibration = z
  .object({
    version: scalar,
    artifactRef: scalar,
    rubricVersion: scalar,
    evaluationRef: scalar,
    modelVersion: scalar,
    promptVersion: scalar,
    parserVersion: scalar,
    policyHash: hash,
    verifiedAt: time,
    validUntil: time,
  })
  .strict();
const repository = z
  .object({
    repositoryId: scalar,
    owner: scalar,
    name: scalar,
    visibility: z.enum(['public', 'private']),
    appId: scalar,
    installationId: scalar,
  })
  .strict();
const schema = z
  .object({
    version: z.literal(1),
    revision: scalar.max(80),
    sourceRevision: scalar.max(80),
    checks: model<IndependentCheckRoute>()
      .extend({
        receiptKey: z
          .object({
            id: scalar,
            reference: z.literal('support-independent-check-receipt'),
            validUntil: time,
          })
          .strict(),
      })
      .strict(),
    releaseFollowup: model<ApprovedSupportReleaseFollowupRoute>()
      .extend({
        target: z.discriminatedUnion('kind', [
          z.object({ kind: z.literal('none') }).strict(),
          z.object({ kind: z.literal('article'), articleId: scalar }).strict(),
        ]),
      })
      .strict()
      .optional(),
    learning: model<ApprovedSupportLearningRoute>()
      .extend({
        target: z
          .object({
            version: scalar,
            collectionId: scalar,
            kind: z.enum(articleKinds),
            searchQuery: scalar,
            explicitDraftIds: z.array(scalar).max(20),
            title: scalar.max(knowledgeLimits.titleCharacters),
            tags: z.array(scalar.max(knowledgeLimits.tagCharacters)).max(knowledgeLimits.tags),
          })
          .strict(),
      })
      .strict()
      .optional(),
    engineering: model<ApprovedSupportEngineeringRoute>()
      .extend({
        intakeEnabled: z.boolean(),
        reviewEnabled: z.boolean(),
        routing: z
          .object({
            calibration,
            decisions: z.array(z.object({ receipt: scalar, proof }).strict()).max(100),
          })
          .strict(),
        repositories: z
          .array(
            z
              .object({
                key: scalar,
                repository,
                descriptor: data<EngineeringRepositoryDescriptor>(),
                duplicateQuery: scalar,
                settings: z
                  .object({
                    labels: z.array(scalar.max(100)).max(20),
                    templateId: scalar.max(100).optional(),
                    evidenceReferences: z.array(scalar).max(20),
                    duplicate: z
                      .object({ issueId: scalar, issueNumber: integer })
                      .strict()
                      .optional(),
                  })
                  .strict(),
                authentication: z
                  .object({
                    binding: scalar,
                    version: scalar,
                    validUntil: time,
                    appJwtRef: z.literal('SUPPORT_ENGINEERING_APP_JWT'),
                    installationTokenRef: z.literal('SUPPORT_ENGINEERING_INSTALLATION_TOKEN'),
                  })
                  .strict(),
              })
              .strict(),
          )
          .min(1)
          .max(20),
      })
      .strict()
      .optional(),
  })
  .strict();
export interface PaidModel<Route, Qualification> {
  readonly route: Route;
  readonly qualification: Qualification;
  readonly usagePolicy: SupportModelUsagePolicy;
}
export type SupportPaidProfile = z.infer<typeof schema> & {
  readonly checks: PaidModel<IndependentCheckRoute, IndependentCheckCounter['qualification']>;
  readonly releaseFollowup?: PaidModel<
    ApprovedSupportReleaseFollowupRoute,
    QualifiedSupportReleaseFollowupCounter['qualification']
  >;
  readonly learning?: PaidModel<
    ApprovedSupportLearningRoute,
    QualifiedSupportLearningCounter['qualification']
  >;
  readonly engineering?: PaidModel<
    ApprovedSupportEngineeringRoute,
    QualifiedSupportEngineeringCounter['qualification']
  > & {
    readonly routing: {
      readonly calibration: VerifiedEngineeringCalibration;
      readonly decisions: readonly {
        readonly receipt: string;
        readonly proof: VerifiedEngineeringRouting;
      }[];
    };
    readonly repositories: readonly { readonly repository: SupportEngineeringRepository }[];
  };
};
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
/** Operator data only. Nested route/privacy evidence is checked by its existing
 * purpose factory before it can become a runtime port. No identities or grants. */
export function readSupportPaidProfile(raw: unknown): SupportPaidProfile | undefined {
  try {
    if (typeof raw !== 'string' || new TextEncoder().encode(raw).length > 262144) return undefined;
    const parsed = schema.parse(strictJson(raw).value);
    if (!parsed.learning && !parsed.engineering && !parsed.releaseFollowup) return undefined;
    return freeze(parsed) as SupportPaidProfile;
  } catch {
    return undefined;
  }
}
