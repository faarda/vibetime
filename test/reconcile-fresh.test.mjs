import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Its own file on purpose: the hook modules freeze their config paths from HOME
// at import time, so a never-installed machine can only be tested in a process
// whose HOME was scratch before the first import.
const home = mkdtempSync(join(tmpdir(), 'vibe-never-installed-'));
process.env.HOME = home;
process.env.VIBE_DIR = join(home, '.vibe');
process.env.CODEX_HOME = join(home, '.codex');
process.env.SHELL = '/bin/zsh';
delete process.env.VIBE_SESSION;

const { reconcileInstall } = await import('../dist/reconcile.js');

test('a machine that never installed vibetime is left completely alone', () => {
  writeFileSync(join(home, '.zshrc'), '# just my rc\n');

  reconcileInstall();

  assert.equal(readFileSync(join(home, '.zshrc'), 'utf-8'), '# just my rc\n', 'rc must not be written to');
  assert.equal(existsSync(join(home, '.claude', 'settings.json')), false, 'no claude hooks');
  assert.equal(existsSync(join(home, '.codex', 'hooks.json')), false, 'no codex hooks');
  assert.equal(existsSync(join(home, '.cursor', 'hooks.json')), false, 'no cursor hooks');
});
