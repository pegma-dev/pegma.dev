import type {
  Identity,
  Passkey as PublishedPasskey,
  User,
  VerifiedIdentityClaims as PublishedVerifiedIdentityClaims,
} from '@pegma/identity';
import type { PrincipalId } from '@pegma/spine';

/**
 * Exact published Identity methods consumed by the HTTP boundary.
 *
 * Keeping this list narrow makes the host's authority explicit while letting
 * package declaration changes fail the Worker build instead of drifting in a
 * duplicate interface.
 */
export type IdentityPort = Pick<
  Identity,
  | 'claimsFor'
  | 'getUser'
  | 'findUserByEmail'
  | 'beginPasskeyRegistration'
  | 'finishPasskeyRegistration'
  | 'beginPasskeyAuthentication'
  | 'finishPasskeyAuthentication'
  | 'listPasskeys'
  | 'removePasskey'
>;

export type IdentityUser = User;
export type VerifiedIdentityClaims = PublishedVerifiedIdentityClaims;
export type Passkey = PublishedPasskey;

export interface IdentityLinkKey {
  readonly issuer: string;
  readonly subject: PrincipalId;
}

export type IdentityLinkProjector = (
  claims: VerifiedIdentityClaims,
) => IdentityLinkKey;

/**
 * Durable email-code subset of @pegma/identity. Begin commits operation state
 * and its @pegma/mail job atomically; it never exposes raw code material.
 */
export type EmailCodeIdentityPort = Pick<
  Identity,
  | 'beginAccountCreation'
  | 'finishAccountCreation'
  | 'beginEmailSignIn'
  | 'finishEmailSignIn'
>;
