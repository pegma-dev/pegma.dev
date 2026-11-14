import { countTokens, setMergeCacheSize } from "gpt-tokenizer/model/gpt-5.4";
import {
  countTokens as countMiniTokens,
  setMergeCacheSize as setMiniMergeCacheSize,
} from "gpt-tokenizer/model/gpt-4.1-mini";
import type { IndependentCheckCounter } from "./support-independent-checks-model";

// Keep encoding tables, never request-derived merge results across invocations.
setMergeCacheSize(0);
setMiniMergeCacheSize(0);
const ordinaryText = { disallowedSpecial: new Set<string>() };
countTokens("", ordinaryText);

/** Select an implemented checker tokenizer, never infer route approval or dates.
 * Generator and customer-answer counters retain their existing selection. */
export function createSupportIndependentCheckTokenCounter(
  qualification: IndependentCheckCounter["qualification"],
): IndependentCheckCounter {
  const count =
    qualification.model === "openai/gpt-4.1-mini"
      ? countMiniTokens
      : qualification.model === "openai/gpt-5.4"
        ? countTokens
        : undefined;
  if (!count)
    throw new TypeError("Unsupported checker tokenizer implementation");
  return Object.freeze({
    qualification: Object.freeze({ ...qualification }),
    count(text: string) {
      if (typeof text !== "string" || text.length > 262_144)
        throw new TypeError("Invalid checker token input.");
      return count(text, ordinaryText);
    },
  });
}
