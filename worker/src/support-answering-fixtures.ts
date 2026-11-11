import { createMemoryStore, type Store } from '@pegma/storage-core';
import { articleKinds, knowledgePermissions } from '@pegma/knowledge-base-contracts';
import { resolveAccess } from '@pegma/authorization-core';
import { supportPermissions } from '@pegma/support-desk-application';
import { createSupportRuntime } from './support-desk';
import { humanControlFixture } from './support-human-control-fixtures';
import {
  composeSupportAnswering,
  SUPPORT_ANSWERING_DISCLOSURE_VERSION,
  type SupportAnsweringComposition,
} from './support-assistant-composition';
import { createSupportAnsweringIngress } from './support-assistant-ingress';
import {
  supportAssistantRoutePolicySha256,
  SUPPORT_ASSISTANT_ENDPOINT,
  SUPPORT_ASSISTANT_WIRE_VERSION,
  type ApprovedSupportAssistantRoute,
} from './support-assistant-config';
import { PEGMA_ACCESS_POLICY } from './support-access';
import { ADMIN_ROLE, KNOWLEDGE_ROLE } from './support-access';
import { createKnowledgeRuntime } from './knowledge-runtime';

/** Real public SDK, host Identity/session and audited-role composition. The
 * route/counter/transport evidence is deliberately fictional and never live. */
export async function supportAnsweringFixture(store: Store = createMemoryStore()) {
  const human = await humanControlFixture(store);
  const logger = { log() {} };
  let now = Date.now();
  const clock = { now: () => new Date(now).toISOString() };
  const issuedAt = new Date(Date.now() - 1000).toISOString();
  const validUntil = new Date(Date.now() + 60_000).toISOString();
  const state = {
    enabled: true,
    environment: true,
    routeCurrent: true,
    loseAck: false,
    calls: 0,
    keys: 0,
    routeReads: 0,
  };
  let transport: ((init: RequestInit) => Promise<Response>) | undefined;
  const base: Omit<ApprovedSupportAssistantRoute, 'approval'> = {
    host: 'pegma.dev',
    purpose: 'support_answer',
    endpoint: SUPPORT_ASSISTANT_ENDPOINT,
    endpointTag: 'fictional/region-one',
    outputTokenParameter: 'max_tokens',
    credentialRef: 'fictional-credential',
    usageScopeRef: 'fictional-pool',
    configuration: {
      version: 'fictional-configuration',
      promptVersion: 'fictional-prompt',
      modelVersion: 'fictional-model-version',
      provider: 'Fictional Provider',
      model: 'fictional/byte-model',
      pricingRef: 'fictional-price',
      trustedInstructions: 'Answer from approved sources or escalate.',
      framingTokens: 512,
      budgets: {
        maxMessages: 10,
        maxInputBytes: 32768,
        maxInputTokens: 32768,
        maxContextTokens: 65536,
        maxOutputBytes: 8192,
        maxOutputTokens: 8192,
        maxDurationMilliseconds: 5000,
        maxCostMicros: 10000,
        currency: 'USD',
        maxAttempts: 2,
        maxAssistantTurns: 3,
      },
      dataControls: {
        status: 'verified',
        configurationBinding: 'fictional-configuration',
        accountRef: 'fictional-account',
        projectRef: 'fictional-project',
        endpointRef: 'fictional-endpoint',
        modelRef: 'fictional-model',
        featuresRef: 'fictional-features',
        exceptionsRef: 'fictional-exceptions',
        intermediaryRefs: ['fictional-openrouter'],
        verifiedAt: issuedAt,
        validUntil,
      },
    },
  };
  const route: ApprovedSupportAssistantRoute = {
    ...base,
    approval: {
      configurationVersion: base.configuration.version,
      wireVersion: SUPPORT_ASSISTANT_WIRE_VERSION,
      evidenceRef: 'fictional-approval',
      effectivePolicyRef: 'fictional-policy',
      evaluationRef: 'fictional-evaluation',
      responseIdentityRef: 'fictional-response',
      tokenizerRef: 'fictional-tokenizer',
      requestPolicySha256: await supportAssistantRoutePolicySha256(base),
      nativeCostCurrency: 'USD',
      nativeCostUnit: 'openrouter_credits_usd',
      rounding: 'ceil_micro',
      zdr: true,
      safetyRetention: false,
      inputOutputLogging: false,
      inputOutputUse: false,
      broadcast: false,
      responseCache: false,
      unreviewedFeatures: false,
      implicitCache: 'absent',
      verifiedAt: issuedAt,
      validUntil,
    },
  };
  const composition: SupportAnsweringComposition = {
    enabled: () => state.enabled,
    configuration: {
      disclosureVersion: SUPPORT_ANSWERING_DISCLOSURE_VERSION,
      turns: { maxAttempts: 2 },
      route: {
        readRoute() {
          ++state.routeReads;
          return state.routeCurrent ? route : undefined;
        },
        allowlist: [
          {
            model: base.configuration.model,
            provider: base.configuration.provider,
            endpointTag: base.endpointTag,
            outputTokenParameter: base.outputTokenParameter,
          },
        ],
        counter: {
          count: (text) => new TextEncoder().encode(text).byteLength,
          qualification: {
            model: base.configuration.model,
            modelVersion: base.configuration.modelVersion,
            wireVersion: SUPPORT_ASSISTANT_WIRE_VERSION,
            framingTokens: 512,
            evidenceRef: 'fictional-tokenizer',
            verifiedAt: issuedAt,
            validUntil,
          },
        },
      },
      readApiKey() {
        ++state.keys;
        return 'fictional-no-provider-key';
      },
      async fetch(_url, init) {
        ++state.calls;
        if (transport) return transport(init);
        throw new Error('This intake fixture must never call a provider.');
      },
      usagePolicy: {
        version: 'fictional-pool-version',
        scopeRef: base.usageScopeRef,
        configurationVersion: base.configuration.version,
        modelVersion: base.configuration.modelVersion,
        pricingRef: base.configuration.pricingRef,
        currency: 'USD',
        maxCostMicros: 100000,
        maxReservationCostMicros: 10000,
        maxReservations: 8,
        validFrom: issuedAt,
        validUntil,
        terminalRetentionMilliseconds: 60000,
      },
      customerPolicy: {
        ...PEGMA_ACCESS_POLICY,
        version: 'fictional-answering-policy',
        defaults: [
          ...(PEGMA_ACCESS_POLICY.defaults ?? []),
          knowledgePermissions.botRead,
          supportPermissions.assistantStart,
        ],
      },
      selectAudience: () => ({
        audienceVersion: 'fictional-audience',
        usageScopeRef: base.usageScopeRef,
        collectionIds: ['fictional-guides'],
        applicability: {
          productId: 'fictional-workspace',
          productVersion: '1.0',
          buildId: 'fictional-build',
        },
      }),
    },
  };
  const runtime = createSupportRuntime({
    ...human.runtime,
    logger,
    clock,
    assistantTurns: composition.configuration!.turns,
  });
  const application = {
    ...runtime.application,
    async createAdmittedCustomerTicket(
      ...args: Parameters<typeof runtime.application.createAdmittedCustomerTicket>
    ) {
      const result = await runtime.application.createAdmittedCustomerTicket(...args);
      if (state.loseAck) {
        state.loseAck = false;
        throw new Error('Fictional dropped SDK acknowledgement');
      }
      return result;
    },
  };
  function answering() {
    return composeSupportAnswering(
      { ...runtime, application },
      logger,
      composition,
      () => state.environment,
    );
  }
  const ingress = () =>
    createSupportAnsweringIngress({ ...runtime, application }, logger, answering());
  function packet(preference: 'human' | 'assistant_if_available' = 'assistant_if_available') {
    const actor = human.principals.owner;
    return {
      command: {
        version: 1,
        expectedAccountId: actor,
        expectedRequesterEmail: 'owner@example.test',
        commandId: actor + '~' + crypto.randomUUID(),
        messageId: actor + '~' + crypto.randomUUID(),
        ticketId: crypto.randomUUID(),
      },
      subject: 'Fictional workspace help',
      body: 'How do I export my workspace?',
      category: 'question',
      preference,
      disclosureVersion: SUPPORT_ANSWERING_DISCLOSURE_VERSION,
    };
  }
  function request(body?: ReturnType<typeof packet>, actor: 'owner' | 'peer' = 'owner') {
    return new Request(
      'https://pegma.dev/api/support/assistant/' + (body === undefined ? 'capability' : 'tickets'),
      {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          Cookie: human.cookies.get(actor)!,
          'X-Pegma-CSRF': human.csrf.get(actor)!,
          Origin: 'https://pegma.dev',
          'Sec-Fetch-Site': 'same-origin',
          'X-Pegma-Support-Command': '1',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
    );
  }
  return {
    human,
    runtime,
    application,
    logger,
    state,
    composition,
    route,
    answering,
    ingress,
    packet,
    request,
    advance(milliseconds: number) {
      if (!Number.isSafeInteger(milliseconds) || milliseconds < 0)
        throw new Error('Invalid fixture advance');
      now += milliseconds;
    },
    setTransport(value: typeof transport) {
      transport = value;
    },
  };
}

/** Publish through real KB015 host report+human confirmation, not a verifier stub. */
export async function publishAnsweringGuide(
  f: Awaited<ReturnType<typeof supportAnsweringFixture>>,
) {
  const host = createKnowledgeRuntime({
    ...f.runtime,
    logger: f.logger,
    agentAccess: null,
    retrieval: { tokenCounter: { count: (text) => new TextEncoder().encode(text).byteLength } },
  });
  const kb = host.application;
  const author = resolveAccess(
    { principalId: f.human.principals.administrator, roles: [ADMIN_ROLE] },
    PEGMA_ACCESS_POLICY,
  );
  const reviewer = resolveAccess(
    { principalId: f.human.principals.knowledge, roles: [KNOWLEDGE_ROLE] },
    PEGMA_ACCESS_POLICY,
  );
  let ordinal = 0;
  const command = (expectedGeneration: number) => ({
    commandId: 'answering-guide-' + ++ordinal,
    correlationId: 'fictional-published-guide',
    expectedGeneration,
  });
  const collectionId = 'fictional-guides';
  const articleId = 'fictional-export-guide';
  const applicability = {
    productId: 'fictional-workspace',
    productVersion: '1.0',
    buildId: 'fictional-build',
  };
  const collection = await kb.createCollection(author, {
    ...command(0),
    collectionId,
    name: 'Fictional guides',
  });
  const policy = {
    id: 'fictional-answering-validation',
    version: 1,
    requirements: [
      ...articleKinds.map((kind) => ({
        id: kind + '-content',
        kind,
        testKind: 'content',
        maxAgeMilliseconds: 3600000,
        trustedRunnerIds: [author.principalId],
      })),
      {
        id: 'walkthrough-workflow',
        kind: 'walkthrough' as const,
        testKind: 'workflow',
        maxAgeMilliseconds: 3600000,
        trustedRunnerIds: [author.principalId],
      },
    ],
  };
  await kb.putValidationPolicy(author, { ...command(0), policy });
  await kb.putGovernanceConfiguration(author, {
    ...command(collection.value.generation),
    collectionId,
    configuration: {
      validationPolicy: { id: policy.id, version: 1 },
      expectedStagingBuildId: applicability.buildId,
      trustedAttesterIds: [reviewer.principalId],
    },
  });
  const preview = await kb.previewCollectionPolicy(author, {
    collectionId,
    uses: {
      portal: { enabled: false },
      bot: {
        enabled: true,
        audience: { kind: 'permission', permission: knowledgePermissions.articleRead },
      },
    },
  });
  await kb.updateCollectionPolicy(author, {
    ...command(preview.generation),
    collectionId,
    preview: preview.preview,
  });
  await kb.createDraft(author, {
    ...command(0),
    articleId,
    collectionId,
    draft: {
      kind: 'explanation',
      title: 'Export a fictional workspace',
      summary: 'Export workspace files.',
      content: {
        format: 'plain_text',
        text: 'Open Workspace, choose Export, and download the CSV.',
      },
      tags: ['workspace', 'export'],
      applicability,
    },
  });
  const draft = await kb.getDraft(author, { articleId });
  const evidence = {
    id: 'fictional-real-report-evidence',
    articleId,
    articleRevision: draft.revision.number,
    contentHash: draft.revision.contentHash,
    validationPolicy: draft.revision.validationPolicy,
    checkId: 'explanation-content',
    testKind: 'content',
    applicability,
    stagingBuildId: applicability.buildId,
    steps: ['Open the fictional workspace.', 'Download the CSV.'],
    result: 'passed' as const,
    executedAt: f.runtime.clock.now(),
    runnerId: author.principalId,
    artifacts: [{ id: 'fictional-artifact', hash: 'a'.repeat(64) }],
  };
  const ledger = await host.evidence.ledger(author, { articleId });
  const reported = await host.evidence.report(author, {
    commandId: 'fictional-answer-report',
    articleId,
    ledgerEpoch: ledger.ledgerEpoch,
    evidence,
    report: { summary: 'Fictional export passed', details: 'The fictional CSV opened.' },
  });
  const key = { articleId, ledgerEpoch: reported.ledgerEpoch, reportId: reported.reportId };
  const viewed = await host.evidence.read(reviewer, key);
  const confirmed = await host.evidence.decide(
    reviewer,
    {
      ...key,
      commandId: 'fictional-answer-confirm',
      expectedReportGeneration: viewed.expectedReportGeneration,
      reviewBindingHash: viewed.reviewBindingHash,
    },
    'confirmed',
  );
  await kb.submitEvidence(author, {
    ...command(draft.generation),
    articleId,
    evidence,
    receipt: confirmed.receipt,
  });
  const current = await kb.getDraft(author, { articleId });
  await kb.submitForReview(author, { ...command(current.generation), articleId });
  const review = await kb.getReview(reviewer, { articleId });
  await kb.publishArticle(reviewer, {
    ...command(review.generation),
    articleId,
    review: review.review,
  });
  for (let turn = 0; turn < 16; ++turn) {
    const repaired = await kb.repairArticleIndex(author, { articleId });
    if (repaired.status === 'ready' && repaired.indexed) return { kb, articleId, author, reviewer };
    if (repaired.status === 'blocked') throw new Error('Real host report guide was blocked.');
  }
  throw new Error('Real host report guide repair did not converge.');
}

export async function completeAnsweringComposition(
  f: Awaited<ReturnType<typeof supportAnsweringFixture>>,
) {
  const guide = await publishAnsweringGuide(f);
  const packet = f.packet();
  const intake = await f.ingress()(f.request(packet));
  if (intake.status !== 201)
    throw new Error('Actual answering intake was refused: ' + intake.status);
  const wires: string[] = [];
  f.setTransport(async (init) => {
    if (typeof init.body !== 'string') throw new Error('Missing actual model wire');
    wires.push(init.body);
    const wire = JSON.parse(init.body);
    const payload = JSON.parse(wire.messages[1].content);
    const sources = JSON.parse(payload.serializedSources);
    return new Response(
      JSON.stringify({
        id: 'fictional-one-generation',
        object: 'chat.completion',
        provider: f.route.configuration.provider,
        model: f.route.configuration.model,
        choices: [
          {
            index: 0,
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: JSON.stringify({
                kind: 'answer',
                text: 'Open Workspace and choose Export.',
                reason: null,
                citations: sources.map((source: { reference: unknown }) => source.reference),
              }),
            },
          },
        ],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 30,
          total_tokens: 130,
          cost: 0.000001,
          prompt_tokens_details: {
            cached_tokens: 0,
            cache_write_tokens: 0,
            audio_tokens: 0,
            video_tokens: 0,
          },
          completion_tokens_details: { reasoning_tokens: 0, image_tokens: 0, audio_tokens: 0 },
        },
      }),
      { headers: { 'Content-Type': 'application/json' } },
    );
  });
  return { guide, packet, wires };
}

/** The actual public Identity email-change workflow, with only its fictional
 * mail delivery externality scripted. Codes stay in memory, never in artifacts. */
export async function changeAnsweringContact(
  f: Awaited<ReturnType<typeof supportAnsweringFixture>>,
  email: string,
) {
  let deliveredCode: string | undefined;
  const identity = f.human.identity;
  const principalId = f.human.principals.owner;
  const mail = identity.createMailWorker({
    workerId: 'fictional-answering-contact-change',
    provider: {
      async send() {
        return { providerMessageRef: 'fictional-contact-code' };
      },
    },
    reconciliation: {
      async reconcile() {
        return { status: 'unknown' };
      },
    },
    renderer: {
      async render(content) {
        if (content.purpose === 'email_change') deliveredCode = content.code;
        return { subject: 'Fictional contact change', text: 'Fictional in-memory delivery.' };
      },
    },
  });
  const rateLimitKey = 'fictional-answering-contact-change';
  const started = await identity.beginEmailChange(principalId, email, rateLimitKey);
  const sent = await mail.runSendPage({ limit: 100 });
  if (
    sent.results.length !== 1 ||
    sent.results[0]?.status !== 'accepted' ||
    deliveredCode === undefined
  )
    throw new Error('The actual fictional Identity email-change code was not delivered.');
  const changed = await identity.finishEmailChange({
    principalId,
    codeHandle: started.codeHandle,
    code: deliveredCode,
    rateLimitKey,
  });
  if (
    changed.principalId !== principalId ||
    changed.email !== email ||
    changed.status !== 'active' ||
    changed.emailVerified !== true
  )
    throw new Error('The actual verified Identity contact did not change.');
  const claims = await identity.claimsFor(principalId);
  if (claims.subject !== principalId || claims.emailVerified !== true)
    throw new Error('The changed actual Identity is not currently verified.');
}
