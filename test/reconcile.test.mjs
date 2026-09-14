import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// VIBE_DIR and HOME are read at module load, so both point at scratch before
// the first dist import. Nothing here may touch the real machine.
const home = mkdtempSync(join(tmpdir(), 'vibe-reconcile-home-'));
process.env.HOME = home;
process.env.VIBE_DIR = join(home, '.vibe');
process.env.CODEX_HOME = join(home, '.codex');
process.env.SHELL = '/bin/zsh';
delete process.env.VIBE_SESSION;

const { reconcileInstall } = await import('../dist/reconcile.js');
const { readConfig, writeConfig, setInstallOptOut, removeTool } = await import('../dist/config.js');
const { DEFAULT_TOOLS } = await import('../dist/init.js');

const rc = join(home, '.zshrc');
const claudeSettings = join(home, '.claude', 'settings.json');
const codexHooks = join(home, '.codex', 'hooks.json');
const cursorHooks = join(home, '.cursor', 'hooks.json');

// An install from an older release: the marker and the tools that existed then,
// no cursor hooks, no aster. Exactly what everyone who ran `vibe init` before
// v0.9.0 still has on disk today.
function seedOldInstall() {
  writeFileSync(rc, [
    '# my rc',
    '',
    '# vibetime hooks',
    'claude() { vibe __wrap claude "$@"; }',
    'codex() { vibe __wrap codex "$@"; }',
    'gemini() { vibe __wrap gemini "$@"; }',
    '',
  ].join('\n'));
  writeConfig({ thresholdLines: 50, thresholdFiles: 3 });
}

function rcHas(tool) {
  return readFileSync(rc, 'utf-8').includes(`vibe __wrap ${tool} `);
}

test('an old install picks up tools and apps added since, with no commands run', () => {
  seedOldInstall();
  assert.equal(rcHas('aster'), false, 'precondition: the old install has no aster');
  assert.equal(existsSync(cursorHooks), false, 'precondition: no cursor hooks');

  reconcileInstall();

  for (const tool of DEFAULT_TOOLS) {
    assert.ok(rcHas(tool), `${tool} should be wrapped after repair`);
  }
  assert.ok(existsSync(claudeSettings), 'claude hooks installed');
  assert.ok(existsSync(codexHooks), 'codex hooks installed');
  assert.ok(existsSync(cursorHooks), 'cursor hooks installed');
});

test('repair is idempotent: a second pass changes nothing', () => {
  const before = readFileSync(rc, 'utf-8');
  const beforeCursor = readFileSync(cursorHooks, 'utf-8');
  reconcileInstall();
  assert.equal(readFileSync(rc, 'utf-8'), before);
  assert.equal(readFileSync(cursorHooks, 'utf-8'), beforeCursor);
});

test('a removed tool stays removed', () => {
  seedOldInstall();
  reconcileInstall();
  assert.ok(rcHas('aster'));

  removeTool('aster');
  assert.equal(rcHas('aster'), false);
  assert.ok(readConfig().removedTools.includes('aster'));

  reconcileInstall();
  assert.equal(rcHas('aster'), false, 'repair must not undo a deliberate removal');
  assert.ok(rcHas('claude'), 'other tools are untouched');
});

test('uninstall stays uninstalled', () => {
  seedOldInstall();
  reconcileInstall();

  // what `vibe uninstall` records before stripping the hooks
  setInstallOptOut({ shell: true, desktop: true });
  writeFileSync(rc, '# my rc\n');
  mkdirSync(join(home, '.cursor'), { recursive: true });
  writeFileSync(cursorHooks, '{"version":1}\n');

  reconcileInstall();

  assert.equal(readFileSync(rc, 'utf-8'), '# my rc\n', 'shell hooks must not come back');
  assert.equal(readFileSync(cursorHooks, 'utf-8'), '{"version":1}\n', 'desktop hooks must not come back');
});

test('re-installing clears the opt-out so repair resumes', () => {
  setInstallOptOut({ shell: false, desktop: false });
  seedOldInstall();
  reconcileInstall();
  assert.ok(rcHas('aster'));
});
