import { readFileSync, writeFileSync } from 'node:fs';

const file = new URL('../worker/worker-configuration.d.ts', import.meta.url);
const bytes = readFileSync(file);
const original = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
const normalized = original.replace(/\t/gu, '  ');
if (/[\u0000-\u0009\u000B\u000C\u000E-\u001F\u007F]/u.test(normalized)) {
  throw new Error('Generated Worker types contain unsafe control characters.');
}
if (normalized !== original) writeFileSync(file, normalized, 'utf8');
