import { countTokens, setMergeCacheSize } from 'gpt-tokenizer/model/gpt-4.1-mini';
import type { QualifiedSupportAssistantCounter } from './support-assistant-config';

// Retain immutable encoding tables, never input-word merge results across requests.
setMergeCacheSize(0);
const ordinaryText = { disallowedSpecial: new Set<string>() };
countTokens('', ordinaryText);

export const SUPPORT_ASSISTANT_FRAMING_TOKENS = 1024;

/** Qualification is operator evidence data; the implementation is always this
 * exact published model tokenizer with literal special markers treated as text. */
export function createSupportAssistantTokenCounter(
  qualification: QualifiedSupportAssistantCounter['qualification'],
): QualifiedSupportAssistantCounter {
  return Object.freeze({
    qualification: Object.freeze({ ...qualification }),
    count(text: string) {
      if (typeof text !== 'string' || text.length > 262_144)
        throw new TypeError('Invalid assistant token input.');
      return countTokens(text, ordinaryText);
    },
  });
}
