import { createMemoryStore, type Store } from '@pegma/storage-core';
import { resolveAccess } from '@pegma/authorization-core';
import { type Clock } from '@pegma/spine';
import { supportAnsweringFixture, publishAnsweringGuide } from './support-answering-fixtures';
import {
  SUPPORT_ASSISTANT_ENDPOINT,
  SUPPORT_ASSISTANT_WIRE_VERSION,
  supportAssistantRoutePolicySha256,
} from './support-assistant-config';
import {
  createProductionSupportAnswering,
  SUPPORT_ASSISTANT_CREDENTIAL_REF,
  SUPPORT_ASSISTANT_SYNTHETIC_ROLE,
  type SupportAssistantProductionConfiguration,
} from './support-assistant-production';
import { APPLICATION_SCOPE } from './support-access';
import { IDENTITY_ISSUER, SESSION_COOKIE } from './identity-api';

/** Actual public Identity, roles, Support and human-confirmed KB setup. Only
 * operator evidence and provider responses are fictional; root ports are real. */
export async function productionAnsweringFixture(store: Store = createMemoryStore()) {
  const f = await supportAnsweringFixture(store);
  const principalId = 'fictional-answer-customer';
  await f.human.identity.provisionVerifiedUser({
    principalId,
    email: 'fictional-answer@example.test',
  });
  await f.runtime.roleStore.grantRoleAssignmentWithAudit({
    assignment: {
      id: 'fictional-answering-role',
      principalId,
      role: SUPPORT_ASSISTANT_SYNTHETIC_ROLE,
      scope: APPLICATION_SCOPE,
      grantedBy: { kind: 'system', systemId: 'fictional-answering-setup' },
      grantedAtEpochMs: Date.now(),
      status: 'active',
    },
    auditEventId: crypto.randomUUID(),
  });
  const sessionId = 's'.repeat(43);
  const csrf = 'z'.repeat(43);
  await f.runtime.sessions.create(sessionId, {
    principalId,
    data: JSON.stringify({
      version: 1,
      csrfToken: csrf,
      issuer: IDENTITY_ISSUER,
      subject: principalId,
    }),
  });
  const base = {
    ...f.route,
    endpointTag: 'azure/swedencentral',
    credentialRef: SUPPORT_ASSISTANT_CREDENTIAL_REF,
    configuration: {
      ...f.route.configuration,
      model: 'openai/gpt-4.1-mini',
      provider: 'Azure',
      framingTokens: 1024,
      budgets: {
        ...f.route.configuration.budgets,
        maxInputTokens: 4096,
        maxOutputTokens: 512,
        maxOutputBytes: 4096,
        maxCostMicros: 2704,
        maxAssistantTurns: 1,
      },
    },
  };
  const route = {
    ...base,
    approval: {
      ...base.approval,
      requestPolicySha256: await supportAssistantRoutePolicySha256(base),
    },
  };
  const settings = {
    version: 1,
    route,
    usagePolicy: { ...f.composition.configuration!.usagePolicy, maxReservationCostMicros: 2704 },
    audience: {
      principalId,
      collectionId: 'fictional-guides',
      audienceVersion: 'fictional-audience',
      applicability: {
        productId: 'fictional-workspace',
        productVersion: '1.0',
        buildId: 'fictional-build',
      },
    },
    tokenizer: {
      model: route.configuration.model,
      modelVersion: route.configuration.modelVersion,
      wireVersion: SUPPORT_ASSISTANT_WIRE_VERSION,
      framingTokens: 1024,
      evidenceRef: route.approval.tokenizerRef,
      verifiedAt: route.approval.verifiedAt,
      validUntil: route.approval.validUntil,
    },
  } satisfies SupportAssistantProductionConfiguration;
  const environment = {
    PEGMA_SUPPORT_ASSISTANT_ENABLED: 'true',
    PEGMA_SUPPORT_ASSISTANT_CUSTOMER_ADMISSION_ENABLED: 'false',
    PEGMA_SUPPORT_ASSISTANT_CONFIGURATION_JSON: JSON.stringify(settings),
    SUPPORT_ASSISTANT_OPENROUTER_API_KEY: 'fictional-never-a-real-key',
  };
  const bundle = (clock: Clock = f.runtime.clock) =>
    createProductionSupportAnswering(environment, clock);
  async function access() {
    const configured = await bundle();
    if (configured.configuration === undefined)
      throw new Error('Invalid fictional operator setup.');
    return resolveAccess(
      { principalId, roles: [SUPPORT_ASSISTANT_SYNTHETIC_ROLE] },
      configured.configuration.customerPolicy,
    );
  }
  function packet(preference: 'human' | 'assistant_if_available' = 'assistant_if_available') {
    return {
      ...f.packet(preference),
      command: {
        version: 1 as const,
        expectedAccountId: principalId,
        expectedRequesterEmail: 'fictional-answer@example.test',
        commandId: principalId + '~' + crypto.randomUUID(),
        messageId: principalId + '~' + crypto.randomUUID(),
        ticketId: crypto.randomUUID(),
      },
    };
  }
  function request(body?: ReturnType<typeof packet>) {
    return new Request(
      'https://pegma.dev/api/support/assistant/' + (body === undefined ? 'capability' : 'tickets'),
      {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          Cookie: SESSION_COOKIE + '=' + sessionId,
          'X-Pegma-CSRF': csrf,
          Origin: IDENTITY_ISSUER,
          'Sec-Fetch-Site': 'same-origin',
          'X-Pegma-Support-Command': '1',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
    );
  }
  const wires: string[] = [];
  async function provider(input: RequestInfo | URL, init?: RequestInit) {
    if (input !== SUPPORT_ASSISTANT_ENDPOINT || typeof init?.body !== 'string')
      throw new Error('Unexpected external request.');
    if (
      new Headers(init.headers).get('Authorization') !== 'Bearer fictional-never-a-real-key' ||
      init.redirect !== 'error' ||
      init.cache !== 'no-store' ||
      init.credentials !== 'omit'
    )
      throw new Error('The production provider credential/transport fence changed.');
    wires.push(init.body);
    const wire = JSON.parse(init.body);
    const payload = JSON.parse(wire.messages[1].content);
    const sources = JSON.parse(payload.serializedSources);
    return Response.json({
      id: 'fictional-production-generation',
      object: 'chat.completion',
      provider: 'Azure',
      model: 'openai/gpt-4.1-mini',
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
    });
  }
  async function seed() {
    const guide = await publishAnsweringGuide(f);
    const command = packet();
    await f.runtime.application.createCustomerTicket(await access(), {
      commandId: command.command.commandId,
      correlationId: command.command.commandId,
      ticketId: command.command.ticketId,
      messageId: command.command.messageId,
      subject: command.subject,
      body: command.body,
      category: command.category,
      initialHandling: 'assistant',
    });
    return { command, guide };
  }
  return {
    f,
    store,
    principalId,
    settings,
    environment,
    bundle,
    access,
    request,
    packet,
    provider,
    wires,
    seed,
  };
}
