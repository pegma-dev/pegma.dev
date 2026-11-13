import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import {
  BrowserNode,
  browserGate,
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
    await page.until(
      () => calls === 1 && !page.node("confirm-success").disabled,
    );
    current = {
      ...account,
      account: { ...account.account, subject: "synthetic-other-owner" },
    };
    page.node("ticket-reload").fire("click");
    await page.until(() => !page.node("ticket-detail").hidden);
    expect(page.node("ticket-detail").hidden).toBe(false);
    expect(page.node("confirm-success").textContent).not.toContain("Retry");
    expect(calls).toBe(1);
    current = account;
    page.node("ticket-reload").fire("click");
    await page.until(() => !page.node("ticket-detail").hidden);
    expect(page.node("confirm-success").textContent).toContain("Retry");
  });
  it.each([
    "{",
    "null",
    "[]",
    JSON.stringify({
      subject: account.account.subject,
      ticketId: "ticket-example",
      body: "null",
    }),
    JSON.stringify({
      subject: account.account.subject,
      ticketId: "ticket-example",
      body: [
        JSON.stringify({
          commandId: "00112233-4455-4677-8899-aabbccddeeff",
          lastSeenVisibleMessageId: "solution-1",
        }),
      ],
    }),
    JSON.stringify({
      subject: account.account.subject,
      ticketId: "ticket-example",
      body: JSON.stringify({
        commandId: ["00112233-4455-4677-8899-aabbccddeeff"],
        lastSeenVisibleMessageId: "solution-1",
      }),
    }),
    JSON.stringify({
      subject: account.account.subject,
      ticketId: "ticket-example",
      body: "{",
    }),
    JSON.stringify({
      subject: "another-owner",
      ticketId: "ticket-example",
      body: JSON.stringify({
        commandId: "00112233-4455-4677-8899-aabbccddeeff",
        lastSeenVisibleMessageId: "solution-1",
      }),
    }),
    JSON.stringify({
      subject: account.account.subject,
      ticketId: "another-ticket",
      body: JSON.stringify({
        commandId: "00112233-4455-4677-8899-aabbccddeeff",
        lastSeenVisibleMessageId: "solution-1",
      }),
    }),
    JSON.stringify({
      subject: account.account.subject,
      ticketId: "ticket-example",
      body: JSON.stringify({
        commandId: "bad",
        lastSeenVisibleMessageId: "solution-1",
      }),
    }),
    JSON.stringify({
      subject: account.account.subject,
      ticketId: "ticket-example",
      body: JSON.stringify({
        commandId: "00112233-4455-4677-8899-aabbccddeeff",
        lastSeenVisibleMessageId: "solution-1",
        extra: true,
      }),
    }),
  ])(
    "loads authorized ticket reads without replaying invalid saved data: %s",
    async (saved) => {
      const retained = storage();
      const key =
        "pegma.support.success.v1:" +
        encodeURIComponent(account.account.subject) +
        ":ticket-example";
      retained.setItem(key, saved);
      const page = supportBrowser("customer", (call) => ({
        body: call.path === "/api/identity/session" ? account : view(),
      }));
      Object.assign(page.window, { sessionStorage: retained });
      await page.until(() => !page.node("ticket-detail").hidden);
      expect(page.node("ticket-status").textContent).toBe("Ticket loaded.");
      expect(page.node("confirm-success").textContent).not.toContain("Retry");
      expect(page.calls.filter((call) => call.method === "POST")).toEqual([]);
      expect(retained.getItem(key)).toBe(saved);
      page.node("ticket-reload").fire("click");
      await page.until(() => !page.node("ticket-detail").hidden);
      expect(page.node("ticket-detail").hidden).toBe(false);
    },
  );
  it("preserves the exact pending owner across A to B to A when session storage is unavailable", async () => {
    let current = account;
    const sent: BrowserCall[] = [];
    const page = supportBrowser("customer", (call) => {
      if (call.path === "/api/identity/session") return { body: current };
      if (call.path.endsWith("/confirm-success")) {
        sent.push(call);
        if (sent.length === 1) throw new Error("Fictional lost ACK");
      }
      return { body: { ...view(), csrfToken: current.csrfToken } };
    });
    Object.assign(page.window, {
      sessionStorage: {
        getItem() {
          throw new Error("unavailable");
        },
        setItem() {
          throw new Error("unavailable");
        },
        removeItem() {
          throw new Error("unavailable");
        },
      },
    });
    await page.until(() => !page.node("confirm-success").disabled);
    page.node("confirm-success").fire("click");
    await page.until(
      () => sent.length === 1 && !page.node("confirm-success").disabled,
    );
    expect(sent).toHaveLength(1);
    current = {
      account: { ...account.account, subject: "other-owner" },
      csrfToken: "other-csrf",
    };
    page.node("ticket-reload").fire("click");
    await page.until(
      () =>
        !page.node("ticket-detail").hidden &&
        !page.node("confirm-success").disabled,
    );
    expect(page.node("ticket-detail").hidden).toBe(false);
    expect(page.node("confirm-success").textContent).not.toContain("Retry");
    expect(sent).toHaveLength(1);
    current = account;
    page.node("ticket-reload").fire("click");
    await page.until(
      () =>
        !page.node("ticket-detail").hidden &&
        !page.node("confirm-success").disabled,
    );
    expect(page.node("confirm-success").textContent).toContain("Retry");
    page.node("confirm-success").fire("click");
    await page.until(
      () =>
        page.node("ticket-status").textContent ===
        "Resolution confirmed. Thank you.",
    );
    expect(sent).toHaveLength(2);
    expect(sent[1]!.body).toBe(sent[0]!.body);
    expect(sent[1]!.headers.get("X-Pegma-CSRF")).toBe(account.csrfToken);
  });
  it("replays a valid restored owner's exact JSON bytes without rebuilding its message fence", async () => {
    const retained = storage();
    const body =
      '{ "lastSeenVisibleMessageId": "solution-1", "commandId": "00112233-4455-4677-8899-aabbccddeeff" }';
    retained.setItem(
      "pegma.support.success.v1:" +
        encodeURIComponent(account.account.subject) +
        ":ticket-example",
      JSON.stringify({
        subject: account.account.subject,
        ticketId: "ticket-example",
        body,
      }),
    );
    const sent: BrowserCall[] = [];
    const page = supportBrowser("customer", (call) => {
      if (call.path === "/api/identity/session") return { body: account };
      if (call.path.endsWith("/confirm-success")) sent.push(call);
      return { body: view("closed", "solution-newer") };
    });
    Object.assign(page.window, { sessionStorage: retained });
    await page.until(() => !page.node("confirm-success").disabled);
    expect(page.node("confirm-success").textContent).toContain("Retry");
    page.node("confirm-success").fire("click");
    await page.until(
      () =>
        page.node("ticket-status").textContent ===
        "Resolution confirmed. Thank you.",
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toBe(body);
    expect(retained.values.size).toBe(0);
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
      testReceiptEnabled: () => true,
      readSession: async () => identity,
      async request(path: string, init: RequestInit) {
        calls.push({
          path,
          body: typeof init?.body === "string" ? init.body : undefined,
        });
        if (path === "/api/staff/knowledge/command") return confirmedReport();
        if (path.endsWith("/test-receipt")) {
          const command = JSON.parse(String(init.body));
          return {
            result: {
              actorId: identity.subject,
              ticketId: "ticket-example",
              commandId: command.commandId,
              receipt: "opaque-actually-verified-receipt",
              validUntil: "2099-01-01T00:00:00.000Z",
            },
            csrfToken: identity.csrfToken,
          };
        }
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
    field("report-article").value = "Article-A";
    field("report-ledger").value = "1";
    field("report-id").value = "Report-A";
    button("report-read").fire("click");
    for (let turn = 0; turn < 100; turn++) await Promise.resolve();
    button("report-associate").fire("click");
    for (let turn = 0; turn < 100; turn++) await Promise.resolve();
    button("evidence").fire("click");
    for (let turn = 0; turn < 100; turn++) await Promise.resolve();
    expect(
      JSON.parse(
        calls.find((call) => call.path.endsWith("/evidence"))?.body ?? "{}",
      ),
    ).toMatchObject({
      kind: "successful_test",
      solutionMessageId: "solution-1",
      receipt: "opaque-actually-verified-receipt",
    });
    expect(
      JSON.parse(calls.find((call) => call.path.endsWith("/evidence"))!.body!),
    ).not.toHaveProperty("verificationReference");
    await panel.refresh();
    field("solution").value = "solution-1";
    field("evidence-kind").value = "staff_verified_fix";
    field("evidence-kind").fire("change");
    field("verification").value = "explicit-staff-reference";
    button("evidence").fire("click");
    for (let turn = 0; turn < 100; turn++) await Promise.resolve();
    const flat = JSON.parse(calls.filter((call) => call.body).at(-1)!.body!);
    expect(flat.verificationReference).toBe("explicit-staff-reference");
    expect(flat).not.toHaveProperty("kind");
    expect(flat).not.toHaveProperty("receipt");
  });
});
function confirmedReport() {
  return {
    articleId: "Article-A",
    ledgerEpoch: 1,
    reportId: "Report-A",
    reportGeneration: 2,
    expectedReportGeneration: 2,
    status: "confirmed",
    receipt: "e1.1.Report-A",
    reviewBindingHash: "a".repeat(64),
    confirmation: {
      reviewerId: "separate-knowledge-reviewer",
      confirmedAt: "2026-11-12T12:00:00.000Z",
    },
    report: {
      summary: "<img src=x onerror=alert(1)>",
      details: "A fictional confirmed report, displayed as inert text.",
    },
    evidence: { result: "passed" },
  };
}

type TestReportCall = {
  path: string;
  body?: string;
  csrf: string | null;
  signal?: AbortSignal | null;
};

function reportPanel() {
  const root = new BrowserNode("section");
  const calls: TestReportCall[] = [];
  const state = {
    subject: "staff-a",
    csrfToken: "csrf-a",
    capability: true as unknown,
    sessionError: 0,
    report: confirmedReport(),
    onRequest: undefined as
      ((call: TestReportCall) => Promise<unknown> | unknown) | undefined,
  };
  let nextCommand = 0;
  const sandbox = {
    document: { createElement: (tag: string) => new BrowserNode(tag) },
    AbortController,
    crypto: { randomUUID: () => "unused-random-id" },
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
          suspend(): void;
          hasPending(): boolean;
        };
      };
    }
  ).PegmaSupportLearning;
  const panel = factory.createPanel({
    root,
    testReceiptEnabled: () => state.capability,
    commandId: () => `Original-Command-${++nextCommand}`,
    readSession: async () => {
      if (state.sessionError)
        throw Object.assign(new Error("Current access unavailable"), {
          status: state.sessionError,
        });
      return { subject: state.subject, csrfToken: state.csrfToken };
    },
    async request(path: string, init: RequestInit = {}) {
      const call = {
        path,
        body: typeof init.body === "string" ? init.body : undefined,
        csrf: new Headers(init.headers).get("X-Pegma-CSRF"),
        signal: init.signal,
      };
      calls.push(call);
      const overridden = await state.onRequest?.(call);
      if (overridden !== undefined) return overridden;
      if (path === "/api/staff/knowledge/command") return state.report;
      const ticketId = decodeURIComponent(path.split("/")[5]!);
      const input = call.body ? JSON.parse(call.body) : undefined;
      const source = {
        ticketId,
        sourceGeneration: 1,
        resolutionCycle: 3,
        state: "eligible",
        reconciliationPending: false,
      };
      const result = path.endsWith("/test-receipt")
        ? {
            actorId: input.expectedPrincipalId,
            ticketId,
            commandId: input.commandId,
            receipt: "opaque-support-receipt",
            validUntil: "2099-01-01T00:00:00.000Z",
          }
        : path.endsWith("/evidence-recovery")
          ? {
              outcome: "accepted",
              ticketId,
              commandId: input.commandId,
              operation: "evidence",
              result: source,
            }
          : source;
      return { result, csrfToken: state.csrfToken };
    },
  });
  const field = (key: string) => {
    const found = root.all().find((node) => node.dataset.learningField === key);
    if (!found) throw new Error("Missing learning field " + key);
    return found;
  };
  const button = (key: string) => {
    const found = root
      .all()
      .find((node) => node.dataset.learningAction === key);
    if (!found) throw new Error("Missing learning action " + key);
    return found;
  };
  const selected = (ticketId = "Ticket-A", revision = 7) => ({
    ticketId,
    revision,
    actorSubject: state.subject,
    status: "resolved",
    resolvedAt: "2026-11-12T12:00:00.000Z",
  });
  const settle = async () => {
    for (let turn = 0; turn < 150; turn++) await Promise.resolve();
  };
  async function readReport() {
    field("solution").value = "Solution-A";
    field("evidence-kind").value = "successful_test";
    field("report-article").value = "Article-A";
    field("report-ledger").value = "1";
    field("report-id").value = "Report-A";
    button("report-read").fire("click");
    await settle();
  }
  return {
    root,
    calls,
    state,
    panel,
    field,
    button,
    selected,
    settle,
    readReport,
    writes: () => calls.filter((call) => call.body !== undefined),
  };
}

describe("staff report association ownership in the actual learning panel", () => {
  it.each([undefined, false, "true", 1])(
    "does not prepare new receipts without strict capability %s",
    async (capability) => {
      const page = reportPanel();
      page.state.capability = capability;
      await page.panel.showTicket(page.selected());
      expect(page.button("report-read").disabled).toBe(true);
      expect(page.button("report-associate").disabled).toBe(true);
      expect(
        page.root
          .all()
          .find((node) => node.dataset.learningField === "test-receipt"),
      ).toBeUndefined();
      page.button("report-read").fire("click");
      await page.settle();
      expect(page.writes()).toHaveLength(0);
    },
  );

  it("reads a direct permitted report and freezes the original case-sensitive preparation and evidence coordinates", async () => {
    const page = reportPanel();
    await page.panel.showTicket(page.selected());
    await page.readReport();
    const read = page.writes()[0]!;
    expect(read.path).toBe("/api/staff/knowledge/command");
    expect(JSON.parse(read.body!)).toEqual({
      operation: "reportRead",
      input: { articleId: "Article-A", ledgerEpoch: 1, reportId: "Report-A" },
    });
    expect(read.csrf).toBe("csrf-a");
    expect(read.signal).toBeInstanceOf(AbortSignal);
    expect(page.root.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(page.button("report-associate").disabled).toBe(false);
    page.button("report-associate").fire("click");
    await page.settle();
    expect(page.panel.hasPending()).toBe(true);
    const prepare = page.writes()[1]!;
    expect(prepare.path).toBe(
      "/api/support/admin/tickets/Ticket-A/learning/test-receipt",
    );
    expect(JSON.parse(prepare.body!)).toEqual({
      commandId: "Original-Command-1",
      expectedPrincipalId: "staff-a",
      expectedRevision: 7,
      resolutionCycle: 3,
      solutionMessageId: "Solution-A",
      report: {
        articleId: "Article-A",
        ledgerEpoch: 1,
        reportId: "Report-A",
        expectedReportGeneration: 2,
        reviewBindingHash: "a".repeat(64),
        receipt: "e1.1.Report-A",
      },
    });
    expect(
      page.writes().filter((call) => call.path.endsWith("/evidence")),
    ).toHaveLength(0);
    page.button("evidence").fire("click");
    await page.settle();
    expect(JSON.parse(page.writes()[2]!.body!)).toEqual({
      commandId: "Original-Command-2",
      expectedRevision: 7,
      resolutionCycle: 3,
      solutionMessageId: "Solution-A",
      kind: "successful_test",
      receipt: "opaque-support-receipt",
    });
    expect(page.panel.hasPending()).toBe(false);
  });

  it.each([
    { status: "pending" },
    { status: "rejected" },
    { evidence: { result: "failed" } },
    { confirmation: null },
  ])(
    "shows an unqualified report without allowing association: %j",
    async (changed) => {
      const page = reportPanel();
      Object.assign(page.state.report, changed);
      await page.panel.showTicket(page.selected());
      await page.readReport();
      expect(page.root.textContent).toContain(
        "existing Knowledge confirmation workflow",
      );
      expect(page.button("report-associate").disabled).toBe(true);
      page.button("report-associate").fire("click");
      await page.settle();
      expect(page.writes()).toHaveLength(1);
    },
  );

  it.each([
    { articleId: "Other-Article" },
    { reportId: "other-report" },
    { ledgerEpoch: 2 },
    { receipt: "r".repeat(201) },
    { expectedReportGeneration: 1 },
    { reviewBindingHash: "A".repeat(64) },
  ])(
    "refuses malformed or differently scoped report pins: %j",
    async (changed) => {
      const page = reportPanel();
      Object.assign(page.state.report, changed);
      await page.panel.showTicket(page.selected());
      await page.readReport();
      expect(page.button("report-associate").disabled).toBe(true);
      expect(page.panel.hasPending()).toBe(false);
      expect(page.root.textContent).not.toContain(
        "<img src=x onerror=alert(1)>",
      );
    },
  );

  it("replays an unknown prepare using the exact original packet despite changed fields and ticket revision", async () => {
    const page = reportPanel();
    let lost = true;
    page.state.onRequest = (call) => {
      if (call.path.endsWith("/test-receipt") && lost) {
        lost = false;
        throw new TypeError("Fictional lost prepare ACK");
      }
    };
    await page.panel.showTicket(page.selected());
    await page.readReport();
    page.button("report-associate").fire("click");
    await page.settle();
    const original = page.writes()[1]!;
    expect(page.panel.hasPending()).toBe(true);
    await page.panel.showTicket(page.selected("Ticket-A", 99));
    page.field("solution").value = "Changed-solution";
    page.field("report-id").value = "Changed-report";
    page.state.capability = false;
    page.button("retry").fire("click");
    await page.settle();
    const repeated = page.writes()[2]!;
    expect(repeated.path).toBe(original.path);
    expect(repeated.body).toBe(original.body);
    expect(page.root.textContent).toContain("Report associated");
    page.button("evidence").fire("click");
    await page.settle();
    expect(JSON.parse(page.writes()[3]!.body!)).toMatchObject({
      expectedRevision: 7,
      resolutionCycle: 3,
      solutionMessageId: "Solution-A",
    });
  });

  it("retains prepared evidence and its receipt-first recovery after report/config removal", async () => {
    const page = reportPanel();
    let loseEvidence = true;
    page.state.onRequest = (call) => {
      if (call.path.endsWith("/evidence") && loseEvidence) {
        loseEvidence = false;
        throw new TypeError("Fictional lost SDK ACK");
      }
      if (
        call.path === "/api/staff/knowledge/command" &&
        page.state.capability === false
      )
        throw Object.assign(new Error("Unavailable old report"), {
          status: 404,
        });
    };
    await page.panel.showTicket(page.selected());
    await page.readReport();
    page.button("report-associate").fire("click");
    await page.settle();
    page.state.capability = false;
    await page.panel.showTicket(page.selected("Ticket-A", 8));
    page.button("retry").fire("click");
    await page.settle();
    const original = page
      .writes()
      .find((call) => call.path.endsWith("/evidence"))!;
    expect(original).toBeDefined();
    await page.panel.refresh();
    page.button("retry").fire("click");
    await page.settle();
    const recovered = page
      .writes()
      .find((call) => call.path.endsWith("/evidence-recovery"))!;
    expect(recovered.body).toBe(original.body);
    expect(page.panel.hasPending()).toBe(false);
    expect(
      page.calls.filter((call) => call.path === "/api/staff/knowledge/command"),
    ).toHaveLength(1);
    expect(
      page.calls.filter((call) => call.path.endsWith("/test-receipt")),
    ).toHaveLength(1);
  });

  it.each([
    "actorId",
    "ticketId",
    "commandId",
    "receipt",
    "validUntil",
    "extra",
  ])("retains the raw prepare owner after an invalid ACK %s", async (key) => {
    const page = reportPanel();
    page.state.onRequest = (call) => {
      if (!call.path.endsWith("/test-receipt")) return;
      const input = JSON.parse(call.body!);
      const result: Record<string, unknown> = {
        actorId: "staff-a",
        ticketId: "Ticket-A",
        commandId: input.commandId,
        receipt: "opaque-support-receipt",
        validUntil: "2099-01-01T00:00:00.000Z",
      };
      result[key] = key === "receipt" ? "r".repeat(201) : "wrong-scope";
      return { result, csrfToken: "csrf-a" };
    };
    await page.panel.showTicket(page.selected());
    await page.readReport();
    page.button("report-associate").fire("click");
    await page.settle();
    expect(page.panel.hasPending()).toBe(true);
    expect(page.button("evidence").disabled).toBe(true);
    expect(page.root.textContent).not.toContain("Report associated");
    expect(
      page.writes().filter((call) => call.path.endsWith("/evidence")),
    ).toHaveLength(0);
  });

  it("fences an old report-read callback after navigating to another ticket", async () => {
    const page = reportPanel();
    const barrier = browserGate<unknown>();
    page.state.onRequest = (call) =>
      call.path === "/api/staff/knowledge/command"
        ? barrier.promise
        : undefined;
    await page.panel.showTicket(page.selected());
    const reading = page.readReport();
    await page.settle();
    const request = page.writes()[0]!;
    await page.panel.showTicket(page.selected("Ticket-B", 20));
    barrier.resolve(confirmedReport());
    await reading;
    await page.settle();
    expect(request.signal?.aborted).toBe(true);
    expect(page.root.textContent).not.toContain("<img src=x onerror=alert(1)>");
    expect(page.button("report-associate").disabled).toBe(true);
    expect(page.panel.hasPending()).toBe(false);
  });

  it("does not let A's late prepare ACK overwrite B or issue evidence on B", async () => {
    const page = reportPanel();
    const barrier = browserGate<unknown>();
    page.state.onRequest = (call) =>
      call.path.endsWith("/test-receipt") ? barrier.promise : undefined;
    await page.panel.showTicket(page.selected());
    await page.readReport();
    page.button("report-associate").fire("click");
    await page.settle();
    const original = page.writes()[1]!;
    await page.panel.showTicket(page.selected("Ticket-B", 20));
    barrier.resolve({
      result: {
        actorId: "staff-a",
        ticketId: "Ticket-A",
        commandId: "Original-Command-1",
        receipt: "opaque-support-receipt",
        validUntil: "2099-01-01T00:00:00.000Z",
      },
      csrfToken: "csrf-a",
    });
    await page.settle();
    expect(page.panel.hasPending()).toBe(true);
    expect(page.root.textContent).not.toContain("Report associated");
    expect(page.button("retry").disabled).toBe(true);
    expect(page.button("evidence").disabled).toBe(true);
    expect(page.writes()).toHaveLength(2);
    page.state.onRequest = undefined;
    await page.panel.showTicket(page.selected());
    page.button("retry").fire("click");
    await page.settle();
    expect(page.writes()[2]!.body).toBe(original.body);
    expect(page.root.textContent).toContain("Report associated");
  });

  it.each(["subject", "csrfToken"] as const)(
    "requires closing same-session access after prepare: %s",
    async (changed) => {
      const page = reportPanel();
      page.state.onRequest = (call) => {
        if (!call.path.endsWith("/test-receipt")) return;
        const input = JSON.parse(call.body!);
        page.state[changed] = "changed-owner-or-session";
        return {
          result: {
            actorId: "staff-a",
            ticketId: "Ticket-A",
            commandId: input.commandId,
            receipt: "opaque-support-receipt",
            validUntil: "2099-01-01T00:00:00.000Z",
          },
          csrfToken: "csrf-a",
        };
      };
      await page.panel.showTicket(page.selected());
      await page.readReport();
      page.button("report-associate").fire("click");
      await page.settle();
      expect(page.panel.hasPending()).toBe(true);
      expect(page.root.textContent).not.toContain("Report associated");
      expect(page.root.textContent).not.toContain(
        "<img src=x onerror=alert(1)>",
      );
      expect(
        page.writes().filter((call) => call.path.endsWith("/evidence")),
      ).toHaveLength(0);
    },
  );
  it("requires a new report read after changing its visible coordinates", async () => {
    const page = reportPanel();
    await page.panel.showTicket(page.selected());
    await page.readReport();
    page.field("report-id").value = "Report-B";
    page.button("report-associate").fire("click");
    await page.settle();
    expect(page.writes()).toHaveLength(1);
    expect(page.panel.hasPending()).toBe(false);
    page.field("report-id").fire("input");
    expect(page.button("report-associate").disabled).toBe(true);
    expect(page.root.textContent).not.toContain("<img src=x onerror=alert(1)>");
  });

  it("clears private report presentation when current report access is denied", async () => {
    const page = reportPanel();
    await page.panel.showTicket(page.selected());
    await page.readReport();
    page.state.onRequest = (call) => {
      if (call.path === "/api/staff/knowledge/command")
        throw Object.assign(new Error("Current Knowledge access denied"), {
          status: 403,
        });
    };
    page.button("report-read").fire("click");
    await page.settle();
    expect(page.root.textContent).not.toContain("<img src=x onerror=alert(1)>");
    expect(page.button("report-associate").disabled).toBe(true);
    expect(page.panel.hasPending()).toBe(false);
  });

  it("keeps preparation pending if closing current access is revoked", async () => {
    const page = reportPanel();
    page.state.onRequest = (call) => {
      if (call.path.endsWith("/test-receipt")) page.state.sessionError = 403;
    };
    await page.panel.showTicket(page.selected());
    await page.readReport();
    page.button("report-associate").fire("click");
    await page.settle();
    const original = page.writes()[1]!;
    expect(page.panel.hasPending()).toBe(true);
    expect(page.root.textContent).not.toContain("Report associated");
    expect(page.root.textContent).not.toContain("<img src=x onerror=alert(1)>");
    page.state.sessionError = 0;
    page.state.onRequest = undefined;
    await page.panel.refresh();
    page.button("retry").fire("click");
    await page.settle();
    expect(page.writes()[2]!.body).toBe(original.body);
    expect(page.root.textContent).toContain("Report associated");
  });

  it("retains prepared evidence under its original actor while another account is current", async () => {
    const page = reportPanel();
    await page.panel.showTicket(page.selected());
    await page.readReport();
    page.button("report-associate").fire("click");
    await page.settle();
    page.state.subject = "staff-b";
    page.state.csrfToken = "csrf-b";
    await page.panel.showTicket(page.selected());
    expect(page.button("retry").disabled).toBe(true);
    expect(page.button("evidence").disabled).toBe(true);
    expect(page.root.textContent).not.toContain("<img src=x onerror=alert(1)>");
    expect(page.writes()).toHaveLength(2);
    page.state.subject = "staff-a";
    page.state.csrfToken = "csrf-a";
    page.state.capability = false;
    await page.panel.showTicket(page.selected("Ticket-A", 99));
    page.button("retry").fire("click");
    await page.settle();
    expect(JSON.parse(page.writes()[2]!.body!)).toEqual({
      commandId: "Original-Command-2",
      expectedRevision: 7,
      resolutionCycle: 3,
      solutionMessageId: "Solution-A",
      kind: "successful_test",
      receipt: "opaque-support-receipt",
    });
    expect(page.writes()[2]!.csrf).toBe("csrf-a");
    expect(page.panel.hasPending()).toBe(false);
  });
  it("disables association without claiming access loss when its capability turns OFF during a report read", async () => {
    const page = reportPanel();
    page.state.onRequest = (call) => {
      if (call.path === "/api/staff/knowledge/command")
        page.state.capability = false;
    };
    await page.panel.showTicket(page.selected());
    await page.readReport();
    expect(page.root.textContent).toContain(
      "Test-report association is unavailable.",
    );
    expect(page.root.textContent).not.toContain("<img src=x onerror=alert(1)>");
    expect(page.button("report-associate").disabled).toBe(true);
    expect(page.panel.hasPending()).toBe(false);
    page.field("evidence-kind").value = "staff_verified_fix";
    page.field("evidence-kind").fire("change");
    expect(page.button("evidence").disabled).toBe(false);
  });
});
