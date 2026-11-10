import type { PrincipalId } from '@pegma/spine';
import { ApiError, boundedString, exactObject } from './api-auth';

export const SUPPORT_BROWSER_COMMAND_HEADER = 'x-pegma-support-command';

interface BrowserCommand {
  readonly commandId: string;
}
interface BrowserMessageCommand extends BrowserCommand {
  readonly messageId: string;
}
interface BrowserCreateCommand extends BrowserMessageCommand {
  readonly ticketId: string;
  readonly expectedRequesterEmail: string | null;
}

/** An explicit transport mode, never authentication or permission authority. */
export function supportBrowserCommandMode(request: Request): boolean {
  const value = request.headers.get(SUPPORT_BROWSER_COMMAND_HEADER);
  if (value === null) return false;
  if (value !== '1') throw new ApiError(400, 'invalid_request');
  return true;
}

function actorQualifiedId(value: unknown, principalId: PrincipalId): string {
  const id = boundedString(value, 1, 128);
  const prefix = principalId + '~';
  if (
    !/^[A-Za-z0-9._~-]+$/u.test(id) ||
    !id.startsWith(prefix) ||
    !/^[A-Za-z0-9._~-]{1,64}$/u.test(id.slice(prefix.length))
  )
    throw new ApiError(400, 'invalid_request');
  return id;
}

export function supportBrowserCommand(
  value: unknown,
  principalId: PrincipalId,
  kind: 'create',
): BrowserCreateCommand;
export function supportBrowserCommand(
  value: unknown,
  principalId: PrincipalId,
  kind: 'message',
): BrowserMessageCommand;
export function supportBrowserCommand(
  value: unknown,
  principalId: PrincipalId,
  kind: 'patch',
): BrowserCommand;
export function supportBrowserCommand(
  value: unknown,
  principalId: PrincipalId,
  kind: 'create' | 'message' | 'patch',
): BrowserCommand | BrowserMessageCommand | BrowserCreateCommand {
  const envelope = exactObject(value, [
    'version',
    'expectedAccountId',
    'commandId',
    ...(kind === 'patch' ? [] : ['messageId']),
    ...(kind === 'create' ? ['ticketId', 'expectedRequesterEmail'] : []),
  ]);
  if (envelope.version !== 1) throw new ApiError(400, 'invalid_request');
  const expectedAccountId = boundedString(envelope.expectedAccountId, 1, 200);
  if (expectedAccountId !== principalId) throw new ApiError(403, 'forbidden');
  const commandId = actorQualifiedId(envelope.commandId, principalId);
  if (kind === 'patch') return Object.freeze({ commandId });
  const messageId = actorQualifiedId(envelope.messageId, principalId);
  if (kind === 'message') return Object.freeze({ commandId, messageId });
  const ticketId = envelope.ticketId;
  if (
    typeof ticketId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      ticketId,
    )
  )
    throw new ApiError(400, 'invalid_request');
  const expectedRequesterEmail =
    envelope.expectedRequesterEmail === null
      ? null
      : boundedString(envelope.expectedRequesterEmail, 1, 254);
  return Object.freeze({
    commandId,
    messageId,
    ticketId,
    expectedRequesterEmail,
  });
}
