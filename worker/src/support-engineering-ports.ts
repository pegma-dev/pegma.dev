import type { AccessContext } from '@pegma/authorization-core';
import type { SupportDeskEngineeringOptions } from '@pegma/support-desk-ai';

/** Current host authority, resolved from stored grants, never ticket claims. */
export interface SupportEngineeringStaffAccess {
  resolve(principalId: string, signal: AbortSignal): Promise<AccessContext | null>;
}

/** Purpose-specific trusted ports. Policy and durable state remain SDK-owned. */
export type SupportEngineeringPorts = Pick<SupportDeskEngineeringOptions,
  'serviceAccess' | 'reconciliationAccess' | 'configuration' | 'routing' |
  'checks' | 'model' | 'usage' | 'tokenCounter' | 'github' | 'proposals'>;

export type SupportEngineeringOperation = 'enroll' | 'failure' | 'select' |
  'review' | 'invalidate' | 'withdraw' | 'policy_put' | 'policy_disable';

function identifier(value: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 200 ||
    /[\u0000-\u001F\u007F]/u.test(value))
    throw new TypeError('Invalid engineering command identity');
  return value;
}

/** Exact client bytes are retained; the digest is correlation, not authority. */
export async function supportEngineeringCommandIdentity(input: {
  readonly principalId: string;
  readonly ticketId: string;
  readonly operation: SupportEngineeringOperation;
  readonly clientCommandId: string;
}): Promise<{ readonly commandId: string; readonly correlationId: string }> {
  const actor = identifier(input.principalId);
  const ticket = identifier(input.ticketId);
  const commandId = identifier(input.clientCommandId);
  if (!['enroll', 'failure', 'select', 'review', 'invalidate', 'withdraw',
    'policy_put', 'policy_disable'].includes(input.operation))
    throw new TypeError('Invalid engineering operation');
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(
    JSON.stringify(['pegma.support-engineering.command.v1', actor, input.operation, ticket, commandId]),
  )));
  return Object.freeze({ commandId,
    correlationId: 'engineering:' + [...hash].map((byte) => byte.toString(16).padStart(2, '0')).join('') });
}
