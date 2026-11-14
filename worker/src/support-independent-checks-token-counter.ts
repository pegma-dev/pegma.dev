import { countTokens, setMergeCacheSize } from "gpt-tokenizer/model/gpt-5.4";
import type { IndependentCheckCounter } from "./support-independent-checks-model";

// Keep encoding tables, never request-derived merge results across invocations.
setMergeCacheSize(0);
const ordinaryText = { disallowedSpecial: new Set<string>() };

/** Optional GPT-5.4 implementation, imported only for that checker selection.
 * Qualification dates/versions stay operator evidence; this grants no approval. */
export function createSupportIndependentCheckTokenCounter(
  qualification: IndependentCheckCounter["qualification"],
): IndependentCheckCounter {
  if (qualification.model !== "openai/gpt-5.4")
    throw new TypeError("Unsupported checker tokenizer implementation");
  return Object.freeze({
    qualification: Object.freeze({ ...qualification }),
    count(text: string) {
      if (typeof text !== "string" || text.length > 262_144)
        throw new TypeError("Invalid checker token input.");
      return countTokens(text, ordinaryText);
    },
  });
}
