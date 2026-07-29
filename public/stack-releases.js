/**
 * Same-origin fetch of GET /api/releases for the Stack page.
 * State thresholds mirror worker/src/release-display.ts.
 */

const RELEASE_STALE_AFTER_MS = 12 * 60 * 60 * 1000;
const SAFE_REPO = /^[A-Za-z0-9_.-]+$/;
const SAFE_TAG = /^[A-Za-z0-9._+/~^-]+$/;
const GITHUB_ORG_PREFIX = 'https://github.com/pegma-dev/';

const statusNode = document.querySelector('#release-status');
const releaseLines = document.querySelectorAll('.release-line[data-repository]');

function classifyReleaseState(current, nowMs, fetchFailed) {
  if (fetchFailed) {
    return 'unavailable';
  }
  if (current === null || current === undefined) {
    return 'empty';
  }
  const observedMs = Date.parse(current.observedAt);
  if (
    Number.isFinite(observedMs) &&
    nowMs - observedMs > RELEASE_STALE_AFTER_MS
  ) {
    return 'stale';
  }
  return 'populated';
}

function formatReleaseLabel(current) {
  const publishedMs = Date.parse(current.publishedAt);
  if (!Number.isFinite(publishedMs)) {
    return current.tagName;
  }
  const published = new Date(publishedMs).toISOString().slice(0, 10);
  return `${current.tagName} · ${published}`;
}

function isSafeCurrent(current, repositoryName) {
  if (
    current === null ||
    typeof current !== 'object' ||
    typeof current.tagName !== 'string' ||
    typeof current.releaseUrl !== 'string' ||
    typeof current.publishedAt !== 'string' ||
    typeof current.observedAt !== 'string'
  ) {
    return false;
  }
  if (!SAFE_REPO.test(repositoryName) || !SAFE_TAG.test(current.tagName)) {
    return false;
  }
  const expected = `${GITHUB_ORG_PREFIX}${repositoryName}/releases/tag/${current.tagName}`;
  return current.releaseUrl === expected;
}

function setStatus(state, message) {
  if (!(statusNode instanceof HTMLElement)) {
    return;
  }
  statusNode.dataset.state = state;
  statusNode.textContent = message;
}

function setLineState(line, state, content) {
  const value = line.querySelector('.release-value');
  if (!(value instanceof HTMLElement)) {
    return;
  }
  value.dataset.state = state;
  value.replaceChildren();
  if (typeof content === 'string') {
    value.textContent = content;
    return;
  }
  value.append(content);
}

function renderPopulated(line, current) {
  const link = document.createElement('a');
  link.href = current.releaseUrl;
  link.textContent = formatReleaseLabel(current);
  link.rel = 'noopener noreferrer';
  setLineState(line, 'populated', link);
}

function renderStale(line, current) {
  const wrap = document.createDocumentFragment();
  const link = document.createElement('a');
  link.href = current.releaseUrl;
  link.textContent = formatReleaseLabel(current);
  link.rel = 'noopener noreferrer';
  wrap.append(link);
  wrap.append(document.createTextNode(' (may be stale)'));
  setLineState(line, 'stale', wrap);
}

function applyReleases(body, fetchFailed) {
  const nowMs = Date.now();
  const byName = new Map();
  if (
    body !== null &&
    typeof body === 'object' &&
    Array.isArray(body.releases)
  ) {
    for (const entry of body.releases) {
      if (
        entry !== null &&
        typeof entry === 'object' &&
        typeof entry.repositoryName === 'string'
      ) {
        byName.set(entry.repositoryName, entry);
      }
    }
  }

  let populated = 0;
  let stale = 0;

  for (const line of releaseLines) {
    if (!(line instanceof HTMLElement)) {
      continue;
    }
    const repositoryName = line.dataset.repository ?? '';
    const entry = byName.get(repositoryName);
    const rawCurrent = entry?.current ?? null;
    const current =
      rawCurrent !== null && isSafeCurrent(rawCurrent, repositoryName)
        ? rawCurrent
        : null;
    const state = classifyReleaseState(current, nowMs, fetchFailed);

    if (state === 'unavailable') {
      setLineState(line, 'unavailable', 'Temporarily unavailable');
      continue;
    }
    if (state === 'empty' || current === null) {
      setLineState(line, 'empty', 'No stable release recorded yet');
      continue;
    }
    if (state === 'stale') {
      stale += 1;
      renderStale(line, current);
      continue;
    }
    populated += 1;
    renderPopulated(line, current);
  }

  if (fetchFailed) {
    setStatus(
      'unavailable',
      'Current release versions are temporarily unavailable. Repository links below still work.',
    );
    return;
  }

  if (populated === 0 && stale === 0) {
    setStatus(
      'empty',
      'No stable release versions are recorded yet. Repository links below still work.',
    );
    return;
  }

  if (stale > 0 && populated === 0) {
    setStatus(
      'stale',
      'Release versions are available but may be stale. Repository links remain authoritative.',
    );
    return;
  }

  if (stale > 0) {
    setStatus(
      'stale',
      `Showing current stable releases (${stale} may be stale). Values come from D1, not a site rebuild.`,
    );
    return;
  }

  setStatus(
    'populated',
    'Showing current stable releases from the live API (no site rebuild required).',
  );
}

async function start() {
  try {
    const response = await fetch('/api/releases', {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
      applyReleases(null, true);
      return;
    }
    const body = await response.json();
    if (
      body === null ||
      typeof body !== 'object' ||
      body.schema !== 'pegma.releases.v1' ||
      !Array.isArray(body.releases)
    ) {
      applyReleases(null, true);
      return;
    }
    applyReleases(body, false);
  } catch {
    applyReleases(null, true);
  }
}

await start();
