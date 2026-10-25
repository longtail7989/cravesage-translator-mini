#!/usr/bin/env node
// Offline: no game account, provider, browser profile or installed extension access.
import {spawnSync} from 'node:child_process';
import {readdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const sources = readdirSync(root).filter(name => /\.(?:mjs|js)$/.test(name));
for (const file of sources) {
  const result = spawnSync(process.execPath, ['--check', path.join(root, file)], {stdio: 'inherit', timeout: 30000});
  if (result.error || result.status !== 0) process.exit(1);
}
const tests = readdirSync(path.join(root, 'tests')).filter(name => /\.test\.(?:mjs|cjs)$/.test(name)).sort();
if (!tests.length) throw Error('No offline regression suites found');
const result = spawnSync(process.execPath, ['--test', ...tests.map(name => path.join(root, 'tests', name))], {
  cwd: root, stdio: 'inherit', timeout: 120000
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
