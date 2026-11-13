import { z } from 'zod';
import { hasPermission, type AccessContext } from '@pegma/authorization-core';
import {
  auditRecordId,
  defineAudit,
  encodeAuditEvent,
  decodeAuditEvent,
  type AuditEvent,
} from '@pegma/audit';
import {
  defineCollection,
  type Store,
  type StoredRecord,
} from '@pegma/storage-core';
import {
  supportPermissions,
  type EngineeringFollowupProofContext,
  type EngineeringFollowupReleaseEvidencePort,
  type VerifiedEngineeringFollowupContext,
} from '@pegma/support-desk-application';
import type { Clock } from '@pegma/spine';
import type { SupportRuntime } from './support-desk';
import type { SupportReleaseFollowupContext } from './support-release-followup';
import { ApiError } from './api-auth';
import { SUPPORT_ROLE } from './support-access';
import {
  componentReleaseCollection,
  componentReleaseKey,
} from './component-release';
import { knowledgeDigest } from './knowledge-evidence';
import { canonical } from './support-openrouter-model';
import {
  recordSupportFollowupRelease,
  supportFollowupReleaseObservationKey,
  supportFollowupReleaseFingerprint,
  supportFollowupReleaseObservations,
} from './support-release-followup-releases';

const scalar = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[^\u0000-\u001f\u007f-\u009f]+$/u)
  .refine((value) => value.trim() === value);
const ordinal = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER - 1);
const command = z
  .string()
  .regex(
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu,
  );
// A staff disclosure is not a live GitHub/deployment observer. Only a new
// explicit verify command renews this original, bounded verification window.
export const SUPPORT_FOLLOWUP_MAPPING_VERIFICATION_MS = 3600000;
const ATTESTATION_MS = 300000;
const coordinates = {
  commandId: command,
  expectedPrincipalId: scalar,
  expectedTicketRevision: ordinal.min(1),
  expectedMappingGeneration: ordinal,
  repositoryId: scalar,
  issueId: scalar,
};
export const verifySupportFollowupMappingInput = z
  .object({
    ...coordinates,
    releaseRef: scalar,
    issueState: z.enum(['open', 'closed']),
    deploymentState: z.enum(['unknown', 'deployed', 'rolled_back']),
    fixedProduct: z
      .object({ productId: scalar, version: scalar, buildId: scalar })
      .strict(),
    deploymentId: scalar,
    deploymentEpoch: scalar,
    scopeRef: scalar,
    verificationReference: scalar,
    publicFacts: z
      .array(
        z
          .object({
            reference: scalar,
            text: z
              .string()
              .min(1)
              .max(1000)
              .regex(
                /^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]+$/u,
              ),
          })
          .strict(),
      )
      .min(1)
      .max(4)
      .refine(
        (values) =>
          new Set(values.map((value) => value.reference)).size ===
          values.length,
      ),
  })
  .strict();
export const withdrawSupportFollowupMappingInput = z
  .object({ ...coordinates, reason: scalar })
  .strict();
export type VerifySupportFollowupMappingInput = z.infer<
  typeof verifySupportFollowupMappingInput
>;
export type WithdrawSupportFollowupMappingInput = z.infer<
  typeof withdrawSupportFollowupMappingInput
>;
const bindingSchema = z
  .object({
    ticketId: scalar,
    repositoryId: scalar,
    issueId: scalar,
    issueNumber: ordinal.min(1),
    dispatchId: scalar,
    requestHash: scalar,
    engineeringSourceGeneration: ordinal.min(1),
    followupRevocationEpoch: ordinal,
    productBinding: scalar,
    productId: scalar,
    policyHash: scalar,
  })
  .strict();
type AcceptedBinding = z.infer<typeof bindingSchema>;
const headSchema = z
  .object({
    kind: z.literal('mapping'),
    ticketId: scalar,
    id: scalar,
    generation: ordinal.min(1),
    actorId: scalar,
    verifiedAt: z.string().datetime({ precision: 3 }),
    inputReference: scalar,
    packet: verifySupportFollowupMappingInput,
    binding: bindingSchema,
    releaseEpoch: ordinal.min(1),
    releaseJournalVersion: z.literal(2).optional(),
    withdrawn: z.boolean(),
  })
  .strict();
type Head = z.infer<typeof headSchema>;
export interface SupportFollowupMappingReceipt {
  readonly actorId: string;
  readonly ticketId: string;
  readonly commandId: string;
  readonly mappingGeneration: number;
  readonly inputReference: string;
}
const receiptSchema = z
  .object({
    kind: z.literal('receipt'),
    ticketId: scalar,
    id: scalar,
    actorId: scalar,
    commandId: command,
    requestHash: z.string().regex(/^[a-f0-9]{64}$/u),
    result: z
      .object({
        actorId: scalar,
        ticketId: scalar,
        commandId: command,
        mappingGeneration: ordinal.min(1),
        inputReference: scalar,
      })
      .strict(),
  })
  .strict();
type Receipt = z.infer<typeof receiptSchema>;
type Record =
  | Head
  | Receipt
  | {
      readonly kind: 'audit';
      readonly ticketId: string;
      readonly id: string;
      readonly event: AuditEvent;
    };
export const supportFollowupMappings = defineCollection<Record>({
  name: 'pegma.support-followup-mappings.v1',
  key: (value) => ({ partition: value.ticketId, id: value.id }),
  codec: {
    encode(value): StoredRecord {
      if (value.kind === 'audit')
        return {
          kind: 'audit',
          ticketId: value.ticketId,
          id: value.id,
          ...encodeAuditEvent(value.event),
        };
      const checked =
        value.kind === 'mapping'
          ? headSchema.parse(value)
          : receiptSchema.parse(value);
      const payload = JSON.stringify(checked);
      if (new TextEncoder().encode(payload).length > 24000)
        throw new TypeError('Mapping record exceeded');
      return {
        kind: checked.kind,
        ticketId: checked.ticketId,
        id: checked.id,
        payload,
      };
    },
    decode(row) {
      if (row.kind === 'audit') {
        const event = decodeAuditEvent(row);
        if (
          event.subject !== row.ticketId ||
          auditRecordId(event.id) !== row.id
        )
          throw new TypeError('Invalid mapping audit');
        return {
          kind: 'audit',
          ticketId: String(row.ticketId),
          id: String(row.id),
          event,
        };
      }
      if (
        typeof row.payload !== 'string' ||
        new TextEncoder().encode(row.payload).length > 24000
      )
        throw new TypeError('Invalid mapping record');
      const value =
        row.kind === 'mapping'
          ? headSchema.parse(JSON.parse(row.payload))
          : receiptSchema.parse(JSON.parse(row.payload));
      if (
        value.kind !== row.kind ||
        value.ticketId !== row.ticketId ||
        value.id !== row.id
      )
        throw new TypeError('Invalid mapping identity');
      return value;
    },
  },
});
const audit = defineAudit<Record>({
  collection: supportFollowupMappings,
  toRecord: (event) => ({
    kind: 'audit',
    ticketId: event.subject,
    id: auditRecordId(event.id),
    event,
  }),
  toEvent: (record) => (record.kind === 'audit' ? record.event : null),
});
export interface SupportFollowupMappingOptions {
  readonly store: Store;
  readonly clock: Clock;
  readonly application: () => SupportRuntime['application'];
  readonly resolvePrincipal: (id: string) => Promise<AccessContext | null>;
  readonly allowedRepositoryIds: () => ReadonlySet<string>;
  readonly enabled: () => boolean;
}

/** A current staff verification is retained data, not a model/privacy/retest claim. */
export function createSupportFollowupMappings(
  options: SupportFollowupMappingOptions,
) {
  const records = options.store.collection(supportFollowupMappings);
  const releases = options.store.collection(componentReleaseCollection());
  const observations = options.store.collection(
    supportFollowupReleaseObservations,
  );
  function verificationCurrent(head: Head) {
    const verified = Date.parse(head.verifiedAt);
    const now = Date.parse(options.clock.now());
    return (
      Number.isFinite(now) &&
      now >= verified &&
      now < verified + SUPPORT_FOLLOWUP_MAPPING_VERIFICATION_MS
    );
  }
  async function key(ticketId: string, repositoryId: string, issueId: string) {
    return {
      partition: ticketId,
      id:
        'mapping:' + (await knowledgeDigest([ticketId, repositoryId, issueId])),
    };
  }
  function enabled(signal?: AbortSignal) {
    if (!options.enabled() || signal?.aborted)
      throw new ApiError(503, 'followup_mapping_unavailable');
  }
  async function authority(
    context: SupportReleaseFollowupContext,
    expected?: string,
  ) {
    enabled(context.signal);
    const access = await context.current();
    enabled(context.signal);
    context.assertCurrent();
    if (expected !== undefined && access.principalId !== expected)
      throw new ApiError(403, 'forbidden');
    if (
      !access.roles.includes(SUPPORT_ROLE) ||
      !hasPermission(
        access,
        supportPermissions.engineeringFollowupEvidenceSubmit,
      ) ||
      !hasPermission(access, supportPermissions.queueRead)
    )
      throw new ApiError(403, 'forbidden');
    return access;
  }
  async function accepted(
    access: AccessContext,
    ticketId: string,
    repositoryId: string,
    issueId: string,
  ): Promise<AcceptedBinding> {
    if (!options.allowedRepositoryIds().has(repositoryId))
      throw new ApiError(409, 'followup_repository_unavailable');
    const app = options.application();
    const source = await app.readEngineeringSource(access, ticketId);
    const destination = source.destinations.find(
      (value) =>
        value.repositoryId === repositoryId &&
        value.outcome === 'accepted' &&
        value.acknowledgement?.issueId === issueId,
    );
    if (
      source.state === 'withdrawn' ||
      !source.product ||
      !destination?.dispatchId ||
      !destination.acknowledgement
    )
      throw new ApiError(409, 'followup_association_unavailable');
    const policy = await app.readRepositoryPolicy(access);
    if (
      !policy.policy.enabled ||
      !policy.policy.repositories.some(
        (value) => value.repositoryId === repositoryId && value.enabled,
      )
    )
      throw new ApiError(409, 'followup_repository_unavailable');
    return {
      ticketId,
      repositoryId,
      issueId,
      issueNumber: destination.acknowledgement.issueNumber,
      dispatchId: destination.dispatchId,
      requestHash: destination.requestHash,
      engineeringSourceGeneration: destination.sourceGeneration,
      followupRevocationEpoch:
        destination.followupRevocationEpoch ??
        source.followupRevocationEpoch ??
        0,
      productBinding: source.product.binding,
      productId: source.product.productId,
      policyHash: policy.policyHash,
    };
  }
  function replay(
    value: Record | null,
    actorId: string,
    commandId: string,
    requestHash: string,
  ) {
    if (!value) return undefined;
    if (
      value.kind !== 'receipt' ||
      value.actorId !== actorId ||
      value.commandId !== commandId ||
      value.requestHash !== requestHash
    )
      throw new ApiError(409, 'conflict');
    return value.result;
  }
  async function write(
    context: SupportReleaseFollowupContext,
    ticketId: string,
    input:
      VerifySupportFollowupMappingInput | WithdrawSupportFollowupMappingInput,
    withdrawn: boolean,
  ): Promise<SupportFollowupMappingReceipt> {
    const packet = withdrawn
      ? withdrawSupportFollowupMappingInput.parse(structuredClone(input))
      : verifySupportFollowupMappingInput.parse(structuredClone(input));
    const access = await authority(context, packet.expectedPrincipalId);
    const actorId = access.principalId;
    const requestHash = await knowledgeDigest({ ticketId, withdrawn, packet });
    const commandHash = await knowledgeDigest([actorId, packet.commandId]);
    const receiptKey = { partition: ticketId, id: 'receipt:' + commandHash };
    const known = replay(
      await records.get(receiptKey),
      actorId,
      packet.commandId,
      requestHash,
    );
    if (known) {
      await authority(context, actorId);
      return known;
    }
    const headKey = await key(ticketId, packet.repositoryId, packet.issueId);
    const prior = await records.getVersioned(headKey);
    if (prior !== null && prior.value.kind !== 'mapping')
      throw new TypeError('Invalid mapping head');
    const old = prior?.value.kind === 'mapping' ? prior.value : undefined;
    if (
      (old?.generation ?? 0) !== packet.expectedMappingGeneration ||
      (withdrawn && !old)
    )
      throw new ApiError(409, 'conflict');
    const ticket = await options
      .application()
      .readStaffTicket(access, ticketId);
    if (ticket.ticket.revision !== packet.expectedTicketRevision)
      throw new ApiError(409, 'conflict');
    const binding = withdrawn
      ? old!.binding
      : await accepted(access, ticketId, packet.repositoryId, packet.issueId);
    const release = await releases.get(
      componentReleaseKey(packet.repositoryId),
    );
    const observation = withdrawn
      ? undefined
      : await recordSupportFollowupRelease(options.store, packet.repositoryId);
    const verified = withdrawn
      ? old!.packet
      : verifySupportFollowupMappingInput.parse(packet);
    if (
      !withdrawn &&
      (!release ||
        !observation ||
        observation.state !== 'active' ||
        release.releaseId !== verified.releaseRef ||
        observation.fingerprint !==
          (await supportFollowupReleaseFingerprint(release)) ||
        verified.fixedProduct.productId !== binding.productId)
    )
      throw new ApiError(409, 'followup_release_unavailable');
    const generation = (old?.generation ?? 0) + 1;
    if (!Number.isSafeInteger(generation)) throw new ApiError(409, 'conflict');
    const inputReference =
      'pgfix1.' + headKey.id.slice('mapping:'.length) + '.' + generation;
    const value: Head = {
      kind: 'mapping',
      ticketId,
      id: headKey.id,
      generation,
      actorId,
      verifiedAt: options.clock.now(),
      inputReference,
      packet: verified,
      binding,
      releaseEpoch: observation?.epoch ?? old!.releaseEpoch,
      releaseJournalVersion: 2,
      withdrawn,
    };
    const result: SupportFollowupMappingReceipt = {
      actorId,
      ticketId,
      commandId: packet.commandId,
      mappingGeneration: generation,
      inputReference,
    };
    const receipt: Receipt = {
      kind: 'receipt',
      ticketId,
      id: receiptKey.id,
      actorId,
      commandId: packet.commandId,
      requestHash,
      result,
    };
    // Keep all authority awaits before the mutation; the closing browser fence
    // is synchronous and no private text enters the Audit details.
    await authority(context, actorId);
    const freshTicket = await options
      .application()
      .readStaffTicket(access, ticketId);
    if (freshTicket.ticket.revision !== packet.expectedTicketRevision)
      throw new ApiError(409, 'conflict');
    if (
      !withdrawn &&
      canonical(
        await accepted(access, ticketId, packet.repositoryId, packet.issueId),
      ) !== canonical(binding)
    )
      throw new ApiError(409, 'followup_association_changed');
    await authority(context, actorId);
    context.assertCurrent();
    let unknown = false;
    let committed = false;
    try {
      const outcome = await records.transact(ticketId, [
        prior === null
          ? { action: 'insert', value }
          : { action: 'putIfUnchanged', value, version: prior.version },
        { action: 'insert', value: receipt },
        audit.action({
          id: 'followup-mapping:' + commandHash,
          occurredAt: value.verifiedAt,
          actor: { kind: 'principal', principalId: actorId },
          action: withdrawn
            ? 'support.release_followup.mapping.withdrawn'
            : 'support.release_followup.mapping.verified',
          subject: ticketId,
          sequence: generation,
          details: {
            repositoryId: packet.repositoryId,
            issueId: packet.issueId,
            mappingGeneration: generation,
            releaseEpoch: value.releaseEpoch,
          },
        }),
      ]);
      committed = outcome.committed;
    } catch {
      unknown = true;
      // An unknown ACK can follow all three atomic writes. Read only the exact
      // immutable command receipt; never try another mutation automatically.
    }
    if (committed) {
      await authority(context, actorId);
      return result;
    }
    const acceptedReceipt = replay(
      await records.get(receiptKey),
      actorId,
      packet.commandId,
      requestHash,
    );
    if (acceptedReceipt) {
      await authority(context, actorId);
      return acceptedReceipt;
    }
    throw new ApiError(
      unknown ? 503 : 409,
      unknown ? 'followup_mapping_unknown' : 'conflict',
    );
  }
  async function facts(
    head: Head,
    proof: EngineeringFollowupProofContext,
    signal: AbortSignal,
  ): Promise<VerifiedEngineeringFollowupContext | null> {
    try {
      enabled(signal);
      if (!verificationCurrent(head)) return null;
      const access = await options.resolvePrincipal(head.actorId);
      if (
        !access ||
        !access.roles.includes(SUPPORT_ROLE) ||
        !hasPermission(
          access,
          supportPermissions.engineeringFollowupEvidenceSubmit,
        )
      )
        return null;
      // The SDK supplies its freshly authenticated accepted-association
      // context and checks the affected product itself. Match every immutable
      // coordinate rather than re-reading that same private Source protocol.
      const live = head.binding;
      if (!options.allowedRepositoryIds().has(live.repositoryId)) return null;
      const policy = await options.application().readRepositoryPolicy(access);
      if (
        !policy.policy.enabled ||
        policy.policyHash !== live.policyHash ||
        !policy.policy.repositories.some(
          (value) => value.repositoryId === live.repositoryId && value.enabled,
        )
      )
        return null;
      if (
        proof.ticketRevision < head.packet.expectedTicketRevision ||
        canonical(proof.association) !==
          canonical({
            ticketId: head.ticketId,
            repositoryId: live.repositoryId,
            issueId: live.issueId,
            issueNumber: live.issueNumber,
            dispatchId: live.dispatchId,
            requestHash: live.requestHash,
            engineeringSourceGeneration: live.engineeringSourceGeneration,
            followupRevocationEpoch: live.followupRevocationEpoch,
          })
      )
        return null;
      const [release, observed] = await Promise.all([
        releases.get(componentReleaseKey(live.repositoryId)),
        observations.get(
          supportFollowupReleaseObservationKey(live.repositoryId),
        ),
      ]);
      const releaseCurrent =
        release &&
        head.releaseJournalVersion === 2 &&
        observed?.state === 'active' &&
        observed.epoch === head.releaseEpoch &&
        release.releaseId === head.packet.releaseRef &&
        observed.fingerprint ===
          (await supportFollowupReleaseFingerprint(release));
      const deploymentState =
        !head.withdrawn && releaseCurrent
          ? head.packet.deploymentState
          : 'unknown';
      const deploymentGeneration =
        head.generation + (observed?.epoch ?? head.releaseEpoch);
      if (!Number.isSafeInteger(deploymentGeneration)) return null;
      const issueHash = await knowledgeDigest([
        head.inputReference,
        live,
        head.packet.issueState,
      ]);
      const deploymentHash = await knowledgeDigest([
        head.inputReference,
        observed?.epoch,
        head.packet,
        deploymentState,
      ]);
      const headKey = await key(head.ticketId, live.repositoryId, live.issueId);
      const [fresh, currentActor, closingRelease, closingObservation] =
        await Promise.all([
          records.get(headKey),
          options.resolvePrincipal(head.actorId),
          releases.get(componentReleaseKey(live.repositoryId)),
          observations.get(
            supportFollowupReleaseObservationKey(live.repositoryId),
          ),
        ]);
      if (
        canonical(closingRelease) !== canonical(release) ||
        canonical(closingObservation) !== canonical(observed)
      )
        return null;
      enabled(signal);
      if (
        !verificationCurrent(head) ||
        !currentActor ||
        canonical(currentActor) !== canonical(access) ||
        fresh?.kind !== 'mapping' ||
        canonical(fresh) !== canonical(head)
      )
        return null;
      const at = options.clock.now();
      return {
        context: {
          issueHead: {
            repositoryId: live.repositoryId,
            issueId: live.issueId,
            issueNumber: live.issueNumber,
            generation: head.generation,
            hash: issueHash,
            state: head.packet.issueState,
          },
          deploymentHead: {
            contextRef: 'pg-staff-followup:' + head.id.slice(8),
            generation: deploymentGeneration,
            hash: deploymentHash,
            state: deploymentState,
            deploymentEpoch: head.packet.deploymentEpoch,
          },
          ...(deploymentState !== 'deployed' ||
          head.packet.issueState !== 'closed'
            ? {}
            : {
                mapping: {
                  semanticMappingId: head.id,
                  mappingId: head.id,
                  mappingVersion: 'staff-mapping-v1/' + head.generation,
                  affectedProductBinding: live.productBinding,
                  fixedProduct: head.packet.fixedProduct,
                  releaseRef:
                    'github-release:' +
                    live.repositoryId +
                    ':' +
                    head.packet.releaseRef,
                  deploymentId: head.packet.deploymentId,
                  scopeRef: head.packet.scopeRef,
                  issueHeadHash: issueHash,
                  deploymentHeadHash: deploymentHash,
                  verification: {
                    kind: 'staff_verified',
                    reference: head.packet.verificationReference,
                    actorId: head.actorId,
                  },
                },
              }),
        },
        publicFacts:
          deploymentState === 'deployed' ? head.packet.publicFacts : [],
        // Reading retained staff facts never renews the original disclosure.
        attestation: {
          verifierReceiptId: head.inputReference,
          verifierVersion: 'pg-staff-release-mapping-v1',
          verifiedAt: at,
          validUntil: new Date(
            Math.min(
              Date.parse(at) + ATTESTATION_MS,
              Date.parse(head.verifiedAt) +
                SUPPORT_FOLLOWUP_MAPPING_VERIFICATION_MS,
            ),
          ).toISOString(),
        },
      };
    } catch {
      return null;
    }
  }
  const releaseEvidence: EngineeringFollowupReleaseEvidencePort = {
    async verifyInput(reference, proof, signal) {
      try {
        enabled(signal);
      } catch {
        return null;
      }
      const value = await records.get(
        await key(
          proof.ticketId,
          proof.association.repositoryId,
          proof.association.issueId,
        ),
      );
      return value?.kind === 'mapping' && value.inputReference === reference
        ? facts(value, proof, signal)
        : null;
    },
    async confirm(_binding, proof, signal) {
      try {
        enabled(signal);
      } catch {
        return null;
      }
      const value = await records.get(
        await key(
          proof.ticketId,
          proof.association.repositoryId,
          proof.association.issueId,
        ),
      );
      return value?.kind === 'mapping' ? facts(value, proof, signal) : null;
    },
  };
  return Object.freeze({
    releaseEvidence,
    verify: (
      context: SupportReleaseFollowupContext,
      ticketId: string,
      input: VerifySupportFollowupMappingInput,
    ) => write(context, ticketId, input, false),
    withdraw: (
      context: SupportReleaseFollowupContext,
      ticketId: string,
      input: WithdrawSupportFollowupMappingInput,
    ) => write(context, ticketId, input, true),
    async choices(context: SupportReleaseFollowupContext, ticketId: string) {
      const access = await authority(context);
      const app = options.application();
      const source = await app.readEngineeringSource(access, ticketId);
      const policy = await app.readRepositoryPolicy(access);
      const ticket = await app.readStaffTicket(access, ticketId);
      const allowed = options.allowedRepositoryIds();
      const seen = new Set<string>();
      const choices = [];
      for (const destination of source.destinations) {
        const ack = destination.acknowledgement;
        const descriptor = policy.policy.repositories.find(
          (value) =>
            value.repositoryId === destination.repositoryId && value.enabled,
        );
        if (
          !source.product ||
          source.state === 'withdrawn' ||
          !policy.policy.enabled ||
          destination.outcome !== 'accepted' ||
          !ack ||
          !destination.dispatchId ||
          !descriptor ||
          !allowed.has(destination.repositoryId)
        )
          continue;
        const identity = JSON.stringify([
          destination.repositoryId,
          ack.issueId,
        ]);
        if (seen.has(identity)) continue;
        seen.add(identity);
        if (choices.length < 16)
          choices.push({
            repositoryId: destination.repositoryId,
            issueId: ack.issueId,
            issueNumber: ack.issueNumber,
            repositoryName: descriptor.owner + '/' + descriptor.name,
            product: {
              productId: source.product.productId,
              version: source.product.version,
              buildId: source.product.buildId,
            },
          });
      }
      await authority(context, access.principalId);
      return {
        actorId: access.principalId,
        ticketId,
        ticketRevision: ticket.ticket.revision,
        choices,
        hasMore: seen.size > choices.length,
      };
    },
    async read(
      context: SupportReleaseFollowupContext,
      ticketId: string,
      repositoryId: string,
      issueId: string,
    ) {
      const access = await authority(context);
      const binding = await accepted(access, ticketId, repositoryId, issueId);
      const ticket = await options
        .application()
        .readStaffTicket(access, ticketId);
      const value = await records.get(
        await key(ticketId, repositoryId, issueId),
      );
      const head = value?.kind === 'mapping' ? value : undefined;
      const [release, observation, mapper] = await Promise.all([
        releases.get(componentReleaseKey(repositoryId)),
        observations.get(supportFollowupReleaseObservationKey(repositoryId)),
        head === undefined
          ? Promise.resolve(null)
          : options.resolvePrincipal(head.actorId),
      ]);
      const currentRelease =
        release === null
          ? undefined
          : await supportFollowupReleaseFingerprint(release);
      await authority(context, access.principalId);
      return {
        actorId: access.principalId,
        ticketId,
        ticketRevision: ticket.ticket.revision,
        repositoryId,
        issueId,
        issueNumber: binding.issueNumber,
        mappingGeneration: head?.generation ?? 0,
        mapping: head
          ? {
              inputReference: head.inputReference,
              verifiedBy: head.actorId,
              verifiedAt: head.verifiedAt,
              verificationValidUntil: new Date(
                Date.parse(head.verifiedAt) +
                  SUPPORT_FOLLOWUP_MAPPING_VERIFICATION_MS,
              ).toISOString(),
              issueState: head.packet.issueState,
              deploymentState: head.packet.deploymentState,
              fixedProduct: head.packet.fixedProduct,
              releaseRef: head.packet.releaseRef,
              deploymentId: head.packet.deploymentId,
              deploymentEpoch: head.packet.deploymentEpoch,
              scopeRef: head.packet.scopeRef,
              verificationReference: head.packet.verificationReference,
              publicFacts: head.packet.publicFacts,
              withdrawn: head.withdrawn,
              current:
                !head.withdrawn &&
                verificationCurrent(head) &&
                head.releaseJournalVersion === 2 &&
                mapper !== null &&
                mapper.roles.includes(SUPPORT_ROLE) &&
                hasPermission(
                  mapper,
                  supportPermissions.engineeringFollowupEvidenceSubmit,
                ) &&
                observation?.epoch === head.releaseEpoch &&
                observation.state === 'active' &&
                release?.releaseId === head.packet.releaseRef &&
                observation.fingerprint === currentRelease &&
                canonical(binding) === canonical(head.binding),
            }
          : null,
        release: release
          ? {
              releaseRef: release.releaseId,
              repositoryName: release.repositoryName,
              tagName: release.tagName,
              publishedAt: release.publishedAt,
              releaseUrl: release.releaseUrl,
            }
          : null,
      };
    },
  });
}
export type SupportFollowupMappings = ReturnType<
  typeof createSupportFollowupMappings
>;
