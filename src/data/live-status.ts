/**
 * Build-time compilation of component status from each repository's public
 * PROJECT_PLAN.md — the roadmap page's "cannot drift" mechanism. Fetches run
 * during the static build (never in a browser), are cached per build, and
 * FAIL SOFT: any fetch or parse miss falls back to the registry's hand-written
 * `now` line, so a GitHub hiccup can never break a deploy.
 */

const cache = new Map<string, Promise<string | null>>();

async function fetchStage(repo: string, plan: string): Promise<string | null> {
  try {
    const url = new URL(`https://api.github.com/repos/pegma-dev/${repo}/contents/${plan}`);
    url.searchParams.set('ref', 'main');
    const res = await fetch(url, {
      cache: 'no-store',
      headers: {
        Accept: 'application/vnd.github.raw',
        'User-Agent': 'pegma-dev-status-build',
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const text = await res.text();
    // The house style opens with "## Status" (or "## Current Status") whose
    // first paragraph is the stage line.
    // Avoid multiline mode here: with it, `$` also matches the end of the
    // first status line and silently drops wrapped paragraph text.
    const section = text.match(
      /(?:^|\n)##\s+(?:Current\s+)?Status\s*\r?\n+([\s\S]*?)(?=\r?\n#{2,3}\s|$)/,
    );
    if (!section) return null;
    const stage = section[1]
      .trim()
      .split(/\n\s*\n/)[0]
      .replace(/\*\*/g, '')
      .replace(/`/g, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/^Stage:\s*/i, '')
      .replace(/\s+/g, ' ')
      .trim();
    return stage || null;
  } catch {
    return null;
  }
}

/** Stage text from the repo's plan, or null when there is no plan or the
 * fetch failed. Cached so stack and roadmap share one fetch per repo. */
export function planStage(repo: string, plan: string | undefined): Promise<string | null> {
  if (!plan) return Promise.resolve(null);
  let hit = cache.get(repo);
  if (!hit) {
    hit = fetchStage(repo, plan);
    cache.set(repo, hit);
  }
  return hit;
}
