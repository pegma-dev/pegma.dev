import { createMemoryStore } from "@pegma/storage-core";
import { createKnowledgeBaseApplication } from "@pegma/knowledge-base-application";
import {
  createSupportDeskApplication,
  supportRecords,
  type ResolutionTestReceiptPort,
  type ResolutionVerifiedTest,
} from "@pegma/support-desk-application";
import { identityLinkKeyFromVerifiedIdentityClaims } from "@pegma/authorization-identity";
import { describe, expect, it, vi } from "vitest";
import {
  humanControlFixture,
  humanLatch,
  type HumanActor,
} from "./support-human-control-fixtures";
import { createSupportApi, publicTicketView } from "./support-api";
import {
  createSupportLearningRuntime,
  createSupportLearningSourceBridge,
} from "./support-learning";
import { customerAccessContext } from "./support-access";
import { createAgentPrincipalResolver } from "./agent-authority";
import { IDENTITY_ISSUER } from "./identity-api";

async function fixture(learning = true, verifier = true) {
  const f = await humanControlFixture(createMemoryStore());
  const clock = f.runtime.clock;
  const state = {
    productHook: undefined as (() => Promise<void>) | undefined,
  };
  const issued = new Map<
    string,
    {
      ticketId: string;
      ticketRevision: number;
      resolutionCycle: number;
      actorId: string;
      test: ResolutionVerifiedTest;
    }
  >();
  const verify: ResolutionTestReceiptPort["verify"] = vi.fn(
    async (receipt, context) => {
      const entry = issued.get(receipt);
      if (
        !entry ||
        entry.ticketId !== context.ticketId ||
        entry.ticketRevision !== context.ticketRevision ||
        entry.resolutionCycle !== context.resolutionCycle ||
        entry.actorId !== context.actorId ||
        entry.test.productBinding !== context.product.binding
      )
        return null;
      return structuredClone(entry.test);
    },
  );
  const application = createSupportDeskApplication({
    store: f.store,
    clock,
    resolutionLearning: {
      enabled: learning,
      productContext: {
        async resolve(context) {
          await state.productHook?.();
          return {
            productId: "fictional-success-product",
            version: "1.0.0",
            buildId: "fictional-build-1",
            binding: "fictional-success-build-binding",
            contextVersion: "fictional-product-policy",
            receiptId: "fictional-product-" + context.ticketId,
            verifiedAt: context.acceptedAt,
            validUntil: new Date(
              Date.parse(context.acceptedAt) + 3_600_000,
            ).toISOString(),
          };
        },
      },
      ...(verifier ? { testReceipts: { verify } } : {}),
    },
  });
  const authority = {
    identity: f.identity,
    sessions: f.sessions,
    roleStore: f.runtime.roleStore,
    identityLinkFromClaims: identityLinkKeyFromVerifiedIdentityClaims,
    logger: { log() {} },
  };
  const resolve = createAgentPrincipalResolver(authority);
  const sources = createSupportLearningSourceBridge({
    application,
    clock,
    serviceAccess: { resolve: async () => ({ outcome: "inactive" }) },
    reviewPolicy: { resolvePolicy: async () => ({ outcome: "disabled" }) },
  });
  const runtime = createSupportLearningRuntime({
    application,
    knowledge: createKnowledgeBaseApplication({ store: f.store, clock }),
    sources,
    clock,
    staffAccess: { resolve },
    processingEnabled: () => false,
  });
  const api = createSupportApi({
    ...authority,
    application,
    createLimiter: f.runtime.createLimiter,
    replyLimiter: f.runtime.replyLimiter,
    learningRuntime: {
      application,
      knowledge: createKnowledgeBaseApplication({ store: f.store, clock }),
      sources,
      clock,
      processingEnabled: () => false,
    },
    learningEnabled: () => true,
  });
  const ticketId = crypto.randomUUID();
  const solutionId = crypto.randomUUID();
  const command = () => ({
    ticketId,
    commandId: crypto.randomUUID(),
    correlationId: crypto.randomUUID(),
  });
  const staff = await f.staffAccess();
  await application.createCustomerTicket(
    customerAccessContext(f.principals.owner),
    {
      ...command(),
      messageId: crypto.randomUUID(),
      subject: "A fictional successful procedure",
      body: "How do I restore the fictional badge?",
    },
  );
  await application.replyAsStaff(staff, {
    ...command(),
    messageId: solutionId,
    body: "Reload the fictional badge and verify its count.",
  });
  await application.addNote(staff, {
    ...command(),
    messageId: crypto.randomUUID(),
    body: "PRIVATE_SUCCESS_NOTE_CANARY",
  });
  await application.resolveTicket(staff, command());
  function request(
    path: string,
    actor: HumanActor,
    packet: unknown,
    headers: Record<string, string> = {},
  ) {
    return new Request(IDENTITY_ISSUER + path, {
      method: "POST",
      headers: {
        Cookie: f.cookies.get(actor)!,
        Origin: IDENTITY_ISSUER,
        "Sec-Fetch-Site": "same-origin",
        "X-Pegma-CSRF": f.csrf.get(actor)!,
        "Content-Type": "application/json",
        ...headers,
      },
      body: JSON.stringify(packet),
    });
  }
  const confirmation = {
    commandId: crypto.randomUUID(),
    lastSeenVisibleMessageId: solutionId,
  };
  const confirmPath = "/api/support/tickets/" + ticketId + "/confirm-success";
  const evidencePath =
    "/api/support/admin/tickets/" + ticketId + "/learning/evidence";
  const rows = () => f.store.collection(supportRecords).list(ticketId);
  async function evidence(receipt = "fictional-accepted-execution") {
    const view = await application.readStaffTicket(staff, ticketId);
    const source = await application.readResolutionLearningSource(
      staff,
      ticketId,
    );
    return {
      kind: "successful_test",
      commandId: crypto.randomUUID(),
      expectedRevision: view.ticket.revision,
      resolutionCycle: source.resolutionCycle,
      solutionMessageId: solutionId,
      receipt,
    };
  }
  async function issue(receipt: string, mismatch = false) {
    const view = await application.readStaffTicket(staff, ticketId);
    const source = await application.readResolutionLearningSource(
      staff,
      ticketId,
    );
    issued.set(receipt, {
      ticketId,
      ticketRevision: view.ticket.revision,
      resolutionCycle: source.resolutionCycle,
      actorId: f.principals.operator,
      test: {
        executionId: "fictional-test-execution",
        runnerId: "fictional-test-runner",
        testId: "badge-count",
        productBinding: mismatch
          ? "different-product-build"
          : "fictional-success-build-binding",
        executedAt: clock.now(),
        receiptId: receipt,
        verifiedAt: clock.now(),
        validUntil: new Date(Date.parse(clock.now()) + 60_000).toISOString(),
      },
    });
  }
  return {
    f,
    state,
    application,
    runtime,
    api,
    staff,
    ticketId,
    solutionId,
    command,
    request,
    confirmation,
    confirmPath,
    evidencePath,
    rows,
    evidence,
    issue,
    verify,
  };
}

describe("normal public success evidence HTTP", () => {
  it.each([
    ["read", "session"],
    ["read", "identity"],
    ["read", "credentials"],
    ["read", "cancel"],
    ["product", "session"],
    ["product", "identity"],
    ["product", "credentials"],
    ["product", "cancel"],
  ] as const)(
    "prevents customer success after %s await loses %s authority",
    async (phase, change) => {
      const t = await fixture();
      const before = await t.rows();
      const controller = new AbortController();
      const incoming = new Request(
        t.request(t.confirmPath, "owner", t.confirmation),
        { signal: controller.signal },
      );
      const entered = humanLatch();
      const resume = humanLatch();
      const read = phase === "read" ? t.f.block("read") : undefined;
      if (phase === "product") {
        t.state.productHook = async () => {
          t.state.productHook = undefined;
          entered.release();
          await resume.ready;
        };
      }
      const pending = t.api(incoming);
      if (read) await read.waitFor(pending);
      else await entered.ready;
      try {
        if (change === "session") await t.f.revokeSession("owner");
        if (change === "identity") await t.f.removeIdentity("owner");
        if (change === "credentials")
          incoming.headers.set("X-Pegma-CSRF", "changed-during-sdk-proof");
        if (change === "cancel") controller.abort();
      } finally {
        read?.release();
        resume.release();
      }
      expect((await pending).ok).toBe(false);
      expect(await t.rows()).toEqual(before);
    },
  );
  it.each([false, true])(
    "accepts and replays owner confirmation with learning %s using safe customer DTOs",
    async (learning) => {
      const t = await fixture(learning);
      const response = await t.api(
        t.request(t.confirmPath, "owner", t.confirmation),
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as ReturnType<
        typeof publicTicketView
      >;
      expect(body.ticket.status).toBe("resolved");
      expect(
        body.messages.every(
          (m: { visibility: string }) => m.visibility === "customer",
        ),
      ).toBe(true);
      for (const secret of [
        "PRIVATE_SUCCESS_NOTE_CANARY",
        "sourceBindingHash",
        "verificationReference",
        "customer_success",
      ])
        expect(JSON.stringify(body)).not.toContain(secret);
      const rows = await t.rows();
      expect(
        rows.filter((row) => row.kind === "customer_success"),
      ).toHaveLength(1);
      if (learning) {
        const source = await t.application.readResolutionLearningSource(
          t.staff,
          t.ticketId,
        );
        expect(source).toMatchObject({
          state: "eligible",
          sourceGeneration: 1,
          evidence: {
            kind: "customer_confirmation",
            actorId: t.f.principals.owner,
            lastVisibleMessageId: t.solutionId,
          },
        });
        const work = await t.application.readResolutionLearningWork(t.staff, {
          ticketId: t.ticketId,
          sourceGeneration: 1,
        });
        expect(work).toMatchObject({
          status: "pending",
          evidence: source.evidence,
        });
      } else {
        expect(
          rows.some((row) => row.kind === "resolution_learning_source"),
        ).toBe(false);
      }
      const replay = await t.api(
        t.request(t.confirmPath, "owner", t.confirmation),
      );
      expect(replay.status).toBe(200);
      expect(await t.rows()).toEqual(rows);
    },
  );
  it("denies another owner and missing CSRF without writing success evidence", async () => {
    const t = await fixture();
    const before = await t.rows();
    expect(
      (await t.api(t.request(t.confirmPath, "peer", t.confirmation))).status,
    ).toBe(404);
    const wrongCsrf = await t.api(
      t.request(t.confirmPath, "owner", t.confirmation, {
        "X-Pegma-CSRF": "wrong",
      }),
    );
    expect(wrongCsrf.status).toBe(403);
    expect(await t.rows()).toEqual(before);
  });
  it("rejects fresh closed-ticket confirmation but retains exact accepted replay after closing", async () => {
    const t = await fixture();
    expect(
      (await t.api(t.request(t.confirmPath, "owner", t.confirmation))).status,
    ).toBe(200);
    await t.application.closeTicket(t.staff, t.command());
    const before = await t.rows();
    expect(
      (await t.api(t.request(t.confirmPath, "owner", t.confirmation))).status,
    ).toBe(200);
    expect(await t.rows()).toEqual(before);
    const other = await fixture();
    await other.application.closeTicket(other.staff, other.command());
    const closedRows = await other.rows();
    expect(
      (
        await other.api(
          other.request(other.confirmPath, "owner", other.confirmation),
        )
      ).status,
    ).toBe(409);
    expect(await other.rows()).toEqual(closedRows);
  });
  it("fences a stale visible message and preserves original replay after a later message", async () => {
    const t = await fixture();
    const original = t.confirmation;
    expect(
      (await t.api(t.request(t.confirmPath, "owner", original))).status,
    ).toBe(200);
    await t.application.replyAsStaff(t.staff, {
      ...t.command(),
      messageId: crypto.randomUUID(),
      body: "A later visible clarification.",
    });
    const before = await t.rows();
    expect(
      (await t.api(t.request(t.confirmPath, "owner", original))).status,
    ).toBe(200);
    expect(await t.rows()).toEqual(before);
    expect(
      (
        await t.api(
          t.request(t.confirmPath, "owner", {
            ...original,
            commandId: crypto.randomUUID(),
          }),
        )
      ).status,
    ).toBe(409);
    expect(await t.rows()).toEqual(before);
  });
  it("retains the existing reply limiter for confirmations", async () => {
    const t = await fixture();
    for (let count = 0; count < 300; count++) {
      const debit = await t.f.runtime.replyLimiter.allow(t.f.principals.owner);
      if (!debit.allowed) break;
    }
    expect(
      (await t.api(t.request(t.confirmPath, "owner", t.confirmation))).status,
    ).toBe(429);
    expect(
      (await t.rows()).some((row) => row.kind === "customer_success"),
    ).toBe(false);
  });
  it("accepts a genuinely matched fixture test receipt into actual Source and Work, including exact recovery", async () => {
    const t = await fixture();
    const packet = await t.evidence();
    await t.issue(packet.receipt);
    const response = await t.api(t.request(t.evidencePath, "operator", packet));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      result: { state: "eligible", sourceGeneration: 1 },
    });
    const source = await t.application.readResolutionLearningSource(
      t.staff,
      t.ticketId,
    );
    expect(source.evidence).toMatchObject({
      kind: "successful_test",
      actorId: t.f.principals.operator,
      test: {
        executionId: "fictional-test-execution",
        productBinding: "fictional-success-build-binding",
      },
    });
    expect(
      (
        await t.application.readResolutionLearningWork(t.staff, {
          ticketId: t.ticketId,
          sourceGeneration: 1,
        })
      ).evidence,
    ).toEqual(source.evidence);
    const before = await t.rows();
    const recovered = await t.api(
      t.request(t.evidencePath + "-recovery", "operator", packet),
    );
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toMatchObject({
      result: { outcome: "accepted", result: { state: "eligible" } },
    });
    expect(await t.rows()).toEqual(before);
    expect(t.verify).toHaveBeenCalledOnce();
  });
  it.each(["mismatched", "missing-verifier", "unaccepted-report"] as const)(
    "holds %s test evidence without eligible work",
    async (mode) => {
      const t = await fixture(true, mode !== "missing-verifier");
      const packet = await t.evidence();
      if (mode !== "unaccepted-report")
        await t.issue(packet.receipt, mode === "mismatched");
      const response = await t.api(
        t.request(t.evidencePath, "operator", packet),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        result: { state: "held", heldReason: "test_receipt_unverified" },
      });
      expect(
        (await t.rows()).some((row) => row.kind === "resolution_learning_work"),
      ).toBe(false);
    },
  );
  it("preserves flat staff fixes and rejects forged kind/fields, customer submission and CSRF", async () => {
    const t = await fixture();
    const packet = await t.evidence();
    const before = await t.rows();
    for (const value of [
      { ...packet, kind: "customer_confirmation" },
      { ...packet, accepted: true },
      { ...packet, verificationReference: "cannot-mix-proof-kinds" },
    ])
      expect(
        (await t.api(t.request(t.evidencePath, "operator", value))).status,
      ).toBe(400);
    expect(
      (await t.api(t.request(t.evidencePath, "owner", packet))).status,
    ).toBe(403);
    expect(
      (
        await t.api(
          t.request(t.evidencePath, "operator", packet, {
            "X-Pegma-CSRF": "wrong",
          }),
        )
      ).status,
    ).toBe(403);
    expect(await t.rows()).toEqual(before);
    const { kind: _kind, receipt: _receipt, ...flat } = packet;
    const response = await t.api(
      t.request(t.evidencePath, "operator", {
        ...flat,
        verificationReference: "fictional-explicit-staff-proof",
      }),
    );
    expect(response.status).toBe(200);
    expect(
      (await t.application.readResolutionLearningSource(t.staff, t.ticketId))
        .evidence,
    ).toMatchObject({ kind: "staff_verified_fix" });
  });
});
