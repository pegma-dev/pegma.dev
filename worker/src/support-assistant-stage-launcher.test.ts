import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const execute = promisify(execFile);
const repository = fileURLToPath(new URL('../../', import.meta.url));
const launcher = join(repository, 'scripts', 'seed-support-assistant-stage.mts');
const tsx = fileURLToPath(import.meta.resolve('tsx/cli'));
const directoryPrefix = 'pegma-assistant-launcher-test-';
let directory: string | undefined;

afterEach(async () => {
  if (directory === undefined) return;
  const target = resolve(directory);
  if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith(directoryPrefix))
    throw new Error('Refusing cleanup outside the generated launcher test directory.');
  await rm(target, { recursive: true, force: true });
  directory = undefined;
});

describe('actual local support assistant stage launcher', () => {
  it('writes the SDK seed and scenario to local persistence and refuses to replace an existing output', async () => {
    directory = await mkdtemp(join(tmpdir(), directoryPrefix));
    const outputDirectory = join(directory, 'seed');
    const arguments_ = [tsx, launcher, '--output-dir', outputDirectory];
    const run = () =>
      execute(process.execPath, arguments_, {
        cwd: repository,
        timeout: 45_000,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
      });

    await run();

    const resultPath = join(outputDirectory, 'seed-result.json');
    const resultBytes = await readFile(resultPath, 'utf8');
    const result = JSON.parse(resultBytes);
    const scenario = JSON.parse(await readFile(join(outputDirectory, 'scenario.json'), 'utf8'));
    const configPath = join(outputDirectory, 'wrangler.seed.json');
    const configBytes = await readFile(configPath, 'utf8');
    const config = JSON.parse(configBytes);
    const schemaBytes = await readFile(
      join(repository, 'worker', 'migrations', '0001_pegma_storage.sql'),
    );

    expect(result).toMatchObject({
      schemaVersion: 1,
      outcome: 'local-synthetic-seed',
      configPath,
      statePath: join(outputDirectory, '.wrangler', 'state', 'v3'),
      schemaSha256: createHash('sha256').update(schemaBytes).digest('hex'),
      scenario,
      articleId: 'fictional-workspace-export',
      ticketId: 'fictional-answer-ticket',
    });
    expect(Number.isSafeInteger(result.rows)).toBe(true);
    expect(result.rows).toBeGreaterThan(0);
    expect(scenario).toMatchObject({ version: 1, scenarioId: expect.any(String) });
    expect(Date.parse(scenario.validUntil) - Date.parse(scenario.issuedAt)).toBe(3_600_000);
    expect(config).toMatchObject({
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
    });
    const stateFiles = await readdir(result.statePath, { recursive: true });
    expect(stateFiles.some((path) => path.endsWith('.sqlite'))).toBe(true);

    await expect(run()).rejects.toMatchObject({ code: 1 });
    expect(await readFile(resultPath, 'utf8')).toBe(resultBytes);
    expect(await readFile(configPath, 'utf8')).toBe(configBytes);
  }, 60_000);
});
