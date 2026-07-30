import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const headersPath = join(here, '../public/_headers');

/**
 * Parse the Cloudflare Pages `_headers` rule for one path pattern.
 *
 * The file is indented `Name: value` lines under a path line, so a rule ends
 * at the next unindented line. Names are lowercased; an unknown pattern gives
 * an empty map, which the assertions below report as a missing header.
 */
function headersFor(pattern: string): Map<string, string> {
  const lines = readFileSync(headersPath, 'utf8').split('\n');
  const headers = new Map<string, string>();
  const start = lines.findIndex((line) => line.trim() === pattern);
  if (start < 0) {
    return headers;
  }

  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '') {
      continue;
    }
    if (!line.startsWith(' ')) {
      break;
    }
    const separator = line.indexOf(':');
    if (separator <= 0) {
      continue;
    }
    headers.set(
      line.slice(0, separator).trim().toLowerCase(),
      line.slice(separator + 1).trim(),
    );
  }
  return headers;
}

describe('public/_headers', () => {
  it('declares HSTS with at least a one-year max-age', () => {
    const hsts = headersFor('/*').get('strict-transport-security');
    expect(hsts).toBeDefined();

    const maxAge = /(?:^|;)\s*max-age=(\d+)\s*(?:;|$)/.exec(hsts ?? '');
    expect(maxAge, `no max-age in "${hsts}"`).not.toBeNull();
    expect(Number(maxAge?.[1])).toBeGreaterThanOrEqual(31_536_000);
    expect(hsts).toContain('includeSubDomains');
  });

  it('keeps the rest of the static security header set', () => {
    const headers = headersFor('/*');
    expect(headers.get('x-content-type-options')).toBe('nosniff');
    expect(headers.get('referrer-policy')).toBe(
      'strict-origin-when-cross-origin',
    );
    expect(headers.get('cross-origin-opener-policy')).toBe('same-origin');
    expect(headers.get('content-security-policy')).toContain(
      "script-src 'self'",
    );
    expect(headers.get('content-security-policy')).toContain(
      "frame-ancestors 'none'",
    );
    expect(headers.get('permissions-policy')).toContain('geolocation=()');
  });
});
