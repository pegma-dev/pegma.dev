import { identityLinkKeyFromVerifiedIdentityClaims } from '@pegma/authorization-identity';
import { createMemoryStore, type CollectionDefinition, type CollectionStore, type Store } from '@pegma/storage-core';
import { createSupportDeskApplication, engineeringPolicyRecords, supportRecords, type EngineeringRepositoryDescriptor } from '@pegma/support-desk-application';
import { createAgentPrincipalResolver } from './agent-authority';
import { isPlainObject } from './api-auth';
import { IDENTITY_ISSUER, SESSION_COOKIE } from './identity-api';
import { createIdentityRuntime } from './identity-runtime';
import { ADMIN_ROLE, APPLICATION_SCOPE, KNOWLEDGE_ROLE, SUPPORT_ROLE } from './support-access';
import { createSupportRuntime } from './support-desk';
import { createSupportEngineeringRuntime } from './support-engineering';
import {
  createSupportEngineeringFixture, engineeringProofReference, engineeringRepositories, engineeringTicketId,
} from './support-engineering-fixtures';
import { createSupportEngineeringHandlers } from './support-engineering-handlers';

export type EngineeringHttpActor = 'staff' | 'admin' | 'both' | 'knowledge' | 'customer' | 'peer';
export const engineeringHttpRoute = '/api/support/admin/tickets/' + engineeringTicketId + '/engineering';
export const engineeringHttpPolicyRoute = '/api/support/admin/engineering/policy';
export const engineeringHttpCommand = 'ABCDEFAB-1234-4ABC-8DEF-ABCDEF123456';

export async function engineeringHttpObject(response: Response) {
  const value: unknown = await response.json();
  if (!isPlainObject(value)) throw new Error('Expected a synthetic JSON response');
  return value;
}
export function engineeringHttpResult(value: Record<string, unknown>) {
  if (!isPlainObject(value.result)) throw new Error('Expected an operational SDK result');
  return value.result;
}
export function engineeringHttpNumber(value: unknown) {
  if (typeof value !== 'number') throw new Error('Expected an actual numeric SDK fence');
  return value;
}

/** Actual Identity, Sessions, host RoleStore, durable limiter and Support SDK. */
export async function createSupportEngineeringHttpFixture(backing: Store = createMemoryStore(), fixture: { readonly repositories?: readonly EngineeringRepositoryDescriptor[] } = {}) {
  const hooks: { commit?: () => Promise<void>; policy?: () => Promise<void> } = {};
  const store: Store = {
    collection<Value>(definition: CollectionDefinition<Value>): CollectionStore<Value> {
      const actual = backing.collection(definition);
      if (definition.name !== supportRecords.name && definition.name !== engineeringPolicyRecords.name) return actual;
      return { ...actual, async transact(partition, actions) {
        const value = await actual.transact(partition, actions);
        if (value.committed) {
          if (definition.name === supportRecords.name && partition === engineeringTicketId) await hooks.commit?.();
          if (definition.name === engineeringPolicyRecords.name) await hooks.policy?.();
        }
        return value;
      } };
    },
  };
  const engineering = await createSupportEngineeringFixture(store, fixture);
  const logger = { log() {} };
  const identityRuntime = createIdentityRuntime({ store, emailCodeSecretBase64: btoa('e'.repeat(32)),
    emailFrom: 'Pegma <synthetic@pegma.dev>', emailEnabled: false }, logger);
  const { identity, sessions } = identityRuntime;
  const host = createSupportRuntime({ store, identity, sessions, logger,
    identityLinkFromClaims: identityLinkKeyFromVerifiedIdentityClaims });
  const principals = { staff: engineering.actors.staff.principalId, admin: 'engineering-http-admin',
    both: 'engineering-http-admin-support', knowledge: 'engineering-http-knowledge',
    customer: engineering.actors.customer.principalId, peer: 'engineering-http-peer' };
  const cookies = new Map<EngineeringHttpActor, string>();
  const csrf = new Map<EngineeringHttpActor, string>();
  const sessionIds = new Map<EngineeringHttpActor, string>();
  for (const [index, actor] of (Object.keys(principals) as EngineeringHttpActor[]).entries()) {
    const principalId = principals[actor];
    await identity.provisionVerifiedUser({ principalId, email: actor + '@example.test' });
    const sessionId = String(index + 1).repeat(43); const token = String.fromCharCode(97 + index).repeat(43);
    await sessions.create(sessionId, { principalId, data: JSON.stringify({ version: 1,
      csrfToken: token, issuer: IDENTITY_ISSUER, subject: principalId }) });
    cookies.set(actor, SESSION_COOKIE + '=' + sessionId); csrf.set(actor, token); sessionIds.set(actor, sessionId);
    const roles = actor === 'both' ? [ADMIN_ROLE, SUPPORT_ROLE] : actor === 'admin' ? [ADMIN_ROLE]
      : actor === 'knowledge' ? [KNOWLEDGE_ROLE] : actor === 'staff' || actor === 'peer' ? [SUPPORT_ROLE] : [];
    for (const role of roles) await host.roleStore.grantRoleAssignmentWithAudit({ assignment: {
      id: 'engineering-http-' + actor + '-' + role, principalId, role, scope: APPLICATION_SCOPE,
      grantedBy: { kind: 'system', systemId: 'synthetic-engineering-http' }, grantedAtEpochMs: Date.now(), status: 'active',
    }, auditEventId: 'engineering-http-grant-' + actor + '-' + role });
  }
  const authority = { identity, sessions, logger, roleStore: host.roleStore,
    identityLinkFromClaims: identityLinkKeyFromVerifiedIdentityClaims };
  const resolve = createAgentPrincipalResolver(authority);
  const runtime = createSupportEngineeringRuntime({ application: engineering.application, clock: engineering.clock,
    ports: engineering.ports, staffAccess: { resolve: (principalId) => resolve(principalId) },
    processingEnabled: () => engineering.state.enabled });
  const state = { enabled: true, runtimeCalls: 0, runtime, captured: [] as string[] };
  const options = { ...authority, enabled: () => state.enabled,
    readLimiter: host.engineeringReadLimiter, mutationLimiter: host.engineeringMutationLimiter,
    runtime: () => { state.runtimeCalls += 1; return state.runtime; },
    repositories: (fixture.repositories ?? engineeringRepositories).map((descriptor) => ({ key: descriptor.repositoryId, descriptor })) };
  const handle = createSupportEngineeringHandlers(options);
  function request(operation = '', body?: unknown, actor: EngineeringHttpActor = 'staff', query = '') {
    const headers: Record<string, string> = { Cookie: cookies.get(actor)! };
    if (body !== undefined) Object.assign(headers, { Origin: IDENTITY_ISSUER, 'X-Pegma-CSRF': csrf.get(actor)!,
      'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' });
    const target = operation === 'policy' || operation === 'policy/disable' || operation === 'policy/prepare'
      ? engineeringHttpPolicyRoute + (operation === 'policy/disable' ? '/disable' : operation === 'policy/prepare' ? '/prepare' : '')
      : engineeringHttpRoute + (operation === '' ? '' : '/' + operation);
    return new Request(IDENTITY_ISSUER + target + query, { method: body === undefined ? 'GET' : 'POST', headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }
  async function send(incoming: Request) {
    const response = await handle(incoming);
    if (response === null) throw new Error('Expected an owned engineering HTTP route');
    return response;
  }
  async function revoke(actor: EngineeringHttpActor, role: string) {
    const assignmentId = 'engineering-http-' + actor + '-' + role;
    const row = await host.roleStore.getRoleAssignment(assignmentId);
    if (row === null) throw new Error('Missing actual host role assignment');
    return host.roleStore.revokeRoleAssignmentWithAudit({ assignmentId, expectedConcurrencyToken: row.concurrencyToken,
      revokedBy: { kind: 'system', systemId: 'synthetic-engineering-http' }, revokedAtEpochMs: Date.now(),
      auditEventId: 'engineering-http-revoke-' + actor + '-' + role });
  }
  async function preparePolicy(packet: unknown, actor: EngineeringHttpActor = 'both') {
    const response = await send(request('policy/prepare', packet, actor));
    if (response.status !== 200) throw new Error('Actual policy preparation failed: ' + response.status);
    const value = engineeringHttpResult(await engineeringHttpObject(response));
    if (!isPlainObject(value.intent)) throw new Error('Expected an actual prepared policy intent');
    return { intent: value.intent };
  }
  async function enrolled() {
    const ticket = await engineering.createTicket();
    const response = await send(request('enroll', { commandId: engineeringHttpCommand, expectedRevision: ticket.revision }));
    if (response.status !== 200) throw new Error('Actual HTTP enrollment failed: ' + response.status);
    return ticket;
  }
  async function legacyTicket() {
    // The enabled producer auto-enrolls during creation. Use the actual default-
    // disabled SDK factory to make a real legacy ticket so explicit enrollment
    // must perform its own Source/Audit/receipt transaction.
    const legacy = createSupportDeskApplication({ store, clock: engineering.clock });
    await legacy.createCustomerTicket(engineering.actors.customer, { ...engineering.command('legacy-ticket'),
      ticketId: engineeringTicketId, messageId: 'engineering-question', subject: 'Fictional legacy export question',
      body: 'A fictional export is empty.' });
    return (await engineering.application.readStaffTicket(engineering.actors.staff, engineeringTicketId)).ticket;
  }
  let acceptedKey: { ticketId: string; sourceGeneration: number } | undefined;
  async function verified(security: 'ordinary' | 'restricted' | 'uncertain' = 'ordinary') {
    const ticket = await enrolled();
    const packet = { commandId: 'EVIDENCE-EXACT', expectedRevision: ticket.revision,
      expectedBehavior: 'The export contains the workspace rows.', actualBehavior: 'The downloaded export is empty.',
      reproductionSteps: ['Create a fictional workspace with one row.', 'Export it and inspect the file.'],
      visibleMessageIds: ['engineering-question'], verificationReference: engineeringProofReference, security };
    const response = await send(request('evidence', packet));
    if (response.status !== 200) throw new Error('Actual HTTP evidence failed: ' + response.status);
    const source = engineeringHttpResult(await engineeringHttpObject(response));
    acceptedKey = { ticketId: engineeringTicketId, sourceGeneration: engineeringHttpNumber(source.sourceGeneration) };
    return { source, packet, key: { ...acceptedKey } };
  }
  function key() {
    if (acceptedKey === undefined) throw new Error('No actual HTTP accepted work key');
    return { ...acceptedKey };
  }
  const process = () => runtime.processWork({ ...key(), workerId: 'synthetic-http-engineering-worker', leaseMilliseconds: 30_000 });
  const work = () => engineering.application.readEngineeringWork(engineering.actors.security, key());
  async function prepared() {
    const candidate = await process(); if (candidate.outcome !== 'candidate') throw new Error('Actual candidate unavailable: ' + candidate.outcome);
    const proposal = await process(); if (proposal.outcome !== 'prepared') throw new Error('Actual proposal unavailable: ' + proposal.outcome);
    return work();
  }
  return { engineering, host, identity, sessions, principals, cookies, csrf, hooks, state, options, resolve, handle,
    request, send, revoke, preparePolicy, enrolled, legacyTicket, verified, key, process, work, prepared,
    rows: engineering.rows, policyRows: () => store.collection(engineeringPolicyRecords).list('instance'),
    async destroy(actor: EngineeringHttpActor) {
      const sessionId = sessionIds.get(actor); if (sessionId === undefined) throw new Error('Missing fixture session');
      return sessions.destroy(sessionId);
    } };
}
