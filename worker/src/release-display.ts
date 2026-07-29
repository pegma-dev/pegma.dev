/**
 * Pure UI-state helpers for the Stack release surface. Shared by tests and
 * mirrored in public/stack-releases.js (keep thresholds in sync).
 */

/** Mark a current release stale when its observation is older than this. */
export const RELEASE_STALE_AFTER_MS = 12 * 60 * 60 * 1000;

export type ReleaseUiState =
  | 'loading'
  | 'empty'
  | 'populated'
  | 'stale'
  | 'unavailable';

export interface ReleaseDisplayInput {
  readonly tagName: string;
  readonly publishedAt: string;
  readonly releaseUrl: string;
  readonly observedAt: string;
}

export function classifyReleaseState(
  current: ReleaseDisplayInput | null | undefined,
  nowMs: number,
  fetchFailed: boolean,
): ReleaseUiState {
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

export function formatReleaseLabel(current: ReleaseDisplayInput): string {
  const publishedMs = Date.parse(current.publishedAt);
  if (!Number.isFinite(publishedMs)) {
    return current.tagName;
  }
  const published = new Date(publishedMs).toISOString().slice(0, 10);
  return `${current.tagName} · ${published}`;
}
