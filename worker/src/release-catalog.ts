/**
 * Display-ordered Pegma repositories eligible for public release facts.
 * Numeric IDs match wrangler `GITHUB_ALLOWED_REPOSITORY_IDS`; names match
 * the Stack component registry (plus the site repo itself).
 */
export interface ReleaseCatalogEntry {
  readonly repositoryId: string;
  readonly repositoryName: string;
}

/** Component registry order first, then the pegma.dev site repository. */
export const RELEASE_CATALOG: readonly ReleaseCatalogEntry[] = [
  { repositoryId: '1312512520', repositoryName: 'spine' },
  { repositoryId: '1312519623', repositoryName: 'storage-core' },
  { repositoryId: '1312811498', repositoryName: 'authorization-core' },
  { repositoryId: '1312961609', repositoryName: 'audit' },
  { repositoryId: '1312942188', repositoryName: 'support-desk' },
  { repositoryId: '1313911960', repositoryName: 'webhooks' },
  { repositoryId: '1313917945', repositoryName: 'sessions' },
  { repositoryId: '1314116350', repositoryName: 'mail' },
  { repositoryId: '1314093835', repositoryName: 'identity' },
  { repositoryId: '1313927900', repositoryName: 'rate-limit' },
  { repositoryId: '1314239450', repositoryName: 'logger-adapters' },
  { repositoryId: '1314421283', repositoryName: 'health' },
  { repositoryId: '1313936481', repositoryName: 'pegma.dev' },
];

/** Repositories shown on the Stack page (catalog minus the site repo). */
export function stackReleaseCatalog(): readonly ReleaseCatalogEntry[] {
  return RELEASE_CATALOG.filter((entry) => entry.repositoryName !== 'pegma.dev');
}

/**
 * Intersect the display catalog with the runtime allowlist, preserving
 * catalog order. Unknown allowlist IDs never appear in the public response.
 */
export function allowedReleaseCatalog(
  allowedRepositoryIds: ReadonlySet<string>,
): readonly ReleaseCatalogEntry[] {
  return RELEASE_CATALOG.filter((entry) =>
    allowedRepositoryIds.has(entry.repositoryId),
  );
}
