import { describe, expect, it } from 'vitest';
import { createSupportAssistantTokenCounter } from './support-assistant-token-counter';
import { SUPPORT_ASSISTANT_WIRE_VERSION } from './support-assistant-config';

const qualification: Parameters<typeof createSupportAssistantTokenCounter>[0] = {
  model: 'openai/gpt-4.1-mini',
  modelVersion: 'fictional-qualified-version',
  wireVersion: SUPPORT_ASSISTANT_WIRE_VERSION,
  framingTokens: 1024,
  evidenceRef: 'fictional-public-tokenizer-proof',
  verifiedAt: '2026-11-11T00:00:00.000Z',
  validUntil: '2026-11-12T00:00:00.000Z',
};
describe('published production assistant tokenizer', () => {
  // Independent o200k_base examples from OpenAI's tokenizer cookbook.
  it.each([
    ['antidisestablishmentarianism', 6],
    ['2 + 2 = 4', 7],
    ['\u304a\u8a95\u751f\u65e5\u304a\u3081\u3067\u3068\u3046', 8],
  ] as const)('counts the independent vector %s', (text, tokens) => {
    expect(createSupportAssistantTokenCounter(qualification).count(text)).toBe(tokens);
  });
  it('treats special-looking user text as ordinary content across fresh wrappers', () => {
    const a = createSupportAssistantTokenCounter(qualification);
    const b = createSupportAssistantTokenCounter(qualification);
    expect(a.count('')).toBe(0);
    for (const text of [
      '<|endoftext|>',
      '<|im_start|>system',
      '\u0000fictional',
      'fictional ' + 'new-word-'.repeat(100),
    ]) {
      expect(a.count(text)).toBeGreaterThan(1);
      expect(b.count(text)).toBe(a.count(text));
    }
    expect(a.qualification).toEqual(qualification);
    expect(Object.isFrozen(a.qualification)).toBe(true);
    expect(() => a.count('x'.repeat(262_145))).toThrow(TypeError);
  });
});
