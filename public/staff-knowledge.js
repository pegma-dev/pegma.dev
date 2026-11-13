const select = (selector) => document.querySelector(selector);
const panel = select('#kb-panel');
const statusNode = select('#kb-status');
let csrfToken = '';
let attesterId = '';
let permissions = {};
let collection = null;
let governanceGeneration = null;
let validationGeneration = 0;
let validationId = '';
let draft = null;
let review = null;
let report = null;
let evidenceSnapshot = null;
let reportLedger = null;
let busy = false;
let requirementCounter = 0;
const commandIds = new Map();

function status(message, error = false) {
  statusNode.textContent = message;
  statusNode.dataset.tone = error ? 'error' : 'neutral';
}

function text(selector, value) {
  select(selector).textContent = JSON.stringify(value, null, 2);
}

function required(selector) {
  const value = select(selector).value.trim();
  if (!value)
    throw Object.assign(new Error('missing_field'), {
      clientMessage: 'Complete the required fields first.',
    });
  return value;
}

function lines(value) {
  return value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
}

async function request(path, init = {}) {
  const response = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    cache: 'no-store',
    referrerPolicy: 'no-referrer',
  });
  const body = await response.json();
  if (!response.ok) {
    const error = new Error(
      typeof body.error === 'string' ? body.error : 'unavailable',
    );
    error.status = response.status;
    const retry = response.headers.get('Retry-After');
    const seconds =
      retry === null
        ? NaN
        : /^\d+$/u.test(retry)
          ? Number(retry)
          : Math.ceil((Date.parse(retry) - Date.now()) / 1000);
    if (Number.isFinite(seconds) && seconds >= 0)
      error.retryAfterSeconds = seconds;
    throw error;
  }
  return body;
}

function call(operation, input) {
  return request('/api/staff/knowledge/command', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Pegma-CSRF': csrfToken },
    body: JSON.stringify({ operation, input }),
  });
}

function mutate(operation, input, sdk = true) {
  const intent = JSON.stringify({ operation, input });
  if (!commandIds.has(intent)) commandIds.set(intent, crypto.randomUUID());
  const commandId = commandIds.get(intent);
  return call(operation, {
    ...input,
    commandId,
    ...(sdk ? { correlationId: commandId } : {}),
  });
}

async function run(action) {
  if (busy) return;
  busy = true;
  for (const field of panel.querySelectorAll('button,input,select,textarea'))
    field.disabled = true;
  try {
    await action();
  } catch (error) {
    if (error.status === 401 || error.status === 403) {
      collection = null;
      draft = null;
      review = null;
      report = null;
      csrfToken = '';
      for (const node of panel.querySelectorAll('pre')) node.textContent = '';
      panel.hidden = true;
      select('#kb-signed-out').hidden = error.status !== 401;
    }
    status(
      (error.status === 429
        ? Number.isFinite(error.retryAfterSeconds)
          ? `Too many requests. Try again in ${error.retryAfterSeconds} second(s).`
          : 'Too many requests. Wait before trying again.'
        : error.clientMessage) ??
        (error.status === 401
          ? 'Sign in to continue.'
          : error.status === 403
            ? 'Your current account does not have permission for this operation.'
            : error.status === 409
              ? 'The record changed or its checks are not current. Reload and review before trying again.'
              : error.status === 404
                ? 'That record is unavailable.'
                : 'The operation could not be completed. Reload current state or retry the same request.'),
      true,
    );
  } finally {
    busy = false;
    for (const field of panel.querySelectorAll('button,input,select,textarea'))
      field.disabled = false;
  }
}

function requireCollection() {
  if (!collection)
    throw Object.assign(new Error('collection_required'), {
      clientMessage: 'Load a collection first.',
    });
  return collection.collection.id;
}

function requireArticle() {
  if (!draft)
    throw Object.assign(new Error('article_required'), {
      clientMessage: 'Load the current draft first.',
    });
  return draft.articleId;
}

async function loadGovernance() {
  const collectionId = requireCollection();
  try {
    const result = await call('getGovernanceConfiguration', { collectionId });
    governanceGeneration = result.generation;
    select('#kb-governance-policy').value =
      result.configuration.validationPolicy.id;
    select('#kb-governance-version').value = String(
      result.configuration.validationPolicy.version,
    );
    select('#kb-staging-build').value =
      result.configuration.expectedStagingBuildId;
    select('#kb-attesters').value =
      result.configuration.trustedAttesterIds.join('\n');
    text('#kb-governance-detail', result);
  } catch (error) {
    if (error.status !== 404) throw error;
    governanceGeneration = collection.generation;
    select('#kb-governance-policy').value = '';
    select('#kb-governance-version').value = '1';
    select('#kb-staging-build').value = '';
    select('#kb-attesters').value = attesterId;
    select('#kb-governance-detail').textContent =
      'No governance is configured yet.';
  }
}

async function loadCollection(collectionId) {
  collection = null;
  governanceGeneration = null;
  policyPreview = null;
  ++policyEditorVersion;
  select('#kb-collection-detail').textContent = '';
  select('#kb-governance-detail').textContent = '';
  select('#kb-portal-form').hidden = true;
  select('#kb-policy-preview').hidden = true;
  select('#kb-policy-apply').hidden = true;
  collection = await call('getCollection', { collectionId });
  text('#kb-collection-detail', collection);
  select('#kb-portal-form').hidden = permissions.collectionManage !== true;
  const bot = collection.collection.policy.bot;
  select('#kb-bot-enabled').checked = bot.enabled;
  select('#kb-bot-permission').value =
    bot.enabled && bot.audience.kind === 'permission'
      ? bot.audience.permission
      : 'knowledge.article.read';
  const portal = collection.collection.policy.portal;
  select('#kb-portal-enabled').checked = portal.enabled;
  select('#kb-portal-permission').value =
    portal.enabled && portal.audience.kind === 'permission'
      ? portal.audience.permission
      : 'knowledge.article.read';
  select('#kb-policy-preview').hidden = true;
  select('#kb-policy-apply').hidden = true;
  if (permissions.validationManage) await loadGovernance();
  status('Collection loaded.');
}

select('#kb-collection-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const action = event.submitter?.value;
  run(async () => {
    const collectionId = required('#kb-collection-id');
    if (action === 'create')
      await mutate('createCollection', {
        collectionId,
        name: required('#kb-collection-name'),
        expectedGeneration: 0,
      });
    await loadCollection(collectionId);
  });
});

let policyPreview = null;
let policyEditorVersion = 0;
select('#kb-portal-form').addEventListener('submit', (event) => {
  event.preventDefault();
  run(async () => {
    const collectionId = requireCollection();
    const portal = select('#kb-portal-enabled').checked
      ? {
          enabled: true,
          audience: {
            kind: 'permission',
            permission: required('#kb-portal-permission'),
          },
        }
      : { enabled: false };
    const bot = select('#kb-bot-enabled').checked
      ? {
          enabled: true,
          audience: {
            kind: 'permission',
            permission: required('#kb-bot-permission'),
          },
        }
      : { enabled: false };
    const editorVersion = policyEditorVersion;
    const preview = await call('previewCollectionPolicy', {
      collectionId,
      uses: { portal, bot },
    });
    if (editorVersion !== policyEditorVersion) {
      status('Audience settings changed. Preview them again before applying.');
      return;
    }
    policyPreview = preview;
    text('#kb-policy-preview', policyPreview);
    select('#kb-policy-preview').hidden = false;
    select('#kb-policy-apply').hidden = permissions.collectionManage !== true;
    status('Review the exact audience policy preview before applying it.');
  });
});

for (const field of [
  '#kb-portal-enabled',
  '#kb-portal-permission',
  '#kb-bot-enabled',
  '#kb-bot-permission',
]) {
  for (const event of ['input', 'change'])
    select(field).addEventListener(event, () => {
      ++policyEditorVersion;
      policyPreview = null;
      select('#kb-policy-preview').hidden = true;
      select('#kb-policy-apply').hidden = true;
    });
}
select('#kb-policy-apply').addEventListener('click', () =>
  run(async () => {
    if (
      !policyPreview ||
      !window.confirm('Apply this exact reviewed audience policy?')
    )
      return;
    const collectionId = requireCollection();
    await mutate('updateCollectionPolicy', {
      collectionId,
      expectedGeneration: policyPreview.generation,
      preview: policyPreview.preview,
    });
    policyPreview = null;
    await loadCollection(collectionId);
  }),
);

select('#kb-governance-read').addEventListener('click', () =>
  run(async () => {
    await loadGovernance();
    status('Current governance loaded.');
  }),
);
select('#kb-governance-form').addEventListener('submit', (event) => {
  event.preventDefault();
  run(async () => {
    const collectionId = requireCollection();
    if (governanceGeneration === null)
      throw Object.assign(new Error('load_governance'), {
        clientMessage: 'Load current governance first.',
      });
    await mutate('putGovernanceConfiguration', {
      collectionId,
      expectedGeneration: governanceGeneration,
      configuration: {
        validationPolicy: {
          id: required('#kb-governance-policy'),
          version: Number(required('#kb-governance-version')),
        },
        expectedStagingBuildId: required('#kb-staging-build'),
        trustedAttesterIds: lines(required('#kb-attesters')),
      },
    });
    await loadCollection(collectionId);
    status(
      'Governance saved. Existing reviews must pass the current configuration.',
    );
  });
});

function addRequirement(value = {}) {
  const row = document.createElement('fieldset');
  row.dataset.requirement = 'true';
  const legend = document.createElement('legend');
  legend.textContent = 'Validation check';
  row.append(legend);
  const fields = [
    ['id', 'Check ID'],
    ['kind', 'Article kind'],
    ['testKind', 'Test kind'],
    ['maxAgeMilliseconds', 'Maximum evidence age (milliseconds)'],
    ['trustedRunnerIds', 'Trusted runner IDs (one per line)'],
  ];
  for (const [key, title] of fields) {
    const label = document.createElement('label');
    const input =
      key === 'kind'
        ? document.createElement('select')
        : key === 'trustedRunnerIds'
          ? document.createElement('textarea')
          : document.createElement('input');
    input.id = `kb-check-${++requirementCounter}`;
    input.dataset.field = key;
    input.required = true;
    if (key === 'kind') {
      for (const kind of [
        'explanation',
        'walkthrough',
        'troubleshooting',
        'developer-reference',
      ]) {
        const option = document.createElement('option');
        option.value = kind;
        option.textContent = kind;
        input.append(option);
      }
    } else if (key === 'maxAgeMilliseconds') {
      input.type = 'number';
      input.min = '1';
      input.step = '1';
    } else if (key !== 'trustedRunnerIds') input.maxLength = 200;
    label.htmlFor = input.id;
    label.textContent = title;
    input.value =
      key === 'trustedRunnerIds'
        ? (value[key] ?? []).join('\n')
        : String(value[key] ?? '');
    if (key === 'kind' && !value.kind) input.value = 'explanation';
    row.append(label, input);
  }
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'secondary-button';
  remove.textContent = 'Remove check';
  remove.addEventListener('click', () => row.remove());
  row.append(remove);
  select('#kb-requirements').append(row);
}

select('#kb-add-requirement').addEventListener('click', () => addRequirement());
select('#kb-validation-read').addEventListener('submit', (event) => {
  event.preventDefault();
  run(async () => {
    const policyId = required('#kb-validation-id');
    validationId = '';
    validationGeneration = 0;
    select('#kb-requirements').replaceChildren();
    try {
      const result = await call('getValidationPolicy', { policyId });
      validationId = result.policy.id;
      validationGeneration = result.generation;
      select('#kb-validation-version').value = String(result.policy.version);
      select('#kb-requirements').replaceChildren();
      for (const check of result.policy.requirements) addRequirement(check);
      status('Validation policy loaded.');
    } catch (error) {
      if (error.status !== 404) throw error;
      validationId = policyId;
      validationGeneration = 0;
      select('#kb-requirements').replaceChildren();
      addRequirement();
      status(
        'No policy exists at that ID. Define its first version and checks.',
      );
    }
  });
});

select('#kb-validation-form').addEventListener('submit', (event) => {
  event.preventDefault();
  run(async () => {
    const id = required('#kb-validation-id');
    const requirements = [...select('#kb-requirements').children].map((row) => {
      const field = (key) =>
        row.querySelector(`[data-field="${key}"]`).value.trim();
      return {
        id: field('id'),
        kind: field('kind'),
        testKind: field('testKind'),
        maxAgeMilliseconds: Number(field('maxAgeMilliseconds')),
        trustedRunnerIds: lines(field('trustedRunnerIds')),
      };
    });
    if (!requirements.length)
      throw Object.assign(new Error('missing_checks'), {
        clientMessage: 'Add the required validation checks first.',
      });
    const result = await mutate('putValidationPolicy', {
      expectedGeneration: id === validationId ? validationGeneration : 0,
      policy: {
        id,
        version: Number(required('#kb-validation-version')),
        requirements,
      },
    });
    validationId = id;
    validationGeneration = result.value.generation;
    status('Validation policy saved.');
  });
});

async function loadDraft(articleId) {
  draft = null;
  review = null;
  report = null;
  evidenceSnapshot = null;
  reportLedger = null;
  select('#kb-draft-detail').textContent = '';
  select('#kb-article-actions').hidden = true;
  select('#kb-review-panel').hidden = true;
  select('#kb-report-panel').hidden = true;
  select('#kb-ledger-panel').hidden = true;
  select('#kb-evidence-panel').hidden = true;
  select('#kb-evidence-select').replaceChildren();
  select('#kb-evidence-selected').textContent = '';
  select('#kb-article-detail').textContent = '';
  select('#kb-report-list').replaceChildren();
  draft = await call('getDraft', { articleId });
  text('#kb-draft-detail', draft);
  select('#kb-article-actions').hidden = false;
  status('Current draft loaded.');
}

select('#kb-article-form').addEventListener('submit', (event) => {
  event.preventDefault();
  run(() => loadDraft(required('#kb-article-id')));
});
for (const [button, operation] of [['#kb-provenance-read', 'getProvenance']]) {
  select(button).addEventListener('click', () =>
    run(async () => {
      text(
        '#kb-article-detail',
        await call(operation, { articleId: requireArticle() }),
      );
      status('Current private staff detail loaded.');
    }),
  );
}

async function loadEvidence() {
  evidenceSnapshot = null;
  select('#kb-evidence-panel').hidden = true;
  select('#kb-evidence-selected').textContent = '';
  const result = await call('getEvidence', { articleId: requireArticle() });
  evidenceSnapshot = result;
  text('#kb-article-detail', result);
  const choices = select('#kb-evidence-select');
  choices.replaceChildren();
  const prompt = document.createElement('option');
  prompt.value = '';
  prompt.textContent = 'Select the exact evidence version to revoke';
  choices.append(prompt);
  for (const [index, item] of result.evidence.entries()) {
    const revoked = result.revokedEvidence.some(
      (entry) =>
        entry.articleRevision === item.articleRevision &&
        entry.id === item.id &&
        entry.version === item.version &&
        entry.hash === item.hash,
    );
    if (revoked) continue;
    const option = document.createElement('option');
    option.value = String(index);
    option.textContent = `${item.id} · article revision ${item.articleRevision} · evidence version ${item.version} · ${item.hash}`;
    choices.append(option);
  }
  select('#kb-evidence-panel').hidden = permissions.evidenceRevoke !== true;
  status('Current evidence and exact revocation choices loaded.');
}

select('#kb-evidence-read').addEventListener('click', () => run(loadEvidence));
select('#kb-evidence-select').addEventListener('change', () => {
  const value = select('#kb-evidence-select').value;
  const item = value === '' ? null : evidenceSnapshot?.evidence[Number(value)];
  if (item) text('#kb-evidence-selected', item);
  else select('#kb-evidence-selected').textContent = '';
});
select('#kb-evidence-revoke').addEventListener('submit', (event) => {
  event.preventDefault();
  run(async () => {
    const value = select('#kb-evidence-select').value;
    const snapshot = evidenceSnapshot;
    const item = value === '' ? null : snapshot?.evidence[Number(value)];
    if (!snapshot || !item || permissions.evidenceRevoke !== true) return;
    const reason = required('#kb-evidence-reason');
    if (
      !window.confirm(
        `Revoke evidence ${item.id}, version ${item.version}, hash ${item.hash}, for article ${snapshot.articleId} revision ${item.articleRevision}?`,
      )
    )
      return;
    await mutate('revokeEvidence', {
      articleId: snapshot.articleId,
      expectedGeneration: snapshot.generation,
      articleRevision: item.articleRevision,
      evidenceId: item.id,
      evidenceVersion: item.version,
      evidenceHash: item.hash,
      reason,
    });
    await loadDraft(snapshot.articleId);
    await loadEvidence();
    status('The exact evidence version was revoked.');
  });
});

select('#kb-retire').addEventListener('click', () =>
  run(async () => {
    requireArticle();
    const snapshot = draft;
    if (
      permissions.retire !== true ||
      !window.confirm(
        `Retire article ${snapshot.articleId} at generation ${snapshot.generation}, revision ${snapshot.revision.number}, content hash ${snapshot.revision.contentHash}? Any publication will be withdrawn.`,
      )
    )
      return;
    await mutate('retireArticle', {
      articleId: snapshot.articleId,
      expectedGeneration: snapshot.generation,
    });
    await loadDraft(snapshot.articleId);
    status(
      draft.state === 'retired'
        ? 'Article retired.'
        : 'Retirement acknowledged. The current article state is shown above.',
    );
  }),
);

select('#kb-submit-review').addEventListener('click', () =>
  run(async () => {
    const articleId = requireArticle();
    await mutate('submitForReview', {
      articleId,
      expectedGeneration: draft.generation,
    });
    await loadDraft(articleId);
    status('Draft submitted. Load the exact review before publishing.');
  }),
);
select('#kb-review-read').addEventListener('click', () =>
  run(async () => {
    review = null;
    select('#kb-review-panel').hidden = true;
    review = await call('getReview', { articleId: requireArticle() });
    text('#kb-review-detail', review);
    select('#kb-review-panel').hidden = false;
    status('Review the complete snapshot before publication.');
  }),
);
select('#kb-publish').addEventListener('click', () =>
  run(async () => {
    if (
      !review ||
      !window.confirm(
        'Approve and publish exactly this reviewed article revision?',
      )
    )
      return;
    const articleId = requireArticle();
    await mutate('publishArticle', {
      articleId,
      expectedGeneration: review.generation,
      review: review.review,
    });
    await loadDraft(articleId);
    status('Reviewed revision published.');
  }),
);
select('#kb-reject-review').addEventListener('submit', (event) => {
  event.preventDefault();
  run(async () => {
    if (!review) return;
    const articleId = requireArticle();
    await mutate('rejectReview', {
      articleId,
      expectedGeneration: review.generation,
      reason: required('#kb-review-reason'),
    });
    await loadDraft(articleId);
    status('Review rejected.');
  });
});

function showLedger(ledger) {
  reportLedger = ledger;
  text('#kb-ledger-detail', ledger);
  select('#kb-ledger-panel').hidden = false;
  select('#kb-ledger-reset').hidden =
    permissions.evidenceConfirm !== true || ledger.status !== 'active';
  select('#kb-ledger-drain').hidden =
    permissions.evidenceConfirm !== true || ledger.status !== 'resetting';
}

async function loadLedger() {
  const ledger = await call('reportLedger', { articleId: requireArticle() });
  showLedger(ledger);
  return ledger;
}

async function drainLedger(ledger) {
  for (let page = 0; page < 4 && ledger.status === 'resetting'; page += 1) {
    ledger = await call('drainReports', {
      articleId: ledger.articleId,
      ledgerEpoch: ledger.ledgerEpoch,
    });
    showLedger(ledger);
  }
  status(
    ledger.status === 'active'
      ? 'Report cleanup completed. Earlier report receipts remain invalid.'
      : 'This bounded cleanup pass finished. Continue cleanup to inspect the remaining rows.',
  );
}

select('#kb-ledger-read').addEventListener('click', () =>
  run(async () => {
    await loadLedger();
    status('Current report ledger loaded.');
  }),
);
select('#kb-ledger-reset').addEventListener('click', () =>
  run(async () => {
    if (!reportLedger || permissions.evidenceConfirm !== true) return;
    const snapshot = reportLedger;
    if (
      !window.confirm(
        `Reset report ledger ${snapshot.articleId} at epoch ${snapshot.ledgerEpoch}? Earlier report receipts and commands become permanently invalid. Accepted KB evidence and publication are unchanged.`,
      )
    )
      return;
    const result = await mutate(
      'resetReports',
      {
        articleId: snapshot.articleId,
        expectedLedgerEpoch: snapshot.ledgerEpoch,
      },
      false,
    );
    report = null;
    select('#kb-report-panel').hidden = true;
    select('#kb-report-list').replaceChildren();
    showLedger(result);
    await drainLedger(result);
  }),
);
select('#kb-ledger-drain').addEventListener('click', () =>
  run(async () => {
    if (permissions.evidenceConfirm !== true) return;
    await drainLedger(await loadLedger());
  }),
);

async function readReport(reportId, ledgerEpoch) {
  report = null;
  select('#kb-report-panel').hidden = true;
  select('#kb-report-detail').textContent = '';
  if (ledgerEpoch === undefined) ledgerEpoch = (await loadLedger()).ledgerEpoch;
  report = await call('reportRead', {
    articleId: requireArticle(),
    reportId,
    ledgerEpoch,
  });
  select('#kb-report-id').value = report.reportId;
  text('#kb-report-detail', report);
  const elapsed = Date.now() - Date.parse(report.evidence.executedAt);
  select('#kb-report-age').textContent = Number.isFinite(elapsed)
    ? `Execution age by this browser's clock: ${Math.floor(elapsed / 60_000)} minute(s). Current acceptance and maximum-age checks are performed by the service.`
    : 'Execution time is shown in the report above.';
  select('#kb-report-panel').hidden = false;
  status('Review this report and its current exact bindings before deciding.');
}

select('#kb-reports-read').addEventListener('click', () =>
  run(async () => {
    const result = await call('reportList', { articleId: requireArticle() });
    showLedger(result.ledger);
    select('#kb-report-list').replaceChildren();
    for (const item of result.reports) {
      const row = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = item.reportId;
      button.addEventListener('click', () =>
        run(() => readReport(item.reportId, result.ledger.ledgerEpoch)),
      );
      const summary = document.createElement('p');
      summary.textContent = `${item.status} · ${item.submittedAt} · ${typeof item.summary === 'string' ? item.summary : JSON.stringify(item.summary)}`;
      row.append(button, summary);
      select('#kb-report-list').append(row);
    }
    status(
      result.reports.length
        ? 'Select a report to inspect.'
        : 'No reports are available for this article.',
    );
  }),
);
select('#kb-report-read').addEventListener('submit', (event) => {
  event.preventDefault();
  run(() => readReport(required('#kb-report-id')));
});
for (const [button, operation, decision] of [
  ['#kb-report-confirm', 'confirmReport', 'confirm'],
  ['#kb-report-reject', 'rejectReport', 'reject'],
  ['#kb-report-reassess', 'reassessReport', 'reassess'],
]) {
  select(button).addEventListener('click', () =>
    run(async () => {
      if (
        !report ||
        !window.confirm(
          `Record your decision to ${decision} this exact report and current revision/build binding?`,
        )
      )
        return;
      const result = await mutate(
        operation,
        {
          articleId: report.articleId,
          reportId: report.reportId,
          ledgerEpoch: report.ledgerEpoch,
          expectedReportGeneration: report.expectedReportGeneration,
          reviewBindingHash: report.reviewBindingHash,
        },
        false,
      );
      report = null;
      select('#kb-report-panel').hidden = true;
      text('#kb-article-detail', result);
      status(
        decision === 'confirm'
          ? 'Human review recorded. The agent can submit the exact evidence with its existing report receipt; Knowledge Base acceptance is a separate step.'
          : decision === 'reassess'
            ? 'Report returned to pending human review. The earlier confirmation no longer applies; the agent must poll the current report status and use its current receipt.'
            : 'Report rejected.',
      );
    }),
  );
}

await run(async () => {
  const state = await request('/api/staff/knowledge/state');
  csrfToken = state.csrfToken;
  attesterId = state.attesterId;
  permissions = state.permissions;
  for (const node of panel.querySelectorAll('[data-kb-permission]'))
    node.hidden = permissions[node.dataset.kbPermission] !== true;
  select('#kb-attester-note').textContent =
    `This browser review uses current attester ID: ${attesterId}`;
  select('#kb-attesters').value = attesterId;
  panel.hidden = false;
  addRequirement();
  status('Ready. Load a collection or draft, or configure a new collection.');
});
