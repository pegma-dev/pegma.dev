import { systemClock, type Clock } from '@pegma/spine';
import type {
  EngineeringOptions,
  EngineeringRepositoryDescriptor,
  EngineeringSanitizedBundle,
} from '@pegma/support-desk-application';
import type {
  EngineeringDuplicateIssue,
  EngineeringExternalContext,
  EngineeringProposalPort,
} from '@pegma/support-desk-ai';
import {
  createSupportEngineeringRepositoryPorts,
  type SupportEngineeringRepositoryOptions,
} from './support-engineering-repository';
import type { SupportEngineeringProcessingComposition } from './support-engineering-processing';
import type { SupportEngineeringReviewProofs } from './support-engineering';
import type { SupportRuntime } from './support-desk';
import {
  createSupportIndependentChecks,
  type SupportIndependentChecksOptions,
  type IndependentCheckPendingHint,
} from './support-independent-checks';
import { supportEngineeringApplicationOptions } from './support-engineering';
import {
  array,
  canonical,
  integer,
  object,
  scalar,
  text,
} from './support-openrouter-model';

type ProposalInput = Parameters<EngineeringProposalPort['prepare']>[0];
type Processing = NonNullable<
  SupportEngineeringProcessingComposition['configuration']
>;

/** Current server-local choices. References must already identify approved evidence;
 * this data never establishes privacy, factual, routing or reproduction approval. */
export interface SupportEngineeringProposalSettings extends Pick<
  EngineeringSanitizedBundle,
  'labels' | 'templateId' | 'evidenceReferences'
> {
  readonly duplicate?: Pick<
    EngineeringDuplicateIssue,
    'issueId' | 'issueNumber'
  >;
}
export interface SupportEngineeringLocalProposalOptions {
  /** Local trusted terms, never a report-derived or model-generated search. */
  readonly readDuplicateQuery: (
    descriptor: EngineeringRepositoryDescriptor,
  ) => string | null;
  /** Synchronous local policy only: no network, credential or private ticket lookup. */
  readonly readSettings: (
    input: ProposalInput,
  ) => SupportEngineeringProposalSettings | null;
}
export type SupportEngineeringSharedChecks = Pick<
  ReturnType<typeof createSupportIndependentChecks>,
  | 'resolvePolicy'
  | 'engineeringSdkVerifier'
  | 'engineeringFor'
  | 'precomputePending'
  | 'discardTicket'
>;

export interface SupportEngineeringProductionOptions {
  readonly clock?: Clock;
  /** Processing only; intake and repository reads/writes retain their own gates. */
  readonly enabled?: () => boolean;
  readonly configuration?: {
    readonly application?: Omit<
      EngineeringOptions,
      | 'productContext'
      | 'routing'
      | 'checks'
      | 'repositoryMetadata'
      | 'dispatchResults'
    >;
    readonly productContext: NonNullable<EngineeringOptions['productContext']>;
    readonly serviceAccess: Processing['ports']['serviceAccess'];
    readonly reconciliationAccess: Processing['ports']['reconciliationAccess'];
    readonly routing: Processing['ports']['routing'];
    readonly checks?: Processing['ports']['checks'];
    /** Root-owned shared pool, selected lazily for the exact App graph. Presence
     * takes precedence over private independentChecks and legacy bare checks;
     * an unready or failed controller never falls back to another authority. */
    readonly readChecks?: () => SupportEngineeringSharedChecks | undefined;
    /** Source-owned checker composition, never an HTTP-supplied bundle. It wins
     * over legacy checks when supplied; unready configuration cannot fall back. */
    readonly independentChecks?: Omit<
      SupportIndependentChecksOptions,
      | 'store'
      | 'clock'
      | 'application'
      | 'repositories'
      | 'knowledge'
      | 'knowledgeAccess'
      | 'deferred'
    >;
    readonly model: Processing['model'];
    readonly usagePolicy: Processing['usagePolicy'];
    /** The existing connector owns current installation/immutable-ID checks. */
    readonly repository: Omit<SupportEngineeringRepositoryOptions, 'clock'>;
    readonly proposals: SupportEngineeringLocalProposalOptions;
  };
}
export interface SupportEngineeringProductionComposition {
  readonly application: EngineeringOptions;
  readonly processing: SupportEngineeringProcessingComposition;
  readonly reviewProofs?: SupportEngineeringReviewProofs;
  /** One-time Store binding before constructing the existing App. App access
   * stays lazy and resolves that exact runtime application after construction. */
  readonly attachRuntime?: (
    runtime: Pick<SupportRuntime, 'store' | 'clock'> & {
      readonly application: () => SupportRuntime['application'];
    },
  ) => boolean;
  readonly discardChecks?: (ticketId: string) => Promise<void>;
}
const markerPattern = /^pegma-engineering:[a-f0-9]{48}$/u;
const markers =
  /(?:^|[^A-Za-z0-9_:-])(pegma-engineering:[a-f0-9]{48})(?![A-Za-z0-9_:-])/gu;
function exactMarker(body: string, expected: string): boolean {
  const found = [...body.matchAll(markers)];
  return found.length === 1 && found[0]![1] === expected;
}
const encoder = new TextEncoder();
function current(clock: Clock, context: EngineeringExternalContext): void {
  const now = Date.parse(clock.now());
  if (
    context.purpose !== 'support_bug_assessment' ||
    context.signal.aborted ||
    !Number.isFinite(now) ||
    !Number.isFinite(Date.parse(context.deadline)) ||
    now >= Date.parse(context.deadline)
  )
    throw new TypeError('Engineering proposal context expired');
}
function strings(value: unknown, limit: number, length = 200): string[] {
  const result = array(value, limit).map((entry) => scalar(entry, length));
  if (new Set(result).size !== result.length)
    throw new TypeError('Duplicate proposal value');
  return result;
}
function descriptor(value: EngineeringRepositoryDescriptor): void {
  object(value, [
    'repositoryId',
    'owner',
    'name',
    'visibility',
    'responsibilities',
    'product',
    'component',
    'version',
    'allowedLabels',
    'allowedTemplates',
    'publicationMode',
    'enabled',
  ]);
  for (const key of ['repositoryId', 'owner', 'name'] as const)
    scalar(value[key]);
  for (const key of ['product', 'component', 'version'] as const)
    scalar(value[key], 1_000);
  text(value.responsibilities, 2_000);
  strings(value.allowedLabels, 32, 100);
  strings(value.allowedTemplates, 8);
  if (
    value.enabled !== true ||
    value.publicationMode !== 'approval_required' ||
    !['public', 'private'].includes(value.visibility)
  )
    throw new TypeError('Engineering descriptor unavailable');
}
/** Display model prose as literal text; independent checks still inspect every byte. */
function literal(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/[\\`*_{}\[\]()#+.!|>-]/gu, '\\$&');
}
function candidateBody(
  input: ProposalInput,
  references: readonly string[],
): { title: string; body: string } {
  const c = input.candidate!;
  object(c, [
    'title',
    'summary',
    'expectedBehavior',
    'actualBehavior',
    'reproductionSteps',
    'applicability',
    'security',
    'routing',
  ]);
  const title = scalar(c.title, 200);
  const summary = text(c.summary, 4_000);
  const expected = text(c.expectedBehavior, 2_000);
  const actual = text(c.actualBehavior, 2_000);
  const steps = array(c.reproductionSteps, 16, 1).map((step) =>
    text(step, 1_000),
  );
  object(c.applicability, ['productId', 'version', 'buildId']);
  const product = [
    c.applicability.productId,
    c.applicability.version,
    c.applicability.buildId,
  ].map((v) => scalar(v));
  const used = [
    title,
    summary,
    expected,
    actual,
    ...steps,
    ...product,
    ...references,
  ];
  if (used.some((value) => value.includes('pegma-engineering:')))
    throw new TypeError('Injected export marker');
  return {
    title,
    body: [
      '## Summary',
      literal(summary),
      '## Expected behavior',
      literal(expected),
      '## Actual behavior',
      literal(actual),
      '## Reproduction',
      steps.map((s, i) => `${i + 1}. ${literal(s)}`).join('\n'),
      '## Product',
      product.map(literal).join(' / '),
      ...(references.length === 0
        ? []
        : [
            '## Approved evidence',
            references.map((r) => '- ' + literal(r)).join('\n'),
          ]),
      'Export marker: ' + input.exportMarker,
    ].join('\n\n'),
  };
}

/** Pure local formatting. No receipt/verification is minted and no outbound call is made. */
export function createSupportEngineeringLocalProposals(
  options: SupportEngineeringLocalProposalOptions,
  clock: Clock = systemClock,
): EngineeringProposalPort {
  const readQuery = options.readDuplicateQuery;
  const readSettings = options.readSettings;
  const proposals: EngineeringProposalPort = {
    async duplicateQuery(allowed, context) {
      try {
        current(clock, context);
        descriptor(allowed);
        const query = readQuery(allowed);
        current(clock, context);
        if (query === null) return null;
        scalar(query, 256);
        if (
          query.trim() !== query ||
          !/^[\p{L}\p{N}][\p{L}\p{N} _.-]*$/u.test(query) ||
          query.split(/\s+/u).some((term) => /^(?:and|or|not)$/iu.test(term))
        )
          return null;
        return query;
      } catch {
        return null;
      }
    },
    async prepare(input, context) {
      try {
        current(clock, context);
        object(
          input,
          [
            'candidate',
            'previousRequest',
            'repository',
            'descriptor',
            'exportMarker',
            'duplicates',
          ],
          ['repository', 'descriptor', 'exportMarker', 'duplicates'],
        );
        if (
          (input.candidate === undefined) ===
          (input.previousRequest === undefined)
        )
          return { outcome: 'held' };
        descriptor(input.descriptor);
        object(input.repository, [
          'repositoryId',
          'owner',
          'name',
          'visibility',
          'installationBinding',
          'metadataVersion',
        ]);
        for (const key of [
          'repositoryId',
          'owner',
          'name',
          'visibility',
          'installationBinding',
          'metadataVersion',
        ] as const)
          scalar(input.repository[key]);
        if (
          ['repositoryId', 'owner', 'name', 'visibility'].some(
            (key) =>
              Reflect.get(input.repository, key) !==
              Reflect.get(input.descriptor, key),
          ) ||
          !markerPattern.test(input.exportMarker)
        )
          return { outcome: 'held' };
        if (
          input.candidate !== undefined &&
          input.candidate.security !== 'ordinary'
        )
          return { outcome: 'restricted' };
        const duplicates = array(input.duplicates, 5).map((value) => {
          const issue = object(value, [
            'repositoryId',
            'issueId',
            'issueNumber',
            'title',
            'body',
          ]);
          if (scalar(issue.repositoryId) !== input.repository.repositoryId)
            throw new TypeError('Wrong duplicate repository');
          scalar(issue.issueId);
          integer(issue.issueNumber, Number.MAX_SAFE_INTEGER, 1);
          scalar(issue.title, 200);
          text(issue.body, 12_000);
          return issue;
        });
        if (
          new Set(duplicates.map((i) => i.issueId)).size !==
            duplicates.length ||
          new Set(duplicates.map((i) => i.issueNumber)).size !==
            duplicates.length
        )
          return { outcome: 'held' };
        const configured = readSettings(input);
        current(clock, context);
        if (configured === null) return { outcome: 'held' };
        const settings = object(
          configured,
          ['labels', 'templateId', 'evidenceReferences', 'duplicate'],
          ['labels', 'evidenceReferences'],
        );
        const labels = strings(settings.labels, 32, 100);
        const references = strings(settings.evidenceReferences, 16);
        if (references.some((value) => value.includes('pegma-engineering:')))
          return { outcome: 'held' };
        const templateId =
          settings.templateId === undefined
            ? undefined
            : scalar(settings.templateId);
        if (
          labels.some(
            (label) => !input.descriptor.allowedLabels.includes(label),
          ) ||
          (templateId !== undefined &&
            !input.descriptor.allowedTemplates.includes(templateId))
        )
          return { outcome: 'held' };
        let content: { title: string; body: string };
        let duplicate = settings.duplicate;
        if (input.previousRequest === undefined)
          content = candidateBody(input, references);
        else {
          const previous = input.previousRequest;
          object(
            previous,
            ['operation', 'repository', 'bundle', 'issueId', 'issueNumber'],
            ['operation', 'repository', 'bundle'],
          );
          if (
            !['create_issue', 'link_existing_issue'].includes(
              previous.operation,
            ) ||
            previous.repository.repositoryId !== input.repository.repositoryId
          )
            return { outcome: 'held' };
          const old = object(
            previous.bundle,
            [
              'title',
              'body',
              'labels',
              'templateId',
              'evidenceReferences',
              'exportMarker',
            ],
            ['title', 'body', 'labels', 'evidenceReferences', 'exportMarker'],
          );
          const oldMarker = scalar(old.exportMarker);
          const body = text(old.body, 12_000);
          if (
            !markerPattern.test(oldMarker) ||
            !exactMarker(body, oldMarker) ||
            canonical(strings(old.evidenceReferences, 16)) !==
              canonical(references)
          )
            return { outcome: 'held' };
          const title = scalar(old.title, 200);
          if (title.includes('pegma-engineering:')) return { outcome: 'held' };
          content = {
            title,
            body: body.replace(oldMarker, input.exportMarker),
          };
          if (previous.operation === 'link_existing_issue') {
            const retained = {
              issueId: previous.issueId,
              issueNumber: previous.issueNumber,
            };
            if (
              duplicate !== undefined &&
              canonical(duplicate) !== canonical(retained)
            )
              return { outcome: 'held' };
            duplicate = retained;
          }
        }
        const bundle: EngineeringSanitizedBundle = {
          ...content,
          labels,
          ...(templateId === undefined ? {} : { templateId }),
          evidenceReferences: references,
          exportMarker: input.exportMarker,
        };
        const request =
          duplicate === undefined
            ? {
                operation: 'create_issue' as const,
                repository: input.repository,
                bundle,
              }
            : (() => {
                const chosen = object(duplicate, ['issueId', 'issueNumber']);
                if (
                  !duplicates.some(
                    (i) =>
                      i.issueId === chosen.issueId &&
                      i.issueNumber === chosen.issueNumber,
                  )
                )
                  throw new TypeError('Duplicate not observed');
                return {
                  operation: 'link_existing_issue' as const,
                  repository: input.repository,
                  bundle,
                  issueId: scalar(chosen.issueId),
                  issueNumber: integer(
                    chosen.issueNumber,
                    Number.MAX_SAFE_INTEGER,
                    1,
                  ),
                };
              })();
        const serialized = canonical(request);
        if (
          bundle.body.length > 12_000 ||
          !exactMarker(bundle.body, input.exportMarker) ||
          serialized.length * 2 > 24_000 ||
          encoder.encode(serialized).byteLength > 24_000
        )
          return { outcome: 'held' };
        current(clock, context);
        return { outcome: 'prepared', request: structuredClone(request) };
      } catch {
        return { outcome: 'held' };
      }
    },
  };
  return Object.freeze(proposals);
}

/** Build ports before the existing App factory, then pass processing to the existing
 * composeSupportEngineeringProcessing. No Store, identity, role, timer or activation is created. */
export function createProductionSupportEngineering(
  options: SupportEngineeringProductionOptions = {},
): SupportEngineeringProductionComposition {
  const off = (): SupportEngineeringProductionComposition =>
    Object.freeze({
      application: supportEngineeringApplicationOptions(),
      processing: Object.freeze({}),
    });
  const configured = options.configuration;
  if (configured === undefined) return off();
  const supplied = configured;
  try {
    const shared = supplied.readChecks !== undefined;
    // Do not even inspect private configuration when Root chose the shared pool.
    const checkerOptions = shared ? undefined : supplied.independentChecks;
    const controlled = shared || checkerOptions !== undefined;
    let checker: ReturnType<typeof createSupportIndependentChecks> | undefined;
    let attached = false;
    function currentChecker(): SupportEngineeringSharedChecks | undefined {
      if (!shared) return checker;
      try {
        const readShared = supplied.readChecks;
        const current =
          typeof readShared === 'function' ? readShared() : undefined;
        return current &&
          [
            current.resolvePolicy,
            current.engineeringSdkVerifier?.verify,
            current.engineeringFor,
            current.precomputePending,
            current.discardTicket,
          ].every((value) => typeof value === 'function')
          ? current
          : undefined;
      } catch {
        return undefined;
      }
    }
    function invoke<Result>(
      action: (controller: SupportEngineeringSharedChecks) => Promise<Result>,
      unavailable: Result,
    ): Promise<Result> {
      const current = currentChecker();
      if (!current) return Promise.resolve(unavailable);
      // Preserve the existing private-controller error behavior. Shared binding
      // faults fail closed; they never select the old pool or bare verifier.
      if (!shared) return action(current);
      try {
        return Promise.resolve(action(current)).catch(() => unavailable);
      } catch {
        return Promise.resolve(unavailable);
      }
    }
    const checks: Processing['ports']['checks'] = !controlled
      ? supplied.checks!
      : Object.freeze({
          resolvePolicy: (
            ...args: Parameters<Processing['ports']['checks']['resolvePolicy']>
          ) =>
            invoke((controller) => controller.resolvePolicy(...args), {
              outcome: 'unavailable' as const,
            }),
          check: async () => ({ outcome: 'held' as const }),
          verify: (
            ...args: Parameters<Processing['ports']['checks']['verify']>
          ) =>
            invoke(
              (controller) => controller.engineeringSdkVerifier.verify(...args),
              null,
            ),
        });
    if (
      ![
        supplied.serviceAccess?.resolve,
        supplied.reconciliationAccess?.resolve,
        supplied.productContext?.resolve,
        supplied.routing?.resolve,
        supplied.routing?.check,
        supplied.routing?.verify,
        checks?.resolvePolicy,
        checks?.check,
        checks?.verify,
        supplied.repository?.authentication?.resolve,
        supplied.proposals?.readDuplicateQuery,
        supplied.proposals?.readSettings,
      ].every((value) => typeof value === 'function')
    )
      return off();
    const clock = options.clock ?? systemClock;
    const repository = createSupportEngineeringRepositoryPorts({
      ...supplied.repository,
      clock,
    });
    const proposals = createSupportEngineeringLocalProposals(
      supplied.proposals,
      clock,
    );
    const enabled = () => {
      try {
        return (
          options.configuration === supplied &&
          options.enabled?.() === true &&
          (shared
            ? currentChecker() !== undefined
            : checkerOptions === undefined ||
              !attached ||
              checker !== undefined)
        );
      } catch {
        return false;
      }
    };
    const ports: Processing['ports'] = Object.freeze({
      serviceAccess: supplied.serviceAccess,
      reconciliationAccess: supplied.reconciliationAccess,
      routing: supplied.routing,
      checks,
      github: repository.github,
      proposals,
    });
    return Object.freeze({
      application: supportEngineeringApplicationOptions({
        ...supplied.application,
        productContext: supplied.productContext,
        routing: supplied.routing,
        checks,
        repositoryMetadata: repository.repositoryMetadata,
        dispatchResults: repository.dispatchResults,
      }),
      processing: Object.freeze({
        enabled,
        configuration: Object.freeze({
          model: supplied.model,
          usagePolicy: supplied.usagePolicy,
          ports,
          ...(!controlled
            ? {}
            : ({
                checksFor(scope, onDurablyDeferred) {
                  const fixed = Object.freeze({
                    ticketId: scope.ticketId,
                    sourceGeneration: scope.sourceGeneration,
                  });
                  const capture = {
                    onDurablyDeferred(hint: IndependentCheckPendingHint) {
                      if (hint.kind !== 'engineering')
                        throw new TypeError('Wrong independent check purpose');
                      onDurablyDeferred({
                        kind: 'checks',
                        operationId: hint.operationId,
                        ticketId: hint.scope.ticketId,
                        sourceGeneration: hint.scope.sourceGeneration,
                        expiresAt: hint.expiresAt,
                      });
                    },
                  };
                  if (!shared)
                    return checker?.engineeringFor(fixed, capture) ?? checks;
                  // Scope is immutable, but the selected controller is read afresh for
                  // every policy/check/verification operation, including retained ports.
                  return Object.freeze({
                    resolvePolicy: (
                      ...args: Parameters<
                        Processing['ports']['checks']['resolvePolicy']
                      >
                    ) =>
                      invoke(
                        (controller) => controller.resolvePolicy(...args),
                        { outcome: 'unavailable' as const },
                      ),
                    check: (
                      ...args: Parameters<
                        Processing['ports']['checks']['check']
                      >
                    ) =>
                      invoke(
                        (controller) =>
                          controller
                            .engineeringFor(fixed, capture)
                            .check(...args),
                        { outcome: 'held' as const },
                      ),
                    verify: (
                      ...args: Parameters<
                        Processing['ports']['checks']['verify']
                      >
                    ) =>
                      invoke(
                        (controller) =>
                          controller
                            .engineeringFor(fixed, capture)
                            .verify(...args),
                        null,
                      ),
                  });
                },
                precomputeChecks: async (hint, run) => {
                  const result = await invoke(
                    (controller) =>
                      controller.precomputePending(
                        hint.operationId,
                        run,
                        {
                          ticketId: hint.ticketId,
                          sourceGeneration: hint.sourceGeneration,
                        },
                        run.current,
                      ),
                    { outcome: 'held' as const },
                  );
                  return { outcome: result.outcome };
                },
                discardChecks: async (ticketId) => {
                  await invoke(
                    (controller) =>
                      controller.discardTicket('engineering', ticketId),
                    0,
                  );
                },
              } satisfies Pick<
                Processing,
                'checksFor' | 'precomputeChecks' | 'discardChecks'
              >)),
        }),
      }),
      reviewProofs: Object.freeze({
        serviceAccess: ports.serviceAccess,
        routing: ports.routing,
        checks: ports.checks,
        github: ports.github,
      }),
      ...(controlled
        ? {
            discardChecks: async (ticketId: string) => {
              await invoke(
                (controller) =>
                  controller.discardTicket('engineering', ticketId),
                0,
              );
            },
          }
        : {}),
      ...(checkerOptions === undefined
        ? {}
        : ({
            attachRuntime(runtime) {
              if (attached) return false;
              attached = true;
              try {
                checker = createSupportIndependentChecks({
                  ...checkerOptions,
                  store: runtime.store,
                  clock: runtime.clock,
                  application: runtime.application,
                  repositories: repository.repositoryMetadata,
                  deferred: true,
                  enabled: () =>
                    supplied.independentChecks === checkerOptions &&
                    checkerOptions.enabled?.() === true,
                });
                return true;
              } catch {
                checker = undefined;
                return false;
              }
            },
          } satisfies Pick<
            SupportEngineeringProductionComposition,
            'attachRuntime' | 'discardChecks'
          >)),
    });
  } catch {
    return off();
  }
}
