/* Optional engineering intake and repository-policy panel. The host injects its
 * existing bounded authenticated request/session/current-ticket readers. This
 * module registers no route, job, provider, permission or persistent cache. */
(function () {
  const policyPath = '/api/support/admin/engineering/policy';
  const states = ['unverified', 'eligible', 'held', 'restricted', 'withdrawn'];
  const securityValues = ['ordinary', 'restricted', 'uncertain'];
  const withdrawals = ['privacy_withdrawal', 'source_access_revoked', 'source_deleted'];
  const invalidations = ['evidence_revoked', 'product_binding_revoked', 'check_policy_revoked'];
  const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  const invalid = () => Object.assign(new Error('invalid_response'), { status: 502 });
  function text(value, maximum = 200, multiline = false) {
    if (typeof value !== 'string' || value.trim().length === 0 || value.length > maximum ||
      (multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u : /[\u0000-\u001f\u007f-\u009f]/u).test(value))
      throw new Error('invalid_input');
    return value;
  }
  function counter(value, minimum = 0) {
    if (!Number.isSafeInteger(value) || value < minimum) throw invalid();
    return value;
  }
  function hash(value) {
    if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value)) throw invalid();
    return value;
  }
  function copy(value) { return JSON.parse(JSON.stringify(value)); }
  /**
   * request(path, init) returns the existing {result, csrfToken} envelope.
   * readSession() returns current {subject, csrfToken}; readCurrentTicket(id)
   * returns the actual current staff {ticket, messages, csrfToken} view.
   * Those host readers remain bounded and enforce original browser authority.
   * isEnabled defaults OFF; canRequest may narrow current controller admission.
   * onPendingChange receives body-free owner coordinates, never command data.
   * The host calls suspend before changing/hiding the ticket or losing access.
   */
  function createPanel(options) {
    const { root, request, readSession, readCurrentTicket } = options;
    if (!root || [request, readSession, readCurrentTicket].some((fn) => typeof fn !== 'function'))
      throw new TypeError('Engineering panel requires existing host authority readers.');
    const document = options.document ?? globalThis.document;
    const now = options.now ?? (() => Date.now());
    const nextId = options.commandId ?? (() => crypto.randomUUID());
    const pending = new Map();
    const enrolled = new Map();
    let epoch = 0, context = null, session = null, ticket = null, source = null, work = null, policy = null, proposal = null;
    let busy = false, preparedPolicy = null, retryAt = 0;
    const controllers = new Set();
    const inputs = [];
    const buttons = [];
    const node = (tag, value) => {
      const result = document.createElement(tag);
      if (value !== undefined) result.textContent = value;
      return result;
    };
    const button = (key, label, run) => {
      const result = node('button', label); result.type = 'button'; result.dataset.engineeringAction = key;
      result.addEventListener('click', () => { void run(); }); buttons.push(result); return result;
    };
    const field = (key, label, maximum, multiline = false) => {
      const wrapper = node('label', label + ' '); const result = node(multiline ? 'textarea' : 'input');
      result.dataset.engineeringField = key; result.maxLength = maximum; result.autocomplete = 'off';
      if (!multiline) result.type = 'text'; wrapper.append(result); inputs.push(result); return { wrapper, input: result };
    };
    const select = (key, label, values) => {
      const wrapper = node('label', label + ' '); const result = node('select'); result.dataset.engineeringField = key;
      for (const [value, caption] of values) { const item = node('option', caption); item.value = value; result.append(item); }
      result.value = values[0]?.[0] ?? ''; wrapper.append(result); inputs.push(result); return { wrapper, input: result };
    };
    const status = node('p', 'Engineering tools are not loaded.'); status.role = 'status'; status.ariaLive = 'polite';
    const sourceText = node('pre'); sourceText.className = 'support-message-body';
    const workText = node('pre'); workText.className = 'support-message-body';
    const proposalText = node('pre'); proposalText.className = 'support-message-body';
    const messageChoices = node('section'); const repository = select('repository', 'Repository key', [['', 'Select a configured repository']]);
    const expected = field('expected', 'Expected behavior', 2000, true);
    const actual = field('actual', 'Actual behavior', 2000, true);
    const steps = field('steps', 'Reproduction steps (one per line)', 16016, true);
    const reference = field('verification', 'Staff verification reference', 200);
    const sensitivity = select('security', 'Sensitivity (choose explicitly)', [['', 'Choose sensitivity'],
      ...securityValues.map((value) => [value, value])]);
    const reason = field('repository-reason', 'Repository selection reason', 200);
    const withdrawal = select('withdraw-reason', 'Withdrawal reason', withdrawals.map((value) => [value, value]));
    const invalidation = select('invalidate-reason', 'Invalidation reason', invalidations.map((value) => [value, value]));
    const refreshButton = button('refresh', 'Read current engineering state', () => refresh());
    const workButton = button('work', 'Read engineering work metadata', () => readWork());
    const proposalButton = button('proposal', 'Read checked issue proposal', () => readProposal());
    const approveButton = button('approve', 'Approve this exact checked proposal', () => approveProposal('approve'));
    const rejectButton = button('reject', 'Reject checked issue proposal', () => approveProposal('reject'));
    const enrollButton = button('enroll', 'Confirm or enroll engineering intake', () => mutate('enroll'));
    const evidenceButton = button('evidence', 'Record verified failure', () => mutate('evidence'));
    const selectButton = button('repository', 'Select this repository', () => mutate('repository'));
    const withdrawButton = button('withdraw', 'Withdraw engineering source', () => mutate('withdraw'));
    const invalidateButton = button('invalidate', 'Invalidate engineering evidence', () => mutate('invalidate'));
    const retryTicket = button('retry-ticket', 'Recover the retained ticket command', () => retry('ticket'));
    const policyButton = button('policy-read', 'Read repository policy (Admin + Support)', () => readPolicy());
    const policyPanel = node('details'); policyPanel.hidden = true;
    const policyStatus = node('p'); const catalog = node('section');
    const enabledLabel = node('label', ' Enable repository policy '); const enabledInput = node('input');
    enabledInput.type = 'checkbox'; enabledInput.dataset.engineeringField = 'policy-enabled'; enabledLabel.append(enabledInput);
    const prepareButton = button('policy-prepare', 'Prepare policy change', () => preparePolicy());
    const saveButton = button('policy-save', 'Save prepared policy change', () => savePolicy());
    const disableButton = button('policy-disable', 'Disable repository policy', () => mutate('policy-disable'));
    const retryPolicy = button('retry-policy', 'Recover the retained policy command', () => retry('policy'));
    policyPanel.append(node('summary', 'Repository policy (Admin + Support)'), policyStatus, catalog,
      enabledLabel, prepareButton, saveButton, disableButton);
    root.replaceChildren(node('h2', 'Engineering intake'),
      node('p', 'Record verified failure evidence and select an allowed repository. Approval records this exact checked proposal; these controls never file an issue.'),
      node('p', 'Changing an existing restriction still requires separate security review.'),
      node('p', 'Proposal review requires current human review access and explicit configured proof ports.'),
      status, refreshButton, sourceText, workText, workButton, proposalButton, proposalText, approveButton, rejectButton, enrollButton,
      expected.wrapper, actual.wrapper, steps.wrapper, messageChoices, reference.wrapper, sensitivity.wrapper, evidenceButton,
      repository.wrapper, reason.wrapper, selectButton, withdrawal.wrapper, withdrawButton,
      invalidation.wrapper, invalidateButton, retryTicket, policyButton, policyPanel, retryPolicy);
    const enabled = () => { try { return options.isEnabled?.() === true; } catch { return false; } };
    const reviewEnabled = () => { try { return options.isReviewEnabled?.() === true; } catch { return false; } };
    const ticketNodes = [sourceText, workText, workButton, proposalButton, proposalText, approveButton, rejectButton, enrollButton, expected.wrapper, actual.wrapper, steps.wrapper,
      messageChoices, reference.wrapper, sensitivity.wrapper, evidenceButton, repository.wrapper, reason.wrapper,
      selectButton, withdrawal.wrapper, withdrawButton, invalidation.wrapper, invalidateButton, retryTicket];
    const key = (domain, actor = context?.actorSubject, ticketId = context?.ticketId) =>
      JSON.stringify(domain === 'policy' ? ['policy', actor] : ['ticket', actor, ticketId]);
    const owner = (domain) => context === null ? undefined : pending.get(key(domain));
    const owners = () => Object.freeze([...pending.values()].map((entry) => Object.freeze({
      domain: entry.domain, actorSubject: entry.actorSubject, ...(entry.ticketId === undefined ? {} : { ticketId: entry.ticketId }),
      acknowledged: entry.ack !== null })));
    function changed() { try { options.onPendingChange?.(owners()); } catch { /* No callback can settle a packet. */ } }
    function activity() { try { options.onBusyChange?.(busy); } catch { /* Host presentation is not authority. */ } }
    function notice(value) { status.textContent = value; }
    function clearPrivate() {
      source = null; work = null; policy = null; proposal = null; preparedPolicy = null; session = null;
      sourceText.textContent = ''; workText.textContent = ''; proposalText.textContent = ''; catalog.replaceChildren(); policyStatus.textContent = '';
      policyPanel.hidden = true; messageChoices.replaceChildren(); repository.input.replaceChildren(); repository.input.value = '';
      enabledInput.checked = false;
      for (const input of inputs) input.value = '';
      withdrawal.input.value = withdrawals[0]; invalidation.input.value = invalidations[0];
    }
    function evidenceLocked() {
      const intake = source ?? enrolled.get(key('ticket'));
      return intake?.withdrawalOnly === true || ['restricted', 'withdrawn'].includes(intake?.state);
    }
    function controls() {
      const active = context !== null && enabled();
      for (const item of ticketNodes) item.hidden = context?.ticketId === null;
      root.hidden = !active;
      for (const item of buttons) item.disabled = !active || busy;
      const held = owner('ticket'); const policyHeld = owner('policy');
      const canWrite = active && !busy && ticket !== null && held === undefined;
      // Private-read denial does not establish absence. Explicit enrollment is
      // a separately authorized SDK command which can confirm existing intake.
      enrollButton.disabled ||= !canWrite || source !== null || enrolled.has(key('ticket'));
      evidenceButton.disabled ||= !canWrite || evidenceLocked() || !(source !== null || enrolled.has(key('ticket')));
      workButton.disabled ||= source === null || source.sourceGeneration <= 0;
      proposalButton.disabled ||= !reviewEnabled() || workButton.disabled || held !== undefined;
      approveButton.disabled ||= !reviewEnabled() || !canWrite || proposal?.approvable !== true;
      rejectButton.disabled ||= !reviewEnabled() || !canWrite || proposal?.rejectionAvailable !== true;
      selectButton.disabled ||= !canWrite || work?.selection === undefined || work.selection.repositoryKeys.length === 0;
      withdrawButton.disabled ||= !canWrite || !(source !== null || enrolled.has(key('ticket')));
      invalidateButton.disabled ||= withdrawButton.disabled || evidenceLocked();
      prepareButton.disabled ||= policy === null || policy.unmappedRepositoryCount !== 0 || policy.catalog.length === 0 || policyHeld !== undefined;
      saveButton.disabled ||= preparedPolicy === null || policyHeld !== undefined;
      disableButton.disabled ||= policy === null || policyHeld !== undefined;
      retryTicket.hidden = held === undefined; retryPolicy.hidden = policyHeld === undefined;
      retryTicket.disabled ||= held === undefined; retryPolicy.disabled ||= policyHeld === undefined;
      retryTicket.textContent = held?.ack ? 'Refresh acknowledged ticket command' : 'Retry the exact ticket command';
      retryPolicy.textContent = policyHeld?.ack ? 'Refresh acknowledged policy command' : 'Retry the exact policy command';
    }
    function guard(observation) {
      if (!enabled()) { clearPrivate(); ticket = null; controls(); }
      if (observation !== epoch || context === null || !enabled() || options.canRequest?.() === false)
        throw Object.assign(new Error('stale_view'), { stale: true });
    }
    async function viewer(observation, original) {
      guard(observation); const raw = await readSession(); guard(observation);
      const value = { subject: text(raw?.subject ?? raw?.account?.subject), csrfToken: text(raw?.csrfToken, 2000) };
      if (value.subject !== context.actorSubject || (original &&
        (value.subject !== original.subject || value.csrfToken !== original.csrfToken)))
        throw Object.assign(new Error('session_changed'), { status: 401 });
      return value;
    }
    async function call(path, init, observation, actor, observeResult) {
      guard(observation); const controller = new AbortController(); controllers.add(controller);
      try {
        const value = await request(path, { ...init, signal: controller.signal,
          headers: { ...(init?.headers ?? {}), 'X-Pegma-CSRF': actor.csrfToken } });
        if (!object(value) || !Object.prototype.hasOwnProperty.call(value, 'result') || value.csrfToken !== actor.csrfToken) throw invalid();
        observeResult?.(value.result);
        guard(observation);
        return value.result;
      } finally { controllers.delete(controller); }
    }
    const base = () => '/api/support/admin/tickets/' + encodeURIComponent(context.ticketId) + '/engineering';
    function failure(error, observation) {
      if (observation !== epoch) return;
      clearPrivate(); ticket = null;
      if (error?.status === 429) retryAt = Math.max(retryAt, Number.isSafeInteger(error.retryAt) ? error.retryAt : now() + 30000);
      notice(pending.size ? 'A command is retained. Restore current access, then explicitly recover its original packet.'
        : 'Current engineering access or state could not be confirmed. Refresh before another action.');
      if ([401, 403].includes(error?.status)) {
        try { options.onAccessLost?.({ status: error.status, owners: owners() }); } catch { /* Retain ownership. */ }
      }
    }
    async function operation(run) {
      if (busy || context === null) return;
      if (!enabled()) { clearPrivate(); ticket = null; controls(); return; }
      const observation = epoch; busy = true; activity(); controls();
      try { await run(observation); }
      catch (error) { if (!error?.stale) failure(error, observation); }
      finally { if (observation === epoch) { busy = false; activity(); controls(); } }
    }
    async function currentTicket(observation, actor) {
      guard(observation); const value = await readCurrentTicket(context.ticketId); guard(observation);
      await viewer(observation, actor);
      if (!object(value?.ticket) || value.ticket.id !== context.ticketId || !Array.isArray(value.messages) || value.csrfToken !== actor.csrfToken) throw invalid();
      counter(value.ticket.revision, 1);
      const messages = value.messages.filter((message) => object(message) && message.ticketId === context.ticketId && message.visibility === 'customer');
      const ids = messages.map((message) => text(message.id));
      if (new Set(ids).size !== ids.length) throw invalid();
      ticket = { revision: value.ticket.revision, visibleMessageIds: ids };
      messageChoices.replaceChildren(node('p', 'Select actual customer-visible messages:'));
      for (const id of ids) {
        const label = node('label', id + ' '); const input = node('input'); input.type = 'checkbox';
        input.value = id; input.dataset.engineeringMessage = id; label.append(input); messageChoices.append(label);
      }
      return ticket;
    }
    function sourceValue(value) {
      if (!object(value) || value.ticketId !== context.ticketId || !states.includes(value.state) ||
        !securityValues.includes(value.security) || ['hasEvidence', 'hasProductContext', 'reconciliationPending'].some((key) => typeof value[key] !== 'boolean')) throw invalid();
      counter(value.sourceGeneration); counter(value.workGeneration); counter(value.destinationCount);
      return { ticketId: value.ticketId, sourceGeneration: value.sourceGeneration, workGeneration: value.workGeneration,
        state: value.state, security: value.security, hasEvidence: value.hasEvidence, hasProductContext: value.hasProductContext,
        destinationCount: value.destinationCount, reconciliationPending: value.reconciliationPending };
    }
    async function refreshSource(observation, actor, acknowledged) {
      source = null; work = null; sourceText.textContent = ''; workText.textContent = '';
      try {
        const value = sourceValue(await call(base(), { method: 'GET' }, observation, actor));
        await viewer(observation, actor); source = value; sourceText.textContent = JSON.stringify(value, null, 2);
      } catch (error) {
        if (![403, 404].includes(error?.status)) throw error;
        await viewer(observation, actor);
        notice(error.status === 403 ? 'Source details are unavailable with current access.' : 'No source details were returned; explicit enrollment is checked by the server.');
        // Denial is never absence or RestrictedRead. A bound source-command
        // ACK plus a NEW current same-actor staff-ticket read can settle that
        // command. Only enrollment admits evidence; other protected ACKs admit
        // explicit withdrawal, without asserting the current private state.
        if (acknowledged && ['enroll', 'evidence', 'withdraw'].includes(acknowledged.action) &&
          pending.get(acknowledged.key) === acknowledged && ack(acknowledged.ack, acknowledged)) {
          await currentTicket(observation, actor);
          enrolled.set(key('ticket'), { ...copy(acknowledged.ack), withdrawalOnly: acknowledged.action !== 'enroll' });
          pending.delete(acknowledged.key); changed();
          notice(acknowledged.action === 'enroll' && !evidenceLocked()
            ? 'Enrollment acknowledged. Current staff ticket refreshed; record evidence explicitly. Source details remain protected.'
            : 'Command acknowledged. Current staff ticket refreshed; source details remain protected. Explicit withdrawal remains available.');
          return;
        }
        if (acknowledged) return;
      }
      if (acknowledged && acknowledged.action !== 'repository' && source !== null && pending.get(acknowledged.key) === acknowledged) {
        pending.delete(acknowledged.key); changed(); notice('Ticket command acknowledged and current engineering state read.');
      }
    }
    async function refresh() {
      if (context?.ticketId === null) return readPolicy();
      return operation(async (observation) => {
        clearPrivate(); const actor = await viewer(observation); session = actor;
        await currentTicket(observation, actor);
        const retained = owner('ticket'); const ack = retained?.ack ? retained : undefined;
        await refreshSource(observation, actor, ack); guard(observation);
        if (retained && !retained.ack) notice('The original ticket command is unresolved. A read cannot acknowledge it.');
      });
    }
    async function readWork() {
      if (!source || source.sourceGeneration <= 0) return;
      proposal = null; proposalText.textContent = ''; controls();
      const generation = source.sourceGeneration;
      return operation(async (observation) => {
        const actor = await viewer(observation, session);
        const value = await call(base() + '/work?sourceGeneration=' + generation, { method: 'GET' }, observation, actor);
        if (!object(value) || value.ticketId !== context.ticketId || value.sourceGeneration !== generation || !securityValues.includes(value.security)) throw invalid();
        counter(value.workGeneration, 1); text(value.status); text(value.stage);
        for (const key of ['hasCandidate', 'hasPreparedProposal', 'hasApproval', 'hasDispatch']) if (typeof value[key] !== 'boolean') throw invalid();
        const selected = value.selection;
        if (selected !== undefined) {
          if (!object(selected) || !Array.isArray(selected.repositoryKeys) || !Array.isArray(selected.repositoryChoices) ||
            selected.repositoryKeys.length > 20 || selected.repositoryChoices.length !== selected.repositoryKeys.length ||
            new Set(selected.repositoryKeys).size !== selected.repositoryKeys.length) throw invalid();
          counter(selected.policyGeneration); hash(selected.policyHash); selected.repositoryKeys.forEach((key) => text(key, 100));
          const identities = new Set();
          selected.repositoryChoices.forEach((choice, index) => {
            if (!object(choice) || JSON.stringify(Object.keys(choice).sort()) !== JSON.stringify(['descriptorHash', 'key', 'repositoryId']) ||
              choice.key !== selected.repositoryKeys[index]) throw invalid();
            text(choice.repositoryId); hash(choice.descriptorHash);
            if (identities.has(choice.repositoryId)) throw invalid();
            identities.add(choice.repositoryId);
          });
        }
        await viewer(observation, actor); work = copy(value); session = actor;
        workText.textContent = JSON.stringify({ sourceGeneration: value.sourceGeneration, workGeneration: value.workGeneration,
          status: value.status, stage: value.stage, security: value.security, hasCandidate: value.hasCandidate,
          hasPreparedProposal: value.hasPreparedProposal, hasApproval: value.hasApproval, hasDispatch: value.hasDispatch }, null, 2);
        repository.input.replaceChildren();
        const empty = node('option', 'Select an allowed repository'); empty.value = ''; repository.input.append(empty);
        for (const key of selected?.repositoryKeys ?? []) { const item = node('option', key); item.value = key; repository.input.append(item); }
        repository.input.value = ''; notice('Current engineering work metadata read. Selection does not approve an issue.');
      });
    }
    function proposalValue(value) {
      if (!object(value) || value.ticketId !== context.ticketId || typeof value.approvable !== 'boolean' ||
        typeof value.rejectionAvailable !== 'boolean' || !object(value.request) || !object(value.intent) || !object(value.intent.command)) throw invalid();
      counter(value.sourceGeneration, 1); counter(value.workGeneration, 1); hash(value.proposalHash); text(value.status);
      const command = value.intent.command;
      if (value.intent.actorId !== context.actorSubject || command.ticketId !== value.ticketId ||
        command.sourceGeneration !== value.sourceGeneration || command.expectedWorkGeneration !== value.workGeneration ||
        command.proposalHash !== value.proposalHash || command.decision !== 'approve' ||
        JSON.stringify(Object.keys(command).sort()) !== JSON.stringify(['commandId', 'correlationId', 'decision', 'expectedWorkGeneration', 'proposalHash', 'sourceGeneration', 'ticketId'])) throw invalid();
      text(command.commandId); text(command.correlationId);
      const request = value.request; const repository = request.repository; const bundle = request.bundle;
      if (!object(repository) || !object(bundle) || !['public', 'private'].includes(repository.visibility) ||
        !['create_issue', 'link_existing_issue'].includes(request.operation) || !Array.isArray(bundle.labels) ||
        !Array.isArray(bundle.evidenceReferences) || bundle.labels.length > 256 || bundle.evidenceReferences.length > 256) throw invalid();
      for (const field of ['repositoryId', 'owner', 'name']) text(repository[field], 65536);
      text(bundle.title, 65536, true); text(bundle.body, 65536, true); text(bundle.exportMarker, 65536);
      for (const entry of [...bundle.labels, ...bundle.evidenceReferences]) text(entry, 65536, true);
      if (bundle.templateId !== undefined) text(bundle.templateId, 65536);
      if (request.operation === 'link_existing_issue') { text(request.issueId); counter(request.issueNumber, 1); }
      if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 65536) throw invalid();
      return copy(value);
    }
    async function readProposal() {
      if (!reviewEnabled() || !source || source.sourceGeneration <= 0 || owner('ticket')) return;
      const generation = source.sourceGeneration;
      // Remove the old render before awaiting a replacement.
      proposal = null; proposalText.textContent = ''; controls();
      return operation(async (observation) => {
        const actor = await viewer(observation, session);
        const value = proposalValue(await call(base() + '/proposal?sourceGeneration=' + generation,
          { method: 'GET' }, observation, actor));
        if (value.sourceGeneration !== generation) throw invalid();
        await viewer(observation, actor); proposal = value; session = actor;
        // Inert checked outbound fields only. The full private Work and opaque
        // retained command never enter rendered content or owner callbacks.
        proposalText.textContent = JSON.stringify({ sourceGeneration: value.sourceGeneration,
          workGeneration: value.workGeneration, proposalHash: value.proposalHash, request: value.request }, null, 2);
        notice(value.approvable ? 'Review the exact checked request, then approve explicitly. Approval does not file an issue.'
          : 'Historical checked proposal read. It is not available for a new approval.');
      });
    }
    async function approveProposal(decision) {
      if (!['approve', 'reject'].includes(decision) || !reviewEnabled() ||
        !(decision === 'approve' ? proposal?.approvable : proposal?.rejectionAvailable) || owner('ticket') || !ticket) return;
      const original = copy(proposal.intent);
      original.command.decision = decision;
      return operation(async (observation) => {
        await viewer(observation, session);
        const retained = retain('ticket', 'review', base() + '/review', { intent: original },
          { sourceGeneration: original.command.sourceGeneration, expectedWorkGeneration: original.command.expectedWorkGeneration, decision });
        proposal = null; proposalText.textContent = '';
        await send(retained, observation);
      });
    }
    function policyValue(value) {
      if (!object(value) || typeof value.enabled !== 'boolean' || !Array.isArray(value.catalog) || value.catalog.length > 20 ||
        !Array.isArray(value.repositories) || value.repositories.length > 20) throw invalid();
      counter(value.generation); hash(value.policyHash); counter(value.unmappedRepositoryCount);
      for (const list of [value.catalog, value.repositories]) {
        const keys = list.map((entry) => { if (!object(entry) || typeof entry.enabled !== 'boolean') throw invalid(); return text(entry.key, 100); });
        if (new Set(keys).size !== keys.length) throw invalid();
      }
      if (value.repositories.some((entry) => !value.catalog.some((configured) => configured.key === entry.key))) throw invalid();
      return copy(value);
    }
    async function policyRead(observation, actor, acknowledged) {
      const value = policyValue(await call(policyPath, { method: 'GET' }, observation, actor));
      await viewer(observation, actor); policy = value; session = actor; policyPanel.hidden = false;
      catalog.replaceChildren(); enabledInput.checked = value.enabled;
      policyStatus.textContent = (value.catalog.length === 0 ? 'No server-configured repositories. ' : '') +
        (value.unmappedRepositoryCount ? `${value.unmappedRepositoryCount} saved repositories are unmapped. Replacement is blocked; explicit disable remains available.`
          : 'Current authorized repository policy. Configuration does not establish remote availability or dispatch approval.');
      for (const entry of value.catalog) {
        const saved = value.repositories.find((item) => item.key === entry.key);
        const label = node('label', entry.key + (entry.enabled ? ' (configured enabled)' : ' (configured disabled)') +
          (saved ? saved.enabled ? ' (saved enabled) ' : ' (saved disabled) ' : ' (not selected) ')); const input = node('input');
        input.type = 'checkbox'; input.dataset.engineeringRepository = entry.key;
        input.checked = value.repositories.some((saved) => saved.key === entry.key); label.append(input); catalog.append(label);
        input.addEventListener('change', () => { preparedPolicy = null; controls(); });
      }
      if (acknowledged && pending.get(acknowledged.key) === acknowledged) { pending.delete(acknowledged.key); changed(); }
    }
    async function readPolicy() {
      return operation(async (observation) => {
        const actor = await viewer(observation); const retained = owner('policy');
        policyPanel.hidden = true; preparedPolicy = null;
        await policyRead(observation, actor, retained?.ack ? retained : undefined);
        if (retained && !retained.ack) notice('The original policy command remains unresolved. This read does not acknowledge it.');
      });
    }
    enabledInput.addEventListener('change', () => { preparedPolicy = null; controls(); });
    async function preparePolicy() {
      if (!policy || owner('policy') || policy.unmappedRepositoryCount || !policy.catalog.length) return;
      const keys = [...catalog.querySelectorAll('input')].filter((item) => item.checked).map((item) => item.dataset.engineeringRepository);
      // Current host SDK policy admission allows eight repositories; the full
      // configured catalog can contain twenty choices. The server still checks.
      if (keys.length > 8) { notice('Choose at most eight configured repositories. No policy command was sent.'); return; }
      const expectedGeneration = policy.generation; const active = enabledInput.checked === true;
      return operation(async (observation) => {
        const actor = await viewer(observation, session);
        const commandId = text(nextId()); const packet = { commandId, expectedGeneration,
          enabled: active, repositoryKeys: keys };
        const value = await call(policyPath + '/prepare', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(packet) }, observation, actor);
        const intent = value?.intent;
        if (!object(intent) || intent.version !== 1 || intent.actorId !== actor.subject || intent.commandId !== commandId ||
          intent.expectedGeneration !== packet.expectedGeneration || JSON.stringify(intent.repositoryKeys) !== JSON.stringify(keys) ||
          !object(intent.policy) || intent.policy.enabled !== packet.enabled || !Array.isArray(intent.policy.repositories) ||
          intent.policy.repositories.length !== keys.length || new TextEncoder().encode(JSON.stringify({ intent })).byteLength > 131072) throw invalid();
        await viewer(observation, actor);
        preparedPolicy = { actorSubject: actor.subject, body: JSON.stringify({ intent: copy(intent) }) };
        notice('Policy change prepared. Save explicitly; its opaque intent is retained but never displayed.');
      });
    }
    function ack(value, retained) {
      if (!object(value)) return false;
      if (retained.domain === 'policy') return Number.isSafeInteger(value.generation) && value.generation >= 0 &&
        typeof value.enabled === 'boolean' && typeof value.policyHash === 'string' && /^[0-9a-f]{64}$/u.test(value.policyHash);
      if (value.ticketId !== retained.ticketId || !Number.isSafeInteger(value.sourceGeneration) || value.sourceGeneration < 0) return false;
      if (retained.action === 'review') return value.sourceGeneration === retained.sourceGeneration &&
        value.workGeneration === retained.expectedWorkGeneration + 1 &&
        ((retained.decision === 'approve' && value.status === 'approved') || (retained.decision === 'reject' && value.status === 'held'));
      if (retained.action === 'repository') return value.sourceGeneration === retained.sourceGeneration &&
        Number.isSafeInteger(value.workGeneration) && value.workGeneration > 0 && typeof value.status === 'string';
      return states.includes(value.state) && securityValues.includes(value.security);
    }
    async function send(retained, observation) {
      if (now() < retryAt) { notice('Wait for the server retry delay before explicit recovery.'); return; }
      if (retained.action === 'review' && !reviewEnabled()) throw Object.assign(new Error('review_disabled'), { status: 503 });
      const actor = await viewer(observation);
      if (actor.subject !== retained.actorSubject || (retained.domain === 'ticket' && retained.ticketId !== context.ticketId)) throw invalid();
      if (retained.ack === null) {
        const value = await call(retained.path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: retained.body }, observation, actor,
          (result) => { if (ack(result, retained)) { retained.ack = copy(result); changed(); } });
        if (!ack(value, retained)) throw invalid();
        retained.ack = copy(value); changed();
      }
      await viewer(observation, actor);
      if (retained.domain === 'policy') await policyRead(observation, actor, retained);
      else {
        await currentTicket(observation, actor);
        await refreshSource(observation, actor, retained);
        if (retained.action === 'repository') {
          const current = await call(base() + '/work?sourceGeneration=' + retained.sourceGeneration,
            { method: 'GET' }, observation, actor);
          if (!object(current) || current.ticketId !== retained.ticketId || current.sourceGeneration !== retained.sourceGeneration ||
            !Number.isSafeInteger(current.workGeneration) || current.workGeneration < retained.ack.workGeneration) throw invalid();
          await viewer(observation, actor); pending.delete(retained.key); changed();
        }
        if (retained.action === 'enroll') enrolled.set(retained.key, copy(retained.ack));
      }
      if (pending.get(retained.key) === retained) notice('The command was acknowledged. Refresh current state; do not resend it.');
      else notice('Command acknowledged and current authorized state refreshed. No issue was filed.');
    }
    function retain(domain, action, path, packet, extra = {}) {
      const body = JSON.stringify(packet);
      if (new TextEncoder().encode(body).byteLength > (action === 'policy-save' ? 131072 : 65536)) throw new Error('invalid_input');
      const value = { key: key(domain), domain, actorSubject: context.actorSubject,
        ...(domain === 'ticket' ? { ticketId: context.ticketId } : {}), action, path, body, ack: null, ...extra };
      pending.set(value.key, value); changed(); return value;
    }
    async function savePolicy() {
      if (!preparedPolicy || owner('policy') || preparedPolicy.actorSubject !== context?.actorSubject) return;
      const prepared = preparedPolicy;
      return operation(async (observation) => {
        await viewer(observation, session);
        const retained = retain('policy', 'policy-save', policyPath, JSON.parse(prepared.body));
        preparedPolicy = null; await send(retained, observation);
      });
    }
    async function mutate(action) {
      const domain = action === 'policy-disable' ? 'policy' : 'ticket';
      if (!context || owner(domain) || (domain === 'ticket' && !ticket) || (domain === 'policy' && !policy)) return;
      let fields;
      try {
        if (action === 'enroll') fields = { expectedRevision: ticket.revision };
        else if (action === 'evidence') {
          if (evidenceLocked() || !(source || enrolled.has(key('ticket'))) || !securityValues.includes(sensitivity.input.value)) throw new Error('invalid_input');
          const reproductionSteps = steps.input.value.split(/\r?\n/u).map((entry) => text(entry, 1000, true));
          const selected = [...messageChoices.querySelectorAll('input')].filter((item) => item.checked).map((item) => item.value);
          if (!selected.length || selected.length > 16 || selected.some((id) => !ticket.visibleMessageIds.includes(id)) ||
            new Set(selected).size !== selected.length || !reproductionSteps.length || reproductionSteps.length > 16) throw new Error('invalid_input');
          fields = { expectedRevision: ticket.revision, expectedBehavior: text(expected.input.value, 2000, true),
            actualBehavior: text(actual.input.value, 2000, true), reproductionSteps, visibleMessageIds: selected,
            verificationReference: text(reference.input.value), security: sensitivity.input.value };
        } else if (action === 'repository') {
          const choice = work?.selection?.repositoryChoices.find((entry) => entry.key === repository.input.value);
          if (!choice) throw new Error('invalid_input');
          fields = { sourceGeneration: work.sourceGeneration, expectedWorkGeneration: work.workGeneration,
            repositoryKey: choice.key, repositoryId: choice.repositoryId, repositoryDescriptorHash: choice.descriptorHash,
            policyGeneration: work.selection.policyGeneration,
            policyHash: work.selection.policyHash, reason: text(reason.input.value) };
        } else if (action === 'withdraw' && withdrawals.includes(withdrawal.input.value)) fields = { reason: withdrawal.input.value };
        else if (action === 'invalidate' && !evidenceLocked() && invalidations.includes(invalidation.input.value)) fields = { reason: invalidation.input.value };
        else if (action === 'policy-disable') fields = { expectedGeneration: policy.generation };
        else throw new Error('invalid_input');
      } catch { notice('Complete the bounded required fields and choose sensitivity explicitly. No command was sent.'); return; }
      return operation(async (observation) => {
        await viewer(observation, session);
        const packet = { commandId: text(nextId()), ...fields };
        const retained = retain(domain, action, domain === 'policy' ? policyPath + '/disable' : base() + '/' + action,
          packet, action === 'repository' ? { sourceGeneration: fields.sourceGeneration } : {});
        await send(retained, observation);
      });
    }
    async function retry(domain) { const retained = owner(domain); if (!retained) return; return operation((observation) => send(retained, observation)); }
    function suspend() {
      ++epoch; for (const controller of controllers) controller.abort(); controllers.clear();
      context = null; ticket = null; busy = false; activity(); clearPrivate(); notice('Engineering view cleared; retained commands keep their original owners.'); controls();
    }
    async function showTicket(value) {
      suspend(); if (!enabled()) return;
      try {
        const ticketId = text(value?.ticketId); if (!/^[A-Za-z0-9._~-]{1,200}$/u.test(ticketId)) throw invalid();
        context = { ticketId, actorSubject: text(value.actorSubject) }; counter(value.revision, 1);
      } catch { context = null; notice('A current staff ticket is required.'); controls(); return; }
      controls(); return refresh();
    }
    async function showPolicy(value) {
      suspend(); if (!enabled()) return;
      try { context = { ticketId: null, actorSubject: text(value?.actorSubject) }; }
      catch { context = null; controls(); return; }
      controls(); return readPolicy();
    }
    controls();
    return Object.freeze({ showTicket, showPolicy, refresh, readPolicy, suspend,
      hasPending: () => pending.size > 0, pendingOwners: owners, isBusy: () => busy });
  }
  globalThis.PegmaSupportEngineering = Object.freeze({ createPanel });
})();
