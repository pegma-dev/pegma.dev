import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import {
  BrowserNode,
  disposeSupportBrowsers,
  supportBrowser,
  type BrowserCall,
} from "./test-support-browser";

afterEach(disposeSupportBrowsers);
const account = {
  account: { subject: "synthetic-success-owner", email: "owner@example.test" },
  csrfToken: "synthetic-success-csrf",
};
function view(status = "resolved", messageId = "solution-1") {
  return {
    ticket: {
      id: "ticket-example",
      number: 1,
      marker: "[PEG-1]",
      subject: "Fictional badge",
      status,
      category: "question",
      handling: "human-active",
    },
    messages: [
      {
        id: messageId,
        ticketId: "ticket-example",
        visibility: "customer",
        authorKind: "staff",
        body: "Reload the fictional badge.",
        createdAt: "2026-11-12T12:00:00.000Z",
      },
    ],
    csrfToken: account.csrfToken,
  };
}
function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    values,
  };
}
describe("normal customer success action", () => {
  it("offers a fresh confirmation only for a resolved ticket", async () => {
    let status = "open";
    const page = supportBrowser("customer", (call) => ({
      body: call.path === "/api/identity/session" ? account : view(status),
    }));
    await page.until(() => !page.node("ticket-detail").hidden);
    expect(page.node("confirm-success").hidden).toBe(true);
    page.node("confirm-success").fire("click");
    await page.drain();
    expect(page.calls.filter((call) => call.method === "POST")).toEqual([]);
    for (const terminal of ["resolved", "closed"]) {
      status = terminal;
      page.node("ticket-reload").fire("click");
      await page.until(() => !page.node("ticket-detail").hidden);
      expect(page.node("confirm-success").hidden).toBe(terminal === "closed");
    }
  });
  it("retains the exact command and visible-message fence through lost ACK, fresh reads and a full page reload", async () => {
    const retained = storage();
    const sent: BrowserCall[] = [];
    let latestMessage = "solution-1";
    let latestStatus = "resolved";
    let attempts = 0;
    function respond(call: BrowserCall) {
      if (call.path === "/api/identity/session") return { body: account };
      if (call.path.endsWith("/confirm-success")) {
        sent.push(call);
        if (++attempts === 1) {
          latestMessage = "solution-2";
          latestStatus = "closed";
          throw new TypeError("Fictional lost acknowledgement");
        }
      }
      return { body: view(latestStatus, latestMessage) };
    }
    const first = supportBrowser("customer", respond);
    Object.assign(first.window, { sessionStorage: retained });
    await first.until(() => !first.node("confirm-success").disabled);
    first.node("confirm-success").fire("click");
    await first.until(
      () => sent.length === 1 && !first.node("confirm-success").disabled,
    );
    expect(sent).toHaveLength(1);
    expect(retained.values.size).toBe(1);
    const original = sent[0]!.body;
    expect(JSON.parse(original!)).toMatchObject({
      lastSeenVisibleMessageId: "solution-1",
    });
    first.node("ticket-reload").fire("click");
    await first.drain();
    expect(first.node("confirm-success").textContent).toContain("Retry");
    first.dispose();
    const second = supportBrowser("customer", respond);
    Object.assign(second.window, { sessionStorage: retained });
    await second.until(() => !second.node("confirm-success").disabled);
    expect(second.node("confirm-success").textContent).toContain("Retry");
    second.node("confirm-success").fire("click");
    await second.until(
      () =>
        second.node("ticket-status").textContent ===
        "Resolution confirmed. Thank you.",
    );
    expect(sent).toHaveLength(2);
    expect(sent[1]!.body).toBe(original);
    expect(second.node("ticket-status").textContent).toBe(
      "Resolution confirmed. Thank you.",
    );
    expect(retained.values.size).toBe(0);
  });
  it("does not replay another account's retained intent", async () => {
    let current = account;
    let calls = 0;
    const page = supportBrowser("customer", (call) => {
      if (call.path === "/api/identity/session") return { body: current };
      if (call.path.endsWith("/confirm-success")) {
        calls++;
        throw new TypeError("Fictional lost ACK");
      }
      return { body: view() };
    });
    Object.assign(page.window, { sessionStorage: storage() });
    await page.until(() => !page.node("confirm-success").disabled);
    page.node("confirm-success").fire("click");
    await page.drain();
    current = {
      ...account,
      account: { ...account.account, subject: "synthetic-other-owner" },
    };
    page.node("ticket-reload").fire("click");
    await page.drain();
    expect(page.node("ticket-detail").hidden).toBe(true);
    expect(page.node("confirm-success").disabled).toBe(true);
    page.node("confirm-success").fire("click");
    await page.drain();
    expect(calls).toBe(1);
  });
  it("requires a new explicit action after a stale-message conflict", async () => {
    let latest = "solution-1";
    const sent: BrowserCall[] = [];
    const page = supportBrowser("customer", (call) => {
      if (call.path === "/api/identity/session") return { body: account };
      if (call.path.endsWith("/confirm-success")) {
        sent.push(call);
        latest = "solution-2";
        return { status: 409, body: { error: "conflict" } };
      }
      return { body: view("resolved", latest) };
    });
    await page.until(() => !page.node("confirm-success").disabled);
    page.node("confirm-success").fire("click");
    await page.until(() =>
      page.node("ticket-status").textContent.includes("conversation changed"),
    );
    expect(sent).toHaveLength(1);
    expect(page.node("ticket-status").textContent).toContain(
      "conversation changed",
    );
    expect(page.node("confirm-success").textContent).not.toContain("Retry");
  });
});

describe("staff successful test UI packet compatibility", () => {
  it("submits the explicit successful-test receipt and retains the original flat staff fix", async () => {
    const root = new BrowserNode("section");
    const calls: { path: string; body?: string }[] = [];
    const identity = { subject: "synthetic-staff", csrfToken: "fixture-csrf" };
    const sandbox = {
      document: { createElement: (tag: string) => new BrowserNode(tag) },
      setTimeout,
      clearTimeout,
      AbortController,
      crypto: { randomUUID: () => crypto.randomUUID() },
    };
    runInNewContext(
      readFileSync(
        new URL("../public/staff-support-learning.js", import.meta.url),
        "utf8",
      ),
      sandbox,
    );
    const factory = (
      sandbox as typeof sandbox & {
        PegmaSupportLearning: {
          createPanel(options: unknown): {
            showTicket(ticket: unknown): Promise<void>;
            refresh(): Promise<void>;
            hasPending(): boolean;
          };
        };
      }
    ).PegmaSupportLearning;
    const panel = factory.createPanel({
      root,
      readSession: async () => identity,
      async request(path: string, init: RequestInit) {
        calls.push({
          path,
          body: typeof init?.body === "string" ? init.body : undefined,
        });
        return {
          result: {
            ticketId: "ticket-example",
            sourceGeneration: 1,
            resolutionCycle: 1,
            state: "eligible",
            reconciliationPending: false,
          },
          csrfToken: identity.csrfToken,
        };
      },
    });
    const selected = {
      ticketId: "ticket-example",
      revision: 7,
      actorSubject: identity.subject,
      status: "resolved",
      resolvedAt: "2026-11-12T12:00:00.000Z",
    };
    await panel.showTicket(selected);
    function field(name: string) {
      return root.all().find((node) => node.dataset.learningField === name)!;
    }
    function button(action: string) {
      return root.all().find((node) => node.dataset.learningAction === action)!;
    }
    field("solution").value = "solution-1";
    field("evidence-kind").value = "successful_test";
    field("test-receipt").value = "opaque-actually-verified-receipt";
    button("evidence").fire("click");
    for (let turn = 0; turn < 100; turn++) await Promise.resolve();
    expect(
      JSON.parse(calls.find((call) => call.body)?.body ?? "{}"),
    ).toMatchObject({
      kind: "successful_test",
      solutionMessageId: "solution-1",
      receipt: "opaque-actually-verified-receipt",
    });
    expect(
      JSON.parse(calls.find((call) => call.body)!.body!),
    ).not.toHaveProperty("verificationReference");
    await panel.refresh();
    field("solution").value = "solution-1";
    field("evidence-kind").value = "staff_verified_fix";
    field("verification").value = "explicit-staff-reference";
    button("evidence").fire("click");
    for (let turn = 0; turn < 100; turn++) await Promise.resolve();
    const flat = JSON.parse(calls.filter((call) => call.body).at(-1)!.body!);
    expect(flat.verificationReference).toBe("explicit-staff-reference");
    expect(flat).not.toHaveProperty("kind");
    expect(flat).not.toHaveProperty("receipt");
  });
});
