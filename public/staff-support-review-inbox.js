(function (global) {
  'use strict';
  const INBOX = '/api/support/admin/engineering/review-inbox';
  const scalar = (v, max = 200) =>
    typeof v === 'string' &&
    v.length > 0 &&
    v.length <= max &&
    v.trim().length > 0 &&
    !/[\u0000-\u001f\u007f-\u009f]/u.test(v);
  function reviewPage(value) {
    if (
      !value ||
      !Array.isArray(value.reviewSources) ||
      !Array.isArray(value.reviewCandidates) ||
      value.reviewSources.length + value.reviewCandidates.length > 10 ||
      !value.reviewSources.every((id) => scalar(id)) ||
      !value.reviewCandidates.every(
        (item) =>
          item &&
          scalar(item.ticketId) &&
          Number.isSafeInteger(item.sourceGeneration) &&
          item.sourceGeneration > 0,
      ) ||
      !Number.isSafeInteger(value.physicalRows) ||
      value.physicalRows < 0 ||
      value.pages !== 1 ||
      (value.nextCursor !== null && !scalar(value.nextCursor, 20000))
    )
      return null;
    return value;
  }
  function createReviewInbox(options) {
    const { host, request, session, capture, openTicket, denied } = options;
    const doc = host.ownerDocument ?? document;
    const create = (tag, text, key) => {
      const node = doc.createElement(tag);
      if (text !== undefined) node.textContent = text;
      if (key) node.setAttribute('data-engineering-inbox', key);
      return node;
    };
    const heading = create('h3', 'Engineering review inbox');
    const status = create(
      'p',
      'Load one bounded page of sources and proposals needing staff review.',
      'status',
    );
    status.setAttribute('role', 'status');
    const list = create('ul', undefined, 'list');
    const load = create('button', 'Load review inbox', 'load');
    const next = create('button', 'Next review page', 'next');
    for (const button of [load, next]) {
      button.type = 'button';
      button.className = 'account-button';
    }
    next.disabled = true;
    host.replaceChildren(heading, status, list, load, next);
    let epoch = 0;
    let cursor;
    let busy = false;
    let retryAt = 0;
    function clear() {
      ++epoch;
      cursor = undefined;
      busy = false;
      list.replaceChildren();
      next.disabled = true;
      load.disabled = false;
      status.textContent =
        'Load one bounded page of sources and proposals needing staff review.';
    }
    async function scan(after) {
      if (busy) return;
      if (Date.now() < retryAt) {
        status.textContent = 'Please wait before requesting another page.';
        return;
      }
      const observed = ++epoch;
      const currentView = capture();
      const current = () => observed === epoch && currentView();
      if (!current()) return;
      busy = true;
      load.disabled = true;
      next.disabled = true;
      list.replaceChildren();
      cursor = undefined;
      status.textContent = 'Loading review inbox...';
      try {
        const before = await session();
        if (!current()) return;
        if (!before?.accountId)
          throw new Error('Current staff account is unavailable.');
        const query = new URLSearchParams({ limit: '10' });
        if (after !== undefined) query.set('cursor', after);
        const response = await request(INBOX + '?' + query);
        if (!current()) return;
        if (response.status === 401 || response.status === 403) {
          clear();
          denied(response.status);
          return;
        }
        if (response.status === 429) {
          const hint =
            response.headers?.get?.('Retry-After') ??
            response.headers?.['retry-after'];
          const seconds =
            typeof hint === 'string' && /^\d+$/u.test(hint) ? Number(hint) : 30;
          retryAt = Date.now() + Math.max(1, Math.min(seconds, 3600)) * 1000;
          throw new Error('Please wait before requesting another page.');
        }
        const page =
          response.status === 200 ? reviewPage(response.body?.result) : null;
        if (!page) throw new Error('Review inbox is unavailable.');
        const latest = await session();
        if (!current()) return;
        if (latest?.accountId !== before.accountId) {
          clear();
          denied(403);
          return;
        }
        for (const item of [
          ...page.reviewSources.map((ticketId) => ({
            ticketId,
            label: 'Source needs review',
          })),
          ...page.reviewCandidates.map((candidate) => ({
            ...candidate,
            label: 'Proposal generation ' + candidate.sourceGeneration,
          })),
        ]) {
          const row = create('li');
          const button = create(
            'button',
            item.ticketId + ' · ' + item.label,
            'ticket',
          );
          button.type = 'button';
          button.className = 'account-button account-button-quiet';
          button.addEventListener('click', () => {
            if (current()) {
              clear();
              openTicket(item.ticketId);
            }
          });
          row.append(button);
          list.append(row);
        }
        cursor = page.nextCursor ?? undefined;
        status.textContent =
          page.reviewSources.length + page.reviewCandidates.length === 0
            ? 'No staff reviews on this page.'
            : 'Open a ticket to inspect its current source and exact proposal.';
      } catch (error) {
        if (current() && (error?.status === 401 || error?.status === 403)) {
          clear();
          denied(error.status);
        } else if (current())
          status.textContent =
            error instanceof Error
              ? error.message
              : 'Review inbox is unavailable.';
      } finally {
        if (current()) {
          busy = false;
          load.disabled = false;
          next.disabled = cursor === undefined;
        }
      }
    }
    load.addEventListener('click', () => {
      void scan();
    });
    next.addEventListener('click', () => {
      if (cursor !== undefined) void scan(cursor);
    });
    return { clear };
  }
  global.PegmaSupportReviewInbox = { createReviewInbox };
})(globalThis);
