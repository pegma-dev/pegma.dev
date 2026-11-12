import {
  createSupportIndependentCheckModel as createModel,
  independentCheckRoutePolicyHash as routePolicyHash,
  type IndependentCheckModelOptions,
  type IndependentCheckRoute as SdkIndependentCheckRoute,
} from "@pegma/support-desk-ai/openrouter";

export {
  INDEPENDENT_CHECK_PURPOSE,
  INDEPENDENT_CHECK_WIRE,
  INDEPENDENT_CHECK_ENDPOINT,
  type IndependentCheckConfiguration,
  type IndependentCheckCounter,
  type IndependentCheckModelOptions,
  type IndependentCheckInput,
  type IndependentCheckContext,
  type IndependentCheckVerdict,
} from "@pegma/support-desk-ai/openrouter";

/** Retain the host's existing route contract and exact policy-hash input. */
export type IndependentCheckRoute = Omit<SdkIndependentCheckRoute, "host"> & {
  readonly host: "pegma.dev";
};
type Model = Omit<ReturnType<typeof createModel>, "currentRoute"> & {
  readonly currentRoute: (
    expected?: string,
  ) => IndependentCheckRoute | undefined;
};

export function independentCheckRoutePolicyHash(
  value: Omit<IndependentCheckRoute, "approval">,
): Promise<string> {
  return routePolicyHash(value);
}

/** Pass the original options object so current callback rebinding stays live. */
export function createSupportIndependentCheckModel(
  options: IndependentCheckModelOptions,
) {
  // The SDK checks this exact host on every route observation.
  return createModel(options, "pegma.dev") as Model;
}
