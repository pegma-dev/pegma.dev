const statusNode = document.querySelector('#knowledge-status');
const panel = document.querySelector('#knowledge-panel');
const signedOut = document.querySelector('#knowledge-signed-out');
const collectionSelect = document.querySelector('#knowledge-collection');
const resultsNode = document.querySelector('#knowledge-results');
const articleNode = document.querySelector('#knowledge-article');
let csrfToken = '';
let readGeneration = 0;

function status(message, error = false) {
  statusNode.textContent = message;
  statusNode.dataset.tone = error ? 'error' : 'neutral';
}

function failure(error) {
  if (error.status === 401 || error.status === 403) {
    ++readGeneration;
    resultsNode.replaceChildren();
    articleNode.hidden = true;
    document.querySelector('#knowledge-content').textContent = '';
    panel.hidden = true;
    signedOut.hidden = error.status !== 401;
  }
  status(
    error.status === 401
      ? 'Sign in to read your available guides.'
      : error.status === 403
        ? 'These guides are not available to your account.'
        : error.status === 404
          ? 'That guide is unavailable.'
          : 'Guides are temporarily unavailable. Try again later.',
    error.status !== 401,
  );
}

async function json(path, init = {}) {
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
    throw error;
  }
  return body;
}

function portal(operation, input) {
  return json('/api/knowledge/portal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Pegma-CSRF': csrfToken },
    body: JSON.stringify({ operation, input }),
  });
}

async function showArticle(articleId, updateUrl = true) {
  const generation = ++readGeneration;
  articleNode.hidden = true;
  status('Loading guide...');
  const article = await portal('getPublishedArticle', { articleId });
  if (generation !== readGeneration) return;
  document.querySelector('#knowledge-title').textContent = article.title;
  document.querySelector('#knowledge-summary').textContent = article.summary;
  const applicability = article.applicability;
  document.querySelector('#knowledge-applicability').textContent = [
    applicability.productId,
    applicability.productVersion,
    applicability.buildId,
    applicability.locale,
  ]
    .filter(Boolean)
    .join(' · ');
  // Published Markdown is still untrusted content; display it as text.
  document.querySelector('#knowledge-content').textContent =
    article.content.text;
  articleNode.hidden = false;
  if (updateUrl)
    window.history.replaceState(
      null,
      '',
      `/knowledge?${new URLSearchParams({ article: article.articleId })}`,
    );
  status('Approved guide loaded.');
}

document
  .querySelector('#knowledge-search')
  .addEventListener('submit', async (event) => {
    event.preventDefault();
    const generation = ++readGeneration;
    articleNode.hidden = true;
    resultsNode.replaceChildren();
    const fields = new FormData(event.currentTarget);
    const applicability = {
      productId: String(fields.get('productId')).trim(),
      productVersion: String(fields.get('productVersion')).trim(),
    };
    for (const key of ['buildId', 'locale']) {
      const value = String(fields.get(key)).trim();
      if (value) applicability[key] = value;
    }
    status('Searching approved guides...');
    try {
      const result = await portal('searchPublishedArticles', {
        collectionId: fields.get('collectionId'),
        query: String(fields.get('query')).trim(),
        applicability,
      });
      if (generation !== readGeneration) return;
      for (const article of result.articles) {
        const item = document.createElement('li');
        const title = document.createElement('button');
        title.type = 'button';
        title.className = 'text-button';
        title.textContent = article.title;
        title.addEventListener('click', () => {
          showArticle(article.articleId).catch(failure);
        });
        const snippet = document.createElement('p');
        snippet.textContent = article.snippet;
        item.append(title, snippet);
        resultsNode.append(item);
      }
      status(
        result.articles.length
          ? `${result.articles.length} approved guide(s) found.`
          : 'No approved guides match that search and version.',
      );
    } catch (error) {
      if (generation === readGeneration) failure(error);
    }
  });

async function start() {
  try {
    const account = await json('/api/identity/account');
    csrfToken = account.csrfToken;
    const result = await portal('listPortalCollections', {});
    for (const collection of result.collections) {
      const option = document.createElement('option');
      option.value = collection.collectionId;
      option.textContent = collection.label;
      collectionSelect.append(option);
    }
    panel.hidden = false;
    document.querySelector('#knowledge-search button').disabled =
      result.collections.length === 0;
    status(
      result.collections.length
        ? 'Choose a collection and search.'
        : 'No approved guide collections are available to your account.',
    );
    const requested = new URLSearchParams(window.location.search).getAll(
      'article',
    );
    if (requested.length === 1 && requested[0] && requested[0].length <= 512)
      await showArticle(requested[0], false);
  } catch (error) {
    failure(error);
  }
}

await start();
