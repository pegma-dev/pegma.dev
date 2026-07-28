import type { PrincipalId } from '@pegma/spine';

/**
 * Narrow host-facing subset of @pegma/identity.
 *
 * Keeping this structural boundary in one file lets the Worker compile before
 * the first public Identity release. The production composition replaces the
 * unavailable runtime with the exact published package; route code does not
 * change.
 */
export interface IdentityPort {
  claimsFor(principalId: PrincipalId): Promise<VerifiedIdentityClaims>;
  getUser(principalId: PrincipalId): Promise<IdentityUser | null>;
  beginPasskeyRegistration(
    principalId: PrincipalId,
    rateLimitKey: string,
  ): Promise<WebAuthnStart>;
  finishPasskeyRegistration(input: {
    readonly principalId: PrincipalId;
    readonly challengeHandle: string;
    readonly label: string;
    readonly response: unknown;
  }): Promise<Passkey>;
  beginPasskeyAuthentication(rateLimitKey: string): Promise<WebAuthnStart>;
  finishPasskeyAuthentication(input: {
    readonly challengeHandle: string;
    readonly response: unknown;
  }): Promise<VerifiedIdentityClaims>;
  listPasskeys(principalId: PrincipalId): Promise<readonly Passkey[]>;
  removePasskey(
    principalId: PrincipalId,
    credentialId: string,
  ): Promise<boolean>;
}

export interface IdentityUser {
  readonly principalId: PrincipalId;
  readonly email: string;
  readonly emailVerified: boolean;
  readonly status: 'pending' | 'active';
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface VerifiedIdentityClaims {
  readonly issuer: string;
  readonly subject: PrincipalId;
  readonly emailVerified: true;
}

export interface IdentityLinkKey {
  readonly issuer: string;
  readonly subject: PrincipalId;
}

export type IdentityLinkProjector = (
  claims: VerifiedIdentityClaims,
) => IdentityLinkKey;

export interface WebAuthnStart {
  readonly challengeHandle: string;
  readonly options: Record<string, unknown>;
}

export interface Passkey {
  readonly credentialId: string;
  readonly label: string;
  readonly transports: readonly string[];
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
}

/**
 * Future email-code Identity flow. Implementations must be enumeration-safe:
 * begin returns the same public shape whether or not an address already exists.
 */
export interface EmailCodeIdentityPort {
  begin(
    email: string,
    rateLimitKey: string,
  ): Promise<{ readonly challengeHandle: string }>;
  finish(
    challengeHandle: string,
    code: string,
    rateLimitKey: string,
  ): Promise<VerifiedIdentityClaims>;
}

/**
 * Delivery seam for the email-code implementation. Cloudflare Email Sending
 * can implement this port later without coupling routes to a paid service.
 */
export interface VerificationEmailSender {
  sendVerificationCode(input: {
    readonly to: string;
    readonly code: string;
    readonly expiresAt: string;
  }): Promise<void>;
}
