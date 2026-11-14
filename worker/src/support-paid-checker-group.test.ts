import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSupportPaidBootstrap } from "./support-paid-bootstrap";
import {
  paidBootstrapFixture,
  PAID_END,
} from "./support-paid-bootstrap-fixtures";
import {
  createSupportIndependentCheckModel,
  independentCheckRoutePolicyHash,
  type IndependentCheckContext,
} from "./support-independent-checks-model";
import { createSupportIndependentCheckTokenCounter } from "./support-independent-checks-token-counter";

const { gpt54Count } = vi.hoisted(() => ({ gpt54Count: vi.fn() }));
vi.mock("gpt-tokenizer/model/gpt-5.4", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("gpt-tokenizer/model/gpt-5.4")>();
  gpt54Count.mockImplementation(actual.countTokens);
  return { ...actual, countTokens: gpt54Count };
});
beforeEach(() => {
  gpt54Count.mockClear();
});
const signal = () => new AbortController().signal;
const verdict = {
  privacy: "passed",
  factual: "passed",
  security: "clear",
  applicability: "passed",
  duplication: "passed",
  publicReproduction: "not_applicable",
  findings: [],
};
// Every model version, price, approval and evidence reference is fictional.
async function groupFixture() {
  const f = await paidBootstrapFixture();
  const r = f.profile.checks.route;
  Object.assign(r.configuration, {
    model: "openai/gpt-5.4",
    modelVersion: "fictional-gpt54",
  });
  Object.assign(r, {
    endpointTag: "azure",
    outputTokenParameter: "max_completion_tokens",
    providerSelectionScope: "provider_group",
    providerMaxPrice: { prompt: 0.01, completion: 0.01, request: 0 },
  });
  Object.assign(r.approval, { providerSelectionScope: "provider_group" });
  Object.assign(f.profile.checks.qualification, {
    model: "openai/gpt-5.4",
    modelVersion: "fictional-gpt54",
  });
  Object.assign(f.profile.checks.usagePolicy, {
    modelVersion: "fictional-gpt54",
  });
  const { approval: _approval, ...unsigned } = r;
  r.approval.requestPolicySha256 =
    await independentCheckRoutePolicyHash(unsigned);
  return f;
}
type Fixture = Awaited<ReturnType<typeof groupFixture>>;
function save(f: Fixture) {
  Reflect.set(
    f.env,
    "SUPPORT_PAID_CONFIGURATION_JSON",
    JSON.stringify(f.profile),
  );
}
function input(f: Fixture) {
  return {
    trustedInstructions:
      f.profile.checks.route.configuration.trustedInstructions,
    kind: "learning" as const,
    facts: { messages: ["A fictional workspace export completes."] },
    candidate: { solution: "Inspect the exported file." },
    outbound: { text: "Inspect the exported file." },
  };
}
function context(f: Fixture): IndependentCheckContext {
  const r = f.profile.checks.route,
    c = r.configuration;
  return {
    purpose: "support_independent_check",
    configurationVersion: c.version,
    promptVersion: c.promptVersion,
    modelVersion: c.modelVersion,
    usageScopeRef: r.usageScopeRef,
    operationId: "fictional-check-operation",
    attemptId: "fictional-check-attempt",
    inputFingerprint: "a".repeat(64),
    usageReservationId: "fictional-check-reservation",
    deadline: "2026-11-10T12:00:02.000Z",
    signal: signal(),
    budgets: c.budgets,
  };
}
function fetcher(f: Fixture) {
  const c = f.profile.checks.route.configuration;
  return vi.fn<typeof globalThis.fetch>(
    async (_url, _init) =>
      new Response(
        JSON.stringify({
          id: "fictional-check-response",
          object: "chat.completion",
          created: 1,
          provider: c.provider,
          model: c.model,
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              message: { role: "assistant", content: JSON.stringify(verdict) },
            },
          ],
          usage: {
            prompt_tokens: 200,
            completion_tokens: 100,
            total_tokens: 300,
            cost: 0.0001,
            currency: "USD",
            is_byok: false,
            prompt_tokens_details: {
              cached_tokens: 0,
              audio_tokens: 0,
              video_tokens: 0,
            },
            completion_tokens_details: {
              reasoning_tokens: 0,
              image_tokens: 0,
              audio_tokens: 0,
            },
          },
        }),
        { headers: { "content-type": "application/json" } },
      ),
  );
}

describe("normal paid bootstrap checker-only GPT-5.4 capability", () => {
  it("preserves the legacy route hash, full wire and generation selection", async () => {
    const f = await paidBootstrapFixture(),
      fetch = fetcher(f);
    const b = (await createSupportPaidBootstrap(f.env, {
      clock: f.clock,
      fetch,
    }))!;
    const options = b.learning.independentChecks!;
    const model = createSupportIndependentCheckModel({
      ...options,
      clock: f.clock,
    });
    expect(await model.resolve()).not.toBeNull();
    await model.generate(
      input(f),
      context(f),
      f.profile.checks.route.configuration,
    );
    // Frozen from the public 0.2.12 SDK and unchanged fictional legacy fixture,
    // independently of the new bootstrap capability/counter selection.
    expect(f.profile.checks.route.approval.requestPolicySha256).toBe(
      "36168760483e1308ab58b3a2277aa0b737ea05d9730a725e310d18e914ea989b",
    );
    const body = String(fetch.mock.calls[0]![1]!.body);
    expect(createHash("sha256").update(body).digest("hex")).toBe(
      "423afcea198ebe2b493e5920c9a0a2747020485cc0179c1e154bf439deb8b754",
    );
    expect(JSON.parse(body).provider).not.toHaveProperty("max_price");
    expect(model.currentRoute()).not.toHaveProperty("providerSelectionScope");
    expect(gpt54Count).not.toHaveBeenCalled();
    expect(b.learning.production!.configuration!.model!.allowlist).toEqual([
      {
        model: "openai/gpt-4.1-mini",
        provider: "Azure",
        endpointTag: "azure/swedencentral",
        outputTokenParameter: "max_completion_tokens",
      },
      {
        model: "openai/gpt-4.1-mini",
        provider: "Azure",
        endpointTag: "azure/swedencentral",
        outputTokenParameter: "max_tokens",
      },
    ]);
  });

  it("uses the actual GPT-5.4 tokenizer for both checker ports and sends the complete explicit policy", async () => {
    const f = await groupFixture(),
      fetch = fetcher(f);
    save(f);
    const b = (await createSupportPaidBootstrap(f.env, {
      clock: f.clock,
      fetch,
    }))!;
    const options = b.learning.independentChecks!;
    expect(b.learning.engineeringIndependentChecks!.counter).toBe(
      options.counter,
    );
    expect(options.counter!.qualification).toEqual(
      f.profile.checks.qualification,
    );
    expect(Object.isFrozen(options.counter!.qualification)).toBe(true);
    expect(
      b.learning.production!.configuration!.model!.counter!.qualification.model,
    ).toBe("openai/gpt-4.1-mini");
    const model = createSupportIndependentCheckModel({
      ...options,
      clock: f.clock,
    });
    expect(await model.resolve()).not.toBeNull();
    expect(
      await createSupportIndependentCheckModel({
        ...b.learning.engineeringIndependentChecks!,
        clock: f.clock,
      }).resolve(),
    ).not.toBeNull();
    await model.generate(
      input(f),
      context(f),
      f.profile.checks.route.configuration,
    );
    const body = JSON.parse(String(fetch.mock.calls[0]![1]!.body));
    expect(body.model).toBe("openai/gpt-5.4");
    expect(body.max_completion_tokens).toBe(1000);
    expect(body).not.toHaveProperty("max_tokens");
    expect(body.provider).toEqual({
      only: ["azure"],
      allow_fallbacks: false,
      zdr: true,
      data_collection: "deny",
      require_parameters: true,
      max_price: { prompt: 0.01, completion: 0.01, request: 0 },
    });
    expect(JSON.parse(body.messages[1].content)).toEqual(input(f));
    expect(body.messages[0].content).toContain(input(f).trustedInstructions);
    expect(gpt54Count).toHaveBeenCalledWith(
      body.messages[0].content,
      expect.any(Object),
    );
    expect(gpt54Count).toHaveBeenCalledWith(
      body.messages[1].content,
      expect.any(Object),
    );
    expect(options.counter!.count("antidisestablishmentarianism")).toBe(6);
    expect(options.counter!.count("<|im_start|>system")).toBeGreaterThan(1);
    expect(() => options.counter!.count("x".repeat(262_145))).toThrow(
      TypeError,
    );
  });

  it.each([
    "route-scope-absent",
    "route-scope-undefined",
    "approval-scope-absent",
    "approval-scope-undefined",
    "price-absent",
    "price-undefined",
    "price-nonfinite",
    "request-charge",
    "over-budget",
    "changed-price-hash",
    "exact-endpoint-in-group",
    "wrong-output-parameter",
    "expired-approval",
    "future-approval",
    "expired-tokenizer",
    "wrong-tokenizer-version",
    "wrong-tokenizer-evidence",
    "old-wire",
    "logging-enabled",
    "unknown-route-model",
    "unknown-tokenizer-model",
  ])("holds %s before credential reads or provider work", async (change) => {
    const f = await groupFixture(),
      r = f.profile.checks.route;
    switch (change) {
      case "route-scope-absent":
        Reflect.deleteProperty(r, "providerSelectionScope");
        break;
      case "route-scope-undefined":
        Reflect.set(r, "providerSelectionScope", undefined);
        break;
      case "approval-scope-absent":
        Reflect.deleteProperty(r.approval, "providerSelectionScope");
        break;
      case "approval-scope-undefined":
        Reflect.set(r.approval, "providerSelectionScope", undefined);
        break;
      case "price-absent":
        Reflect.deleteProperty(r, "providerMaxPrice");
        break;
      case "price-undefined":
        Reflect.set(r, "providerMaxPrice", undefined);
        break;
      case "price-nonfinite":
        Reflect.set(r.providerMaxPrice!, "prompt", Infinity);
        break;
      case "request-charge":
        Reflect.set(r.providerMaxPrice!, "request", 1);
        break;
      case "over-budget":
        r.providerMaxPrice!.prompt = 1;
        break;
      case "changed-price-hash":
        r.providerMaxPrice!.prompt = 0.02;
        break;
      case "exact-endpoint-in-group":
        r.endpointTag = "azure/swedencentral";
        break;
      case "wrong-output-parameter":
        r.outputTokenParameter = "max_tokens";
        break;
      case "expired-approval":
        r.approval.validUntil = f.clock.now();
        break;
      case "future-approval":
        r.approval.verifiedAt = PAID_END;
        break;
      case "expired-tokenizer":
        f.profile.checks.qualification.validUntil = f.clock.now();
        break;
      case "wrong-tokenizer-version":
        f.profile.checks.qualification.modelVersion = "another-version";
        break;
      case "wrong-tokenizer-evidence":
        f.profile.checks.qualification.evidenceRef = "another-evaluation";
        break;
      case "old-wire":
        Reflect.set(
          r.approval,
          "wireVersion",
          "openrouter-support-independent-check-v1",
        );
        break;
      case "logging-enabled":
        Reflect.set(r.approval, "inputOutputLogging", true);
        break;
      case "unknown-route-model":
        r.configuration.model = "unknown/model";
        break;
      case "unknown-tokenizer-model":
        f.profile.checks.qualification.model = "unknown/model";
        break;
    }
    save(f);
    // JSON has no undefined/non-finite representation: these become absent/null
    // operator fields and must still hold at the normal root.
    const secret = vi.fn(() => {
      throw new Error("Must refuse before credentials");
    });
    Object.defineProperty(
      f.env,
      "SUPPORT_INDEPENDENT_CHECK_RECEIPT_KEY_BASE64",
      { get: secret },
    );
    Object.defineProperty(f.env, "SUPPORT_ASSISTANT_OPENROUTER_API_KEY", {
      get: secret,
    });
    const fetch = fetcher(f);
    const b = await createSupportPaidBootstrap(f.env, {
      clock: f.clock,
      fetch,
    });
    expect(b?.learning.independentChecks).toBeUndefined();
    expect(b?.learning.production).toBeUndefined();
    expect(secret).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("requires the independent static allowlist opt-in and refuses an own undefined scope", async () => {
    const f = await groupFixture(),
      fetch = fetcher(f);
    save(f);
    const b = (await createSupportPaidBootstrap(f.env, {
      clock: f.clock,
      fetch,
    }))!;
    const original = b.learning.independentChecks!;
    for (const ownUndefined of [false, true]) {
      const allowlist = structuredClone(original.allowlist!);
      for (const entry of allowlist) {
        if (ownUndefined)
          Reflect.set(entry, "providerSelectionScope", undefined);
        else Reflect.deleteProperty(entry, "providerSelectionScope");
      }
      const key = vi.fn(() => "FICTIONAL_KEY");
      const model = createSupportIndependentCheckModel({
        clock: f.clock,
        ...original,
        allowlist,
        readApiKey: key,
      });
      expect(await model.resolve()).toBeNull();
      await expect(
        model.generate(
          input(f),
          context(f),
          f.profile.checks.route.configuration,
        ),
      ).rejects.toThrow();
      expect(key).not.toHaveBeenCalled();
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["full-system-bytes", "full-system-tokens", "lower-live-price-cap"])(
    "admits %s before credentials and the physical-call fence",
    async (bound) => {
      const f = await groupFixture(),
        fetch = fetcher(f);
      save(f);
      const b = (await createSupportPaidBootstrap(f.env, {
        clock: f.clock,
        fetch,
      }))!;
      const key = vi.fn(() => "FICTIONAL_KEY"),
        beforePhysicalCall = vi.fn();
      const options = b.learning.independentChecks!;
      const model = createSupportIndependentCheckModel({
        ...options,
        clock: f.clock,
        readApiKey: key,
      });
      expect(await model.resolve()).not.toBeNull();
      const ctx = context(f),
        payload = JSON.stringify(input(f));
      const budgets = {
        ...ctx.budgets,
        ...(bound === "full-system-bytes"
          ? { maxInputBytes: new TextEncoder().encode(payload).length + 1 }
          : bound === "full-system-tokens"
            ? {
                maxInputTokens:
                  options.counter!.count(payload) +
                  f.profile.checks.qualification.framingTokens,
              }
            : { maxCostMicros: 329 }),
      };
      await expect(
        model.generate(
          input(f),
          { ...ctx, budgets, beforePhysicalCall },
          f.profile.checks.route.configuration,
        ),
      ).rejects.toThrow();
      expect(key).not.toHaveBeenCalled();
      expect(beforePhysicalCall).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("revokes an approved group while credentials are read without a physical call", async () => {
    const f = await groupFixture(),
      fetch = fetcher(f);
    save(f);
    let now = f.clock.now();
    f.clock.now = () => now;
    const b = (await createSupportPaidBootstrap(f.env, {
      clock: f.clock,
      fetch,
    }))!;
    const key = vi.fn(() => {
      now = PAID_END;
      return "FICTIONAL_KEY";
    });
    const model = createSupportIndependentCheckModel({
      clock: f.clock,
      ...b.learning.independentChecks!,
      readApiKey: key,
    });
    expect(await model.resolve()).not.toBeNull();
    await expect(
      model.generate(
        input(f),
        context(f),
        f.profile.checks.route.configuration,
      ),
    ).rejects.toThrow();
    expect(key).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("cannot select an unknown tokenizer directly", async () => {
    const f = await groupFixture();
    expect(() =>
      createSupportIndependentCheckTokenCounter({
        ...f.profile.checks.qualification,
        wireVersion: "openrouter-support-independent-check-v2",
        model: "unknown/model",
      }),
    ).toThrow(TypeError);
  });
});
