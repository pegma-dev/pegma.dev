const TEXT_ENCODER = new TextEncoder();

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) {
    return null;
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = Number.parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

/**
 * Verify `X-Hub-Signature-256` over the exact raw body bytes using Web Crypto
 * HMAC-SHA256. Uses `subtle.verify` so comparison is not a plain `===`.
 */
export async function verifyGitHubWebhookSignature(
  secret: string,
  signatureHeader: string | null,
  body: Uint8Array,
): Promise<boolean> {
  if (typeof secret !== 'string' || secret.length === 0) {
    return false;
  }
  if (typeof signatureHeader !== 'string' || !signatureHeader.startsWith('sha256=')) {
    return false;
  }
  const sigHex = signatureHeader.slice('sha256='.length);
  const sigBytes = hexToBytes(sigHex);
  if (sigBytes === null || sigBytes.length !== 32) {
    return false;
  }

  const key = await crypto.subtle.importKey(
    'raw',
    TEXT_ENCODER.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );

  return crypto.subtle.verify(
    'HMAC',
    key,
    sigBytes as BufferSource,
    body as BufferSource,
  );
}

/** GitHub's published webhook signature fixture values. */
export const GITHUB_SIGNATURE_FIXTURE = {
  secret: "It's a Secret to Everybody",
  payload: 'Hello, World!',
  signatureHeader:
    'sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17',
} as const;
