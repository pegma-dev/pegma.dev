const select = (selector) => document.querySelector(selector);
const statusNode = select("#ticket-status");
const signedOut = select("#ticket-signed-out");
const signInLinks = [...signedOut.querySelectorAll("a")].map((node) => ({
  node,
  target: node.target ?? "",
  rel: node.rel ?? "",
}));
const detail = select("#ticket-detail");
const heading = select("#ticket-heading");
const meta = select("#ticket-meta");
const messageList = select("#message-list");
const replyForm = select("#reply-form");
const humanControls = select("#ticket-human-controls");
const humanStatus = select("#ticket-human-status");
const personButton = select("#request-person");
const successButton = select("#confirm-success");
const ticketId = new URL(window.location.href).searchParams.get("id") ?? "";
let csrfToken = "";
let viewer = null;
let authorityReloadRequired = false;
let currentView = null;
let readGeneration = 0;
let busy = null;
let personPacket = null;
let successPacket = null;
let successAcknowledged = false;
let replyPacket = null;
let replyAcknowledged = false;
let packetOutcome = "unconfirmed";
let retryAt = 0;
let retryTimer = null;
let retryNotice = null;
let suspended = false;
const requests = new Set();
const requestTimeoutMs = 15_000;

function paintStatus(message, error = false) {
  statusNode.textContent = message;
  statusNode.dataset.tone = error ? "error" : "neutral";
}
function showStatus(message, error = false) {
  retryNotice = null;
  paintStatus(message, error);
}
function onThisTicket() {
  return new URL(window.location.href).searchParams.get("id") === ticketId;
}
function isCurrent(generation) {
  return generation === readGeneration && onThisTicket() && !suspended;
}
function guard(generation) {
  if (!isCurrent(generation))
    throw Object.assign(new Error("stale_view"), { stale: true });
}
function cancelRequests() {
  for (const controller of requests) controller.abort();
  requests.clear();
}
function beginOperation() {
  suspended = false;
  const operation = { generation: ++readGeneration };
  cancelRequests();
  busy = operation;
  return operation;
}
function finishOperation(operation) {
  if (busy === operation) {
    busy = null;
    updateHumanControl();
  }
}
function clearTicket() {
  currentView = null;
  detail.hidden = true;
  heading.textContent = "Ticket";
  meta.textContent = "";
  messageList.replaceChildren();
  humanControls.hidden = true;
  humanStatus.textContent = "";
  personButton.disabled = true;
  successButton.disabled = true;
  for (const button of replyForm.querySelectorAll("button"))
    button.disabled = true;
  // Unsent reply text stays in the form when the private view is cleared.
}
function invalidate() {
  ++readGeneration;
  suspended = true;
  cancelRequests();
  busy = null;
  viewer = null;
  csrfToken = "";
  if (!onThisTicket()) personPacket = null;
  if (!onThisTicket()) successPacket = null;
  if (retryTimer !== null) clearTimeout(retryTimer);
  retryTimer = null;
  clearTicket();
  showStatus(
    onThisTicket()
      ? "Ticket view cleared. Reload to check current access and state."
      : "The ticket address changed. Reload this page to open it.",
  );
}
function retrySeconds() {
  return Math.max(0, Math.ceil((retryAt - Date.now()) / 1000));
}
function paintRetryNotice() {
  if (retryNotice === null) return;
  const seconds = retrySeconds();
  paintStatus(
    seconds > 0
      ? `${retryNotice} Wait at least ${seconds} seconds before retrying.`
      : `${retryNotice} The retry delay has elapsed; you can retry the same request.`,
    true,
  );
  if (seconds === 0) retryNotice = null;
}
function armRetryTimer() {
  if (suspended || retryTimer !== null || retrySeconds() === 0) return;
  retryTimer = setTimeout(
    () => {
      retryTimer = null;
      paintRetryNotice();
      updateHumanControl();
    },
    Math.min(1000, Math.max(1, retryAt - Date.now())),
  );
}
function updateHumanControl() {
  replyForm.noValidate = replyPacket !== null;
  for (const link of signInLinks) {
    link.node.target =
      replyPacket === null && successPacket === null ? link.target : "_blank";
    link.node.rel =
      replyPacket === null && successPacket === null
        ? link.rel
        : "noopener noreferrer";
  }
  const ticket = currentView?.ticket;
  const terminal = ticket?.status === "resolved" || ticket?.status === "closed";
  const state = ticket?.handling;
  const seconds = retrySeconds();
  humanControls.hidden =
    viewer === null ||
    authorityReloadRequired ||
    (ticket === undefined && personPacket === null && successPacket === null);
  humanStatus.textContent = humanControls.hidden
    ? ""
    : successPacket !== null
      ? "The confirmation has no settled acknowledgement. Retry the same confirmation."
      : personPacket !== null
        ? packetOutcome === "rate_limited"
          ? seconds > 0
            ? `The server rate limited this request. Wait at least ${seconds} seconds before retrying the same request.`
            : "Retry the same human-support request when ready."
          : "The previous human-support request has no confirmed acknowledgement. Retry that same request."
        : terminal
          ? `This ticket is ${ticket.status}. Request human support to reopen it.`
          : state === "assistant"
            ? "You can ask for human support at any time."
            : state === "human-active"
              ? "Human support is active on this ticket."
              : state === "human-pending"
                ? "This ticket is waiting for human support."
                : "Human support handles this ticket.";
  personButton.hidden =
    personPacket === null && !terminal && state !== "assistant";
  personButton.disabled =
    busy !== null ||
    replyPacket !== null ||
    successPacket !== null ||
    viewer === null ||
    authorityReloadRequired ||
    suspended ||
    seconds > 0 ||
    (ticket === undefined && personPacket === null);
  personButton.textContent =
    seconds > 0
      ? `Retry in ${seconds}s`
      : personPacket === null
        ? "Request human support"
        : "Retry human-support request";
  const confirmable = ticket?.status === "resolved";
  successButton.hidden = successPacket === null && !confirmable;
  successButton.disabled =
    busy !== null ||
    viewer === null ||
    authorityReloadRequired ||
    suspended ||
    seconds > 0 ||
    personPacket !== null ||
    replyPacket !== null ||
    successAcknowledged ||
    (successPacket === null &&
      (!confirmable || !currentView?.messages.at(-1)?.id));
  successButton.textContent =
    successPacket === null
      ? "Confirm this solved my issue"
      : "Retry the same confirmation";
  for (const button of replyForm.querySelectorAll("button")) {
    button.textContent =
      replyPacket === null ? "Send reply" : "Retry previous reply";
    button.disabled =
      busy !== null ||
      currentView === null ||
      personPacket !== null ||
      successPacket !== null ||
      authorityReloadRequired ||
      replyAcknowledged ||
      suspended ||
      seconds > 0;
  }
  armRetryTimer();
}
function retryDeadline(value) {
  if (value !== null) {
    const trimmed = value.trim();
    const now = Date.now();
    const seconds = /^\d+$/u.test(trimmed) ? Number(trimmed) : null;
    const deadline =
      seconds === null ? Date.parse(trimmed) : now + seconds * 1000;
    if (Number.isSafeInteger(deadline)) return Math.max(now, deadline);
  }
  // A missing or malformed server hint never triggers a tight retry loop.
  return Date.now() + 30_000;
}
async function api(path, init = {}) {
  const headers = new Headers(init.headers);
  if (init.body !== undefined) headers.set("Content-Type", "application/json");
  if (csrfToken !== "") headers.set("X-Pegma-CSRF", csrfToken);
  const controller = new AbortController();
  requests.add(controller);
  let timedOut = false;
  let rejectAbort;
  const aborted = new Promise((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () =>
    rejectAbort(
      Object.assign(
        new Error(timedOut ? "request_timeout" : "request_aborted"),
        { timedOut },
      ),
    );
  controller.signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, requestTimeoutMs);
  try {
    return await Promise.race([
      (async () => {
        const response = await fetch(path, {
          ...init,
          headers,
          signal: controller.signal,
          credentials: "same-origin",
          cache: "no-store",
          referrerPolicy: "no-referrer",
        });
        if (!response.ok)
          throw Object.assign(new Error("request_failed"), {
            status: response.status,
            ...(response.status === 429
              ? { retryAt: retryDeadline(response.headers.get("Retry-After")) }
              : {}),
          });
        return await response.json();
      })(),
      aborted,
    ]);
  } finally {
    clearTimeout(timer);
    controller.signal.removeEventListener("abort", onAbort);
    requests.delete(controller);
  }
}
async function readViewer(generation, expected = viewer) {
  const result = await api("/api/identity/session");
  guard(generation);
  if (
    typeof result.account?.subject !== "string" ||
    typeof result.csrfToken !== "string" ||
    result.csrfToken === ""
  )
    throw Object.assign(new Error("invalid_response"), { status: 502 });
  const next = Object.freeze({
    subject: result.account.subject,
    csrfToken: result.csrfToken,
  });
  restoreSuccess(next);
  if (successPacket !== null && next.subject !== successPacket.subject)
    throw Object.assign(new Error("session_changed"), { status: 401 });
  // An unresolved command belongs to its original principal, not old credentials.
  if (personPacket !== null && next.subject !== personPacket.subject) {
    personPacket = null;
    throw Object.assign(new Error("session_changed"), { status: 401 });
  }
  if (replyPacket !== null && next.subject !== replyPacket.subject)
    // A different viewer cannot expose/replay this owner's intent. Keep it
    // inaccessible so returning to the original account cannot mint new IDs.
    throw Object.assign(new Error("session_changed"), { status: 401 });
  if (
    expected !== null &&
    (next.subject !== expected.subject || next.csrfToken !== expected.csrfToken)
  )
    throw Object.assign(new Error("session_changed"), { status: 401 });
  viewer = next;
  csrfToken = next.csrfToken;
  return next;
}
function successKey(subject) {
  return (
    "pegma.support.success.v1:" +
    encodeURIComponent(subject) +
    ":" +
    encodeURIComponent(ticketId)
  );
}
function restoreSuccess(next) {
  if (successPacket !== null) return;
  let saved;
  try {
    saved = window.sessionStorage?.getItem(successKey(next.subject));
  } catch {
    return;
  }
  if (!saved) return;
  const packet = JSON.parse(saved);
  const body = JSON.parse(packet.body);
  if (
    packet.subject !== next.subject ||
    packet.ticketId !== ticketId ||
    Object.keys(packet).sort().join(",") !== "body,subject,ticketId" ||
    Object.keys(body).sort().join(",") !==
      "commandId,lastSeenVisibleMessageId" ||
    !/^[0-9a-f-]{36}$/iu.test(body.commandId) ||
    typeof body.lastSeenVisibleMessageId !== "string" ||
    body.lastSeenVisibleMessageId.length < 1 ||
    body.lastSeenVisibleMessageId.length > 200
  )
    throw new Error("invalid_pending_confirmation");
  successPacket = Object.freeze(packet);
}
function retainSuccess(packet) {
  try {
    window.sessionStorage?.setItem(
      successKey(packet.subject),
      JSON.stringify(packet),
    );
  } catch {
    /* The same immutable packet remains in this tab if storage is unavailable. */
  }
}
function clearSuccess() {
  if (successPacket !== null) {
    try {
      window.sessionStorage?.removeItem(successKey(successPacket.subject));
    } catch {
      /* Replaying a retained exact SDK receipt is safe. */
    }
  }
  successPacket = null;
  successAcknowledged = false;
}
function validateView(view) {
  if (
    view?.ticket?.id !== ticketId ||
    !Array.isArray(view.messages) ||
    (view.ticket.handling !== undefined &&
      !["assistant", "human-pending", "human-active"].includes(
        view.ticket.handling,
      )) ||
    view.messages.some(
      (message) =>
        message.ticketId !== ticketId || message.visibility !== "customer",
    ) ||
    view.csrfToken !== viewer?.csrfToken
  )
    throw Object.assign(new Error("invalid_response"), { status: 502 });
  return view;
}
function renderTicket(view) {
  currentView = validateView(view);
  heading.textContent = `${view.ticket.marker} ${view.ticket.subject}`;
  meta.textContent = `${view.ticket.status} · ${view.ticket.category ?? "uncategorized"}`;
  messageList.replaceChildren();
  for (const message of view.messages) {
    const item = document.createElement("li");
    const who = document.createElement("strong");
    who.textContent =
      message.authorKind === "customer"
        ? "You"
        : message.authorKind === "staff"
          ? "Pegma"
          : message.authorKind === "assistant"
            ? "Assistant"
            : "System";
    const when = document.createElement("span");
    when.className = "form-note";
    when.textContent = new Date(message.createdAt).toLocaleString();
    const body = document.createElement("p");
    body.textContent = message.body;
    item.append(who, " · ", when, body);
    messageList.append(item);
  }
  signedOut.hidden = true;
  detail.hidden = false;
  updateHumanControl();
}
function failure(error, action, generation) {
  if (!isCurrent(generation) || error.stale) return;
  clearTicket();
  if ([400, 404].includes(error.status)) {
    personPacket = null;
  }
  if (
    error.status === 401 ||
    error.status === 403 ||
    (error.status === 404 && (replyPacket !== null || successPacket !== null))
  ) {
    // A denied ACK may follow a real commit. Retain exact JSON for its owner,
    // including a not-found read under raced cookies. Neither 404 nor GET can
    // settle it; require a complete fresh owner read before another write.
    authorityReloadRequired = true;
    viewer = null;
    csrfToken = "";
  }
  signedOut.hidden = error.status !== 401;
  if (error.status === 429) {
    retryAt = Math.max(retryAt, error.retryAt);
    if (action === "Human-support request") packetOutcome = "rate_limited";
    retryNotice = `${action} was rate limited.`;
    paintRetryNotice();
  } else {
    if (action === "Human-support request") packetOutcome = "unconfirmed";
    showStatus(
      error.status === 401
        ? replyPacket !== null
          ? "Sign in to the original account in another tab, then return here and reload this ticket. The reply already sent may have completed."
          : "Sign in, then reload this ticket. Any request already sent may have completed."
        : error.status === 403
          ? "Current account access could not be confirmed. Any request already sent may have completed."
          : error.status === 404
            ? "Ticket not found."
            : `Could not confirm the ${action.toLowerCase()} result${error.timedOut ? " before the request deadline" : ""}. ${action === "Human-support request" && personPacket !== null ? "Retry the same human-support request." : action === "Reply" && replyPacket !== null ? "Reload, then retry the same reply. Your current draft is kept." : "Reload the ticket before another action."}`,
      error.status !== 401,
    );
  }
  updateHumanControl();
}
async function loadTicket() {
  const operation = beginOperation();
  const generation = operation.generation;
  clearTicket();
  updateHumanControl();
  if (ticketId === "" || !onThisTicket()) {
    showStatus("Missing or changed ticket id. Reload this page.", true);
    finishOperation(operation);
    return { generation, loaded: false };
  }
  select("#ticket-id-display").textContent = ticketId;
  showStatus("Loading ticket…");
  try {
    // A new read may use fresh credentials for the same retained packet owner.
    await readViewer(generation, null);
    const view = await api(
      `/api/support/tickets/${encodeURIComponent(ticketId)}`,
    );
    guard(generation);
    validateView(view);
    await readViewer(generation);
    authorityReloadRequired = false;
    if (replyPacket !== null && replyAcknowledged) {
      if (new FormData(replyForm).get("body") === replyPacket.draft)
        replyForm.reset();
      replyPacket = null;
      replyAcknowledged = false;
    }
    if (successPacket !== null && successAcknowledged) clearSuccess();
    renderTicket(view);
    showStatus("Ticket loaded.");
    return { generation, loaded: true };
  } catch (error) {
    failure(error, "Ticket read", generation);
    return { generation, loaded: false };
  } finally {
    finishOperation(operation);
  }
}
personButton.addEventListener("click", async () => {
  if (
    busy !== null ||
    retrySeconds() > 0 ||
    suspended ||
    !onThisTicket() ||
    authorityReloadRequired ||
    replyPacket !== null ||
    successPacket !== null ||
    viewer === null
  )
    return;
  const ticket = currentView?.ticket;
  if (
    personPacket === null &&
    (!ticket ||
      (ticket.handling !== "assistant" &&
        ticket.status !== "resolved" &&
        ticket.status !== "closed"))
  )
    return;
  personPacket ??= Object.freeze({
    subject: viewer.subject,
    body: JSON.stringify(Object.freeze({ commandId: crypto.randomUUID() })),
  });
  const packet = personPacket;
  const expectedViewer = viewer;
  const operation = beginOperation();
  const generation = operation.generation;
  updateHumanControl();
  try {
    await readViewer(generation, expectedViewer);
    const ack = await api(
      `/api/support/tickets/${encodeURIComponent(ticketId)}/request-person`,
      { method: "POST", body: packet.body },
    );
    guard(generation);
    validateView(ack);
    await readViewer(generation, expectedViewer);
    personPacket = null;
    // An exact command replay may acknowledge a historical view; do not render it.
    const refreshed = await loadTicket();
    if (isCurrent(refreshed.generation))
      showStatus(
        refreshed.loaded
          ? "Human support requested. Your unsent reply is kept."
          : "Human-support request accepted. Current ticket refresh failed; reload before another action. Your unsent reply is kept.",
        !refreshed.loaded,
      );
  } catch (error) {
    if (!isCurrent(generation) || error.stale) return;
    if (error.status === 409) {
      personPacket = null;
      const refreshed = await loadTicket();
      if (refreshed.loaded && isCurrent(refreshed.generation))
        showStatus(
          "The ticket changed. Review it before making a new request.",
          true,
        );
    } else failure(error, "Human-support request", generation);
  } finally {
    finishOperation(operation);
  }
});
successButton.addEventListener("click", async () => {
  if (
    busy !== null ||
    retrySeconds() > 0 ||
    suspended ||
    !onThisTicket() ||
    authorityReloadRequired ||
    viewer === null ||
    personPacket !== null ||
    replyPacket !== null ||
    successAcknowledged
  )
    return;
  if (successPacket === null) {
    if (currentView?.ticket.status !== "resolved") return;
    const lastSeenVisibleMessageId = currentView.messages.at(-1)?.id;
    if (
      typeof lastSeenVisibleMessageId !== "string" ||
      lastSeenVisibleMessageId.length < 1 ||
      lastSeenVisibleMessageId.length > 200
    )
      return;
    successPacket = Object.freeze({
      subject: viewer.subject,
      ticketId,
      body: JSON.stringify({
        commandId: crypto.randomUUID(),
        lastSeenVisibleMessageId,
      }),
    });
    retainSuccess(successPacket);
  }
  const packet = successPacket;
  const expectedViewer = viewer;
  const operation = beginOperation();
  const generation = operation.generation;
  updateHumanControl();
  try {
    await readViewer(generation, expectedViewer);
    const result = await api(
      "/api/support/tickets/" +
        encodeURIComponent(ticketId) +
        "/confirm-success",
      { method: "POST", body: packet.body },
    );
    guard(generation);
    validateView(result);
    await readViewer(generation, expectedViewer);
    successAcknowledged = true;
    const refreshed = await loadTicket();
    if (isCurrent(refreshed.generation))
      showStatus(
        refreshed.loaded
          ? "Resolution confirmed. Thank you."
          : "Confirmation accepted. Reload to refresh the current ticket.",
        !refreshed.loaded,
      );
  } catch (error) {
    if (!isCurrent(generation) || error.stale) return;
    if (error.status === 409) {
      clearSuccess();
      const refreshed = await loadTicket();
      if (refreshed.loaded && isCurrent(refreshed.generation))
        showStatus(
          "The visible conversation changed. Review it before making a new confirmation.",
          true,
        );
    } else failure(error, "Resolution confirmation", generation);
  } finally {
    finishOperation(operation);
  }
});
replyForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (
    busy !== null ||
    retrySeconds() > 0 ||
    suspended ||
    authorityReloadRequired ||
    personPacket !== null ||
    successPacket !== null ||
    replyAcknowledged ||
    viewer === null ||
    currentView === null ||
    !onThisTicket()
  )
    return;
  if (replyPacket === null) {
    const body = new FormData(replyForm).get("body");
    if (
      typeof body !== "string" ||
      body.trim() === "" ||
      body.length > 20_000 ||
      /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u.test(body)
    ) {
      showStatus(
        "Check the reply. Remove unsupported control characters and stay within the field limit.",
        true,
      );
      return;
    }
    const expectedAccountId = viewer.subject;
    const commandId = `${expectedAccountId}~${crypto.randomUUID()}`;
    const messageId = `${expectedAccountId}~${crypto.randomUUID()}`;
    if (
      ![commandId, messageId].every((id) =>
        /^[A-Za-z0-9._~-]{1,128}$/u.test(id),
      )
    ) {
      showStatus(
        "Could not prepare a retry-safe reply for this account.",
        true,
      );
      return;
    }
    replyPacket = Object.freeze({
      subject: expectedAccountId,
      path: `/api/support/tickets/${encodeURIComponent(ticketId)}/replies`,
      method: "POST",
      headers: Object.freeze({ "X-Pegma-Support-Command": "1" }),
      body: JSON.stringify({
        body,
        command: { version: 1, expectedAccountId, commandId, messageId },
      }),
      draft: body,
    });
  }
  const packet = replyPacket;
  const expectedViewer = viewer;
  const operation = beginOperation();
  const generation = operation.generation;
  updateHumanControl();
  try {
    await readViewer(generation, expectedViewer);
    showStatus("Sending reply…");
    const view = await api(packet.path, {
      method: packet.method,
      headers: packet.headers,
      body: packet.body,
    });
    guard(generation);
    validateView(view);
    await readViewer(generation, expectedViewer);
    replyAcknowledged = true;
    // A receipt can acknowledge historical state. GET alone never clears an
    // unknown packet; only an acknowledged packet can finish on this read.
    const refreshed = await loadTicket();
    if (isCurrent(refreshed.generation))
      showStatus(
        refreshed.loaded
          ? "Reply sent."
          : "Reply accepted. Current ticket refresh failed; reload before another action.",
        !refreshed.loaded,
      );
  } catch (error) {
    failure(error, "Reply", generation);
  } finally {
    finishOperation(operation);
  }
});
select("#ticket-reload").addEventListener("click", () => {
  if (!onThisTicket()) window.location.reload();
  else void loadTicket();
});
window.addEventListener("pagehide", invalidate);
window.addEventListener("popstate", invalidate);
window.addEventListener("pageshow", () => {
  if (suspended && onThisTicket()) void loadTicket();
});
void loadTicket();
