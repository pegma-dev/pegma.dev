/// <reference path="../worker/worker-configuration.d.ts" />

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { systemClock } from '@pegma/spine';
import { createSupportAssistantStageScenario } from '../worker/src/support-assistant-stage-scenario';
import { seedSupportAssistantStage } from '../worker/src/support-assistant-stage-seed';

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--output-dir' || !args[1])
  throw new Error('Expected --output-dir followed by a new local output directory.');
const outputDirectory = resolve(args[1]);
// Exclusive creation refuses existing state. No recursive cleanup is performed.
await mkdir(outputDirectory);
const configPath = join(outputDirectory, 'wrangler.seed.json');
const statePath = join(outputDirectory, '.wrangler', 'state', 'v3');
const config = {
  name: 'pegma-local-support-assistant-seed',
  compatibility_date: '2026-07-28',
  compatibility_flags: ['nodejs_compat'],
  workers_dev: false,
  preview_urls: false,
  routes: [],
  triggers: { crons: [] },
  d1_databases: [
    {
      binding: 'ASSISTANT_STAGE_DB',
      database_name: 'pegma-local-support-assistant-seed',
      database_id: '00000000-0000-0000-0000-000000000000',
      remote: false,
    },
  ],
};
await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', { flag: 'wx' });
const schemaPath = fileURLToPath(
  new URL('../worker/migrations/0001_pegma_storage.sql', import.meta.url),
);
const schemaBytes = await readFile(schemaPath);
const schemaSha256 = createHash('sha256').update(schemaBytes).digest('hex');
if (schemaSha256 !== '3f820cb7c1f8e76196e83f8bc8448dd9e72e840884fc39641c84e6b9d60ff27f')
  throw new Error('Synthetic seed requires the reviewed D1 migration bytes.');
// Exact hash above bounds this to the migration's two tables and three triggers.
const statements = schemaBytes
  .toString('utf8')
  .trim()
  .split(/\r?\n\s*\r?\n/u);
if (statements.length !== 5) throw new Error('Synthetic seed migration statement count changed.');
process.env.WRANGLER_SEND_METRICS = 'false';
const { getPlatformProxy } = await import('wrangler');
const proxy = await getPlatformProxy<{ ASSISTANT_STAGE_DB: D1Database }>({
  configPath,
  remoteBindings: false,
  envFiles: [],
  persist: { path: statePath },
});
try {
  const database = proxy.env.ASSISTANT_STAGE_DB;
  for (const statement of statements) await database.prepare(statement).run();
  const scenario = createSupportAssistantStageScenario(systemClock);
  const seed = await seedSupportAssistantStage(database, scenario, systemClock);
  const rows = await database
    .prepare('SELECT COUNT(*) AS count FROM RECORDS')
    .first<{ count: number }>();
  if (rows === null || !Number.isSafeInteger(rows.count) || rows.count < 1)
    throw new Error('Synthetic SDK setup did not persist rows.');
  await writeFile(
    join(outputDirectory, 'scenario.json'),
    JSON.stringify(scenario, null, 2) + '\n',
    { flag: 'wx' },
  );
  await writeFile(
    join(outputDirectory, 'seed-result.json'),
    JSON.stringify(
      {
        schemaVersion: 1,
        outcome: 'local-synthetic-seed',
        configPath,
        statePath,
        schemaSha256,
        rows: rows.count,
        scenario: seed.scenario,
        articleId: seed.articleId,
        ticketId: seed.ticketId,
      },
      null,
      2,
    ) + '\n',
    { flag: 'wx' },
  );
  // Only fictional scenario metadata and local paths appear in this output.
  console.info(
    JSON.stringify({
      outcome: 'local-synthetic-seed',
      outputDirectory,
      rows: rows.count,
    }),
  );
} finally {
  await proxy.dispose();
}
