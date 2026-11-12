import type { Clock } from '@pegma/spine';
import { canonical } from './support-openrouter-model';
import type {
  EngineeringCreationBinding,
  EngineeringCreationReceipt,
  EngineeringCreationReceiptPort,
} from './support-engineering-acceptance';
import type {
  EngineeringDispatchProofBinding,
  EngineeringDispatchResultVerifier,
  EngineeringIssueAcknowledgement,
  EngineeringRepositoryObservation,
} from '@pegma/support-desk-application';
import type {
  EngineeringDuplicateIssue,
  EngineeringExternalContext,
  EngineeringGitHubPort,
} from '@pegma/support-desk-ai';

/** Internal transport capability: no credential or arbitrary URL escapes it. */
export interface SupportEngineeringRepositorySession {
  readonly repository: EngineeringRepositoryObservation;
  readonly path: string;
  readonly appId: string;
  readonly installationId: string;
  readonly installationBinding: string;
  readonly signal: AbortSignal;
  readonly appSlug: string | null;
  current(): void;
  search(query: string, limit: number): Promise<unknown>;
  issue(number: number): Promise<unknown>;
  create(body: string): Promise<unknown>;
}
export type SupportEngineeringRepositoryOperation = <Value>(
  repositoryId: string,
  context: EngineeringExternalContext,
  use: (session: SupportEngineeringRepositorySession) => Promise<Value>,
) => Promise<{ readonly value: Value; readonly validUntil: string } | null>;

type ReconciliationInput = Parameters<EngineeringGitHubPort['reconcile']>[0];
const encoder = new TextEncoder();
const markerPattern = /^pegma-engineering:[a-f0-9]{48}$/u;
const hashPattern = /^[a-f0-9]{64}$/u;
const error = () => new Error('Engineering GitHub is unavailable');
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function text(value: unknown, maximum = 200): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximum &&
    /^[^\u0000-\u001F\u007F]+$/u.test(value)
  );
}
function prose(value: unknown, maximum: number): value is string {
  return (
    typeof value === 'string' &&
    value.length <= maximum &&
    !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(value)
  );
}
function integer(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
function numericId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[1-9][0-9]{0,15}$/u.test(value) &&
    Number.isSafeInteger(Number(value))
  );
}
function sameRepository(
  left: EngineeringRepositoryObservation,
  right: EngineeringRepositoryObservation,
) {
  return [
    'repositoryId',
    'owner',
    'name',
    'visibility',
    'installationBinding',
    'metadataVersion',
  ].every((field) => Reflect.get(left, field) === Reflect.get(right, field));
}
function uniqueMarker(body: string, marker: string) {
  const matches = [
    ...body.matchAll(
      /(?:^|[^A-Za-z0-9_:-])(pegma-engineering:[a-f0-9]{48})(?![A-Za-z0-9_:-])/gu,
    ),
  ];
  return (
    markerPattern.test(marker) &&
    matches.length === 1 &&
    matches[0]![1] === marker
  );
}
function issue(
  value: unknown,
  session: SupportEngineeringRepositorySession,
): EngineeringDuplicateIssue {
  if (!object(value)) throw error();
  const body = value.body === null ? '' : value.body;
  if (
    !integer(value.id) ||
    !integer(value.number) ||
    Object.hasOwn(value, 'pull_request') ||
    !text(value.title, 65_536) ||
    !prose(body, 65_536) ||
    value.repository_url !== session.path ||
    value.url !== session.path + '/issues/' + value.number ||
    value.html_url !==
      'https://github.com/' +
        session.repository.owner +
        '/' +
        session.repository.name +
        '/issues/' +
        value.number ||
    (value.state !== 'open' && value.state !== 'closed')
  )
    throw error();
  return Object.freeze({
    repositoryId: session.repository.repositoryId,
    issueId: String(value.id),
    issueNumber: value.number,
    title: value.title,
    body,
  });
}
function acknowledgement(
  value: EngineeringDuplicateIssue,
): EngineeringIssueAcknowledgement {
  return Object.freeze({
    repositoryId: value.repositoryId,
    issueId: value.issueId,
    issueNumber: value.issueNumber,
  });
}
function appCreated(
  value: unknown,
  session: SupportEngineeringRepositorySession,
) {
  return (
    session.appSlug !== null &&
    object(value) &&
    object(value.performed_via_github_app) &&
    value.performed_via_github_app.id === Number(session.appId) &&
    value.performed_via_github_app.slug === session.appSlug &&
    object(value.user) &&
    value.user.type === 'Bot' &&
    integer(value.user.id) &&
    value.user.login === session.appSlug + '[bot]'
  );
}
function searchEnvelope(value: unknown, maximum: number) {
  if (
    !object(value) ||
    value.incomplete_results !== false ||
    !Number.isSafeInteger(value.total_count) ||
    typeof value.total_count !== 'number' ||
    value.total_count < 0 ||
    !Array.isArray(value.items) ||
    value.items.length > maximum ||
    value.items.length > value.total_count ||
    value.items.length !== Math.min(value.total_count, maximum)
  )
    throw error();
  return { total: value.total_count, items: value.items };
}
function prefix(session: SupportEngineeringRepositorySession) {
  return (
    'repo:' +
    session.repository.owner +
    '/' +
    session.repository.name +
    ' is:issue '
  );
}
function validIdentity(input: ReconciliationInput) {
  return (
    text(input.dispatchId) &&
    hashPattern.test(input.requestHash) &&
    markerPattern.test(input.exportMarker) &&
    input.sourceFence !== undefined &&
    text(input.sourceFence.ticketId) &&
    integer(input.sourceFence.sourceGeneration) &&
    hashPattern.test(input.sourceFence.sourceBindingHash) &&
    typeof input.repositoryMetadataHash === 'string' &&
    hashPattern.test(input.repositoryMetadataHash) &&
    (input.operation === 'create_issue' ||
      input.operation === 'link_existing_issue') &&
    (input.operation === 'create_issue'
      ? input.issueId === undefined && input.issueNumber === undefined
      : numericId(input.issueId) && integer(input.issueNumber))
  );
}
async function fingerprint(value: unknown): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', encoder.encode(canonical(value))),
  );
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
function normalizedLabels(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > 32) throw error();
  const labels = value.map((label: unknown) => {
    const name = typeof label === 'string'
      ? label
      : object(label)
        ? label.name
        : undefined;
    if (!text(name, 100)) throw error();
    return name.normalize('NFC').toLowerCase();
  });
  return [...new Set(labels)].sort();
}
function creationBinding(
  input: ReconciliationInput,
  session: SupportEngineeringRepositorySession,
): EngineeringCreationBinding {
  if (
    input.sourceFence === undefined ||
    input.repositoryMetadataHash === undefined
  )
    throw error();
  return {
    repositoryId: input.repositoryId,
    dispatchId: input.dispatchId,
    requestHash: input.requestHash,
    repositoryMetadataHash: input.repositoryMetadataHash,
    exportMarker: input.exportMarker,
    sourceFence: structuredClone(input.sourceFence),
    appId: session.appId,
    installationId: session.installationId,
    installationBinding: session.installationBinding,
  };
}
function issueUrl(
  value: EngineeringIssueAcknowledgement,
  session: SupportEngineeringRepositorySession,
) {
  return 'https://github.com/' + session.repository.owner + '/' +
    session.repository.name + '/issues/' + value.issueNumber;
}
async function proof(value: unknown) {
  // Correlation digest; create acceptance additionally requires a durable known
  // provider-ACK receipt, never an editable search marker or App origin alone.
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      'SHA-256',
      encoder.encode(JSON.stringify(value)),
    ),
  );
  return (
    'github-observation:' +
    [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  );
}
async function observeAcceptance(
  input: ReconciliationInput,
  session: SupportEngineeringRepositorySession,
  creationReceipts: EngineeringCreationReceiptPort | undefined,
) {
  if (!validIdentity(input)) throw error();
  let current: EngineeringDuplicateIssue;
  let creation: EngineeringCreationReceipt | null = null;
  if (input.operation === 'link_existing_issue') {
    current = issue(await session.issue(input.issueNumber!), session);
    if (
      current.issueId !== input.issueId ||
      current.issueNumber !== input.issueNumber
    )
      throw error();
  } else {
    const binding = creationBinding(input, session);
    const stored = await creationReceipts?.read(binding, session.signal);
    if (stored === undefined || stored === null) throw error();
    creation = structuredClone(stored);
    if (
      canonical(creation.binding) !== canonical(binding) ||
      !hashPattern.test(creation.payloadHash) ||
      !text(creation.proof)
    )
      throw error();
    session.current();
    const remote = await session.issue(creation.acknowledgement.issueNumber);
    current = issue(remote, session);
    const expected = creation.acknowledgement;
    if (
      expected.repositoryId !== current.repositoryId ||
      expected.issueId !== current.issueId ||
      expected.issueNumber !== current.issueNumber ||
      expected.url !== issueUrl(current, session) ||
      !appCreated(remote, session)
    )
      throw error();
  }
  const receipt = await proof([
    input,
    acknowledgement(current),
    session.repository,
    creation?.proof ?? null,
    creation?.payloadHash ?? null,
  ]);
  session.current();
  return { acknowledgement: acknowledgement(current), proof: receipt };
}

/** Only the factory's bounded, current-authority transport is used here. */
export function createSupportEngineeringIssueOperations(
  within: SupportEngineeringRepositoryOperation,
  clock: Clock,
  creationReceipts?: EngineeringCreationReceiptPort,
): {
  readonly github: Omit<EngineeringGitHubPort, 'getMetadata'>;
  readonly dispatchResults: EngineeringDispatchResultVerifier;
} {
  const github: Omit<EngineeringGitHubPort, 'getMetadata'> = {
    async searchDuplicates(input, context) {
      const snapshot = structuredClone(input);
      // Only ordinary trusted search terms: no qualifiers/boolean expression can
      // escape the immutable repository and issue-only scope we add ourselves.
      if (
        !text(snapshot.query, 256) ||
        snapshot.query.trim() !== snapshot.query ||
        !/^[\p{L}\p{N}][\p{L}\p{N} _.-]*$/u.test(snapshot.query) ||
        snapshot.query
          .split(/\s+/u)
          .some((term) => /^(?:and|or|not)$/iu.test(term)) ||
        !integer(snapshot.limit) ||
        snapshot.limit > 5
      )
        throw error();
      const observed = await within(
        snapshot.repositoryId,
        context,
        async (session) => {
          const response = searchEnvelope(
            await session.search(
              prefix(session) + 'in:title,body ' + snapshot.query,
              snapshot.limit,
            ),
            snapshot.limit,
          );
          const issues = response.items.map((value) => {
            const observed = issue(value, session);
            return Object.freeze({
              ...observed,
              // Display context only; immutable coordinates govern an approved link.
              title: observed.title.slice(0, 200),
              body: observed.body.slice(0, 12_000),
            });
          });
          if (
            new Set(issues.map((value) => value.issueId)).size !==
              issues.length ||
            new Set(issues.map((value) => value.issueNumber)).size !==
              issues.length
          )
            throw error();
          return Object.freeze({
            issues: Object.freeze(issues),
            physicalResults: response.items.length,
          });
        },
      );
      if (observed === null) throw error();
      return observed.value;
    },
    async createIssue(input, context) {
      if (
        creationReceipts === undefined ||
        typeof creationReceipts.prepare !== 'function' ||
        typeof creationReceipts.record !== 'function' ||
        typeof creationReceipts.read !== 'function'
      )
        throw error();
      const request = structuredClone(input);
      const bound = structuredClone({
        sourceFence: context.sourceFence,
        dispatchId: context.dispatchId,
        requestHash: context.requestHash,
      });
      if (
        request.operation !== 'create_issue' ||
        !text(bound.dispatchId) ||
        !hashPattern.test(bound.requestHash) ||
        !text(bound.sourceFence.ticketId) ||
        !integer(bound.sourceFence.sourceGeneration) ||
        !hashPattern.test(bound.sourceFence.sourceBindingHash) ||
        !text(request.bundle.title) ||
        !prose(request.bundle.body, 12_000) ||
        !uniqueMarker(request.bundle.body, request.bundle.exportMarker) ||
        !Array.isArray(request.bundle.labels) ||
        request.bundle.labels.length > 32 ||
        request.bundle.labels.some((label) => !text(label, 100)) ||
        new Set(request.bundle.labels).size !== request.bundle.labels.length
      )
        throw error();
      // The reviewed SDK bundle is sent unchanged. No private dispatch/fence/hash,
      // evidence reference, template metadata, or extra marker is appended.
      const body = JSON.stringify({
        title: request.bundle.title,
        body: request.bundle.body,
        labels: request.bundle.labels,
      });
      if (encoder.encode(body).byteLength > 24_000) throw error();
      const labels = normalizedLabels(request.bundle.labels);
      const [requestHash, repositoryMetadataHash, payloadHash] = await Promise.all([
        fingerprint(request),
        fingerprint(request.repository),
        fingerprint({ title: request.bundle.title, body: request.bundle.body, labels }),
      ]);
      if (requestHash !== bound.requestHash || context.signal.aborted) throw error();
      const observed = await within(
        request.repository.repositoryId,
        context,
        async (session) => {
          if (!sameRepository(request.repository, session.repository))
            throw error();
          const binding = creationBinding({
            repositoryId: request.repository.repositoryId,
            ...bound,
            repositoryMetadataHash,
            exportMarker: request.bundle.exportMarker,
            operation: 'create_issue',
          }, session);
          if (!(await creationReceipts.prepare(binding, session.signal)))
            throw error();
          session.current();
          // Only a first acknowledged durable intent can reach the one issue POST.
          const response = await session.create(body);
          const created = issue(response, session);
          if (
            created.title !== request.bundle.title ||
            created.body !== request.bundle.body ||
            !appCreated(response, session) ||
            !object(response) ||
            !Array.isArray(response.labels)
          )
            throw error();
          if (canonical(normalizedLabels(response.labels)) !== canonical(labels))
            throw error();
          const accepted = acknowledgement(created);
          if (!(await creationReceipts.record({
            binding,
            acknowledgement: { ...accepted, url: issueUrl(accepted, session) },
            payloadHash,
            recordedAt: clock.now(),
          }, session.signal)))
            throw error();
          session.current();
          return accepted;
        },
      );
      if (observed === null) throw error(); // POST may already have committed.
      return observed.value;
    },
    async reconcile(input, context) {
      try {
        const snapshot = structuredClone(input);
        if (!validIdentity(snapshot)) return { outcome: 'unknown' };
        const observed = await within(
          snapshot.repositoryId,
          context,
          (session) => observeAcceptance(snapshot, session, creationReceipts),
        );
        return observed === null
          ? { outcome: 'unknown' }
          : { outcome: 'accepted', ...observed.value };
      } catch {
        return { outcome: 'unknown' };
      }
    },
  };
  const dispatchResults: EngineeringDispatchResultVerifier = {
    async verify(input, signal) {
      try {
        const binding: EngineeringDispatchProofBinding = structuredClone(input);
        if (signal.aborted || binding.result.outcome !== 'accepted')
          return null;
        const at = clock.now();
        const until = Date.parse(at) + 10_000;
        if (
          !Number.isFinite(until) ||
          new Date(Date.parse(at)).toISOString() !== at
        )
          return null;
        const observed = await within(
          binding.repositoryId,
          {
            purpose: 'support_bug_assessment',
            signal,
            deadline: new Date(until).toISOString(),
          },
          async (session) => {
            const accepted = binding.result;
            if (accepted.outcome !== 'accepted') throw error();
            const ack = accepted.acknowledgement;
            if (
              !numericId(ack.issueId) ||
              !integer(ack.issueNumber) ||
              ack.repositoryId !== binding.repositoryId
            )
              throw error();
            const acceptance = await observeAcceptance(
              {
                repositoryId: binding.repositoryId,
                exportMarker: binding.exportMarker,
                dispatchId: binding.dispatchId,
                requestHash: binding.requestHash,
                operation: binding.operation,
                sourceFence: {
                  ticketId: binding.ticketId,
                  sourceGeneration: binding.sourceGeneration,
                  sourceBindingHash: binding.sourceBindingHash,
                },
                repositoryMetadataHash: binding.repositoryMetadataHash,
                ...(binding.operation === 'link_existing_issue'
                  ? { issueId: ack.issueId, issueNumber: ack.issueNumber }
                  : {}),
              },
              session,
              creationReceipts,
            );
            if (
              (ack.url !== undefined && ack.url !== issueUrl(ack, session)) ||
              acceptance.acknowledgement.issueId !== ack.issueId ||
              acceptance.acknowledgement.issueNumber !== ack.issueNumber
            )
              throw error();
            const receipt = await proof([
              binding,
              acceptance,
              session.repository,
            ]);
            session.current();
            return receipt;
          },
        );
        if (observed === null || signal.aborted) return null;
        return Object.freeze({
          binding,
          verifierReceiptId: observed.value,
          verifierVersion: 'github-issues-v1',
          verifiedAt: at,
          validUntil: new Date(
            Math.min(until, Date.parse(observed.validUntil)),
          ).toISOString(),
        });
      } catch {
        return null;
      }
    },
  };
  return Object.freeze({
    github: Object.freeze(github),
    dispatchResults: Object.freeze(dispatchResults),
  });
}
