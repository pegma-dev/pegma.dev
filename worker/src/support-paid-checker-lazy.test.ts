import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSupportPaidBootstrap } from "./support-paid-bootstrap";
import { paidBootstrapFixture } from "./support-paid-bootstrap-fixtures";

const { loadGpt54 } = vi.hoisted(() => ({ loadGpt54: vi.fn() }));
vi.mock("./support-independent-checks-token-counter", () => {
  loadGpt54();
  throw new Error("Selected optional GPT-5.4 module reached");
});
beforeEach(() => {
  loadGpt54.mockClear();
});

describe("optional checker tokenizer module admission", () => {
  it("does not load GPT-5.4 for absent or malformed profiles", async () => {
    expect(await createSupportPaidBootstrap({})).toBeUndefined();
    expect(
      await createSupportPaidBootstrap({
        SUPPORT_PAID_CONFIGURATION_JSON: "{}",
      }),
    ).toBeUndefined();
    expect(loadGpt54).not.toHaveBeenCalled();
  });
  it("keeps the actual legacy mini profile ready without loading GPT-5.4", async () => {
    const f = await paidBootstrapFixture();
    const b = await createSupportPaidBootstrap(f.env, { clock: f.clock });
    expect(b?.learning.independentChecks?.counter?.qualification.model).toBe(
      "openai/gpt-4.1-mini",
    );
    expect(loadGpt54).not.toHaveBeenCalled();
  });
  it("refuses unknown models before loading GPT-5.4 or reading credentials", async () => {
    const f = await paidBootstrapFixture();
    f.profile.checks.qualification.model = "unknown/model";
    Reflect.set(
      f.env,
      "SUPPORT_PAID_CONFIGURATION_JSON",
      JSON.stringify(f.profile),
    );
    const key = vi.fn(() => {
      throw new Error("Must not read credentials");
    });
    Object.defineProperty(
      f.env,
      "SUPPORT_INDEPENDENT_CHECK_RECEIPT_KEY_BASE64",
      { get: key },
    );
    Object.defineProperty(f.env, "SUPPORT_ASSISTANT_OPENROUTER_API_KEY", {
      get: key,
    });
    expect(
      await createSupportPaidBootstrap(f.env, { clock: f.clock }),
    ).toBeUndefined();
    expect(loadGpt54).not.toHaveBeenCalled();
    expect(key).not.toHaveBeenCalled();
  });
  it("loads the optional module only after GPT-5.4 is selected and contains load failure", async () => {
    const f = await paidBootstrapFixture();
    f.profile.checks.qualification.model = "openai/gpt-5.4";
    Reflect.set(
      f.env,
      "SUPPORT_PAID_CONFIGURATION_JSON",
      JSON.stringify(f.profile),
    );
    const key = vi.fn(() => {
      throw new Error("Load failure must not reach credentials");
    });
    Object.defineProperty(
      f.env,
      "SUPPORT_INDEPENDENT_CHECK_RECEIPT_KEY_BASE64",
      { get: key },
    );
    Object.defineProperty(f.env, "SUPPORT_ASSISTANT_OPENROUTER_API_KEY", {
      get: key,
    });
    expect(
      await createSupportPaidBootstrap(f.env, { clock: f.clock }),
    ).toBeUndefined();
    expect(loadGpt54).toHaveBeenCalledOnce();
    expect(key).not.toHaveBeenCalled();
  });
});
