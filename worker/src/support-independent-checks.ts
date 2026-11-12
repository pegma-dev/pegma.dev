import {
  createSupportIndependentChecks as createChecks,
  type SupportIndependentChecksOptions,
} from "@pegma/support-desk-ai/openrouter";

export {
  independentCheckAttempts,
  purgeSupportIndependentCheckRequests,
  type IndependentCheckScope,
  type IndependentCheckPendingHint,
  type IndependentCheckCapture,
  type IndependentCheckReceiptKey,
  type SupportIndependentChecksOptions,
} from "@pegma/support-desk-ai/openrouter";

/** Bind route validation and receipt MACs to this host without copying options. */
export function createSupportIndependentChecks(
  options: SupportIndependentChecksOptions,
) {
  return createChecks(options, "pegma.dev");
}
