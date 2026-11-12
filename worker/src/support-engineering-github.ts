import type { Clock } from '@pegma/spine';
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
  if (
    !object(value) ||
    !integer(value.id) ||
    !integer(value.number) ||
    Object.hasOwn(value, 'pull_request') ||
    !text(value.title) ||
    !prose(value.body, 12_000) ||
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
    body: value.body,
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
async function proof(value: unknown) {
  // Correlation receipt only, never a signature or a remote attestation of the
  // private request hash. Application supplies and verifies the durable binding.
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
) {
  if (!validIdentity(input)) throw error();
  let current: EngineeringDuplicateIssue;
  if (input.operation === 'link_existing_issue') {
    current = issue(await session.issue(input.issueNumber!), session);
    if (
      current.issueId !== input.issueId ||
      current.issueNumber !== input.issueNumber
    )
      throw error();
  } else {
    // Search is eventually indexed; no/partial/multiple matches prove nothing.
    const found = searchEnvelope(
      await session.search(
        prefix(session) + 'in:body "' + input.exportMarker + '"',
        5,
      ),
      5,
    );
    if (found.total !== 1 || found.items.length !== 1) throw error();
    const candidate = issue(found.items[0], session);
    const remote = await session.issue(candidate.issueNumber);
    current = issue(remote, session);
    if (
      current.issueId !== candidate.issueId ||
      !uniqueMarker(current.body, input.exportMarker) ||
      !appCreated(remote, session)
    )
      throw error();
  }
  const receipt = await proof([
    input,
    acknowledgement(current),
    session.repository,
  ]);
  session.current();
  return { acknowledgement: acknowledgement(current), proof: receipt };
}

/** Only the factory's bounded, current-authority transport is used here. */
export function createSupportEngineeringIssueOperations(
  within: SupportEngineeringRepositoryOperation,
  clock: Clock,
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
          const issues = response.items.map((value) => issue(value, session));
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
      const observed = await within(
        request.repository.repositoryId,
        context,
        async (session) => {
          if (!sameRepository(request.repository, session.repository))
            throw error();
          // The transport mints an exact-ID credential and makes one issue POST.
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
          const labels = response.labels.map((label: unknown) =>
            typeof label === 'string'
              ? label
              : object(label)
                ? label.name
                : undefined,
          );
          if (
            labels.length !== request.bundle.labels.length ||
            new Set(labels).size !== labels.length ||
            labels.some(
              (label) =>
                typeof label !== 'string' ||
                !request.bundle.labels.includes(label),
            )
          )
            throw error();
          return acknowledgement(created);
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
          (session) => observeAcceptance(snapshot, session),
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
            );
            if (
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
