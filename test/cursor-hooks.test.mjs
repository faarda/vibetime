import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const {
  installCursorHooks,
  mergeCursorHooks,
  stripCursorHooks,
} = await import('../dist/cursor-hooks.js');

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'vibe-cursor-hooks-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function otherHook(command = './hooks/format.sh') {
  return { command, timeout: 5 };
}

const CURSOR_EVENTS = ['sessionStart', 'beforeSubmitPrompt', 'postToolUse', 'stop', 'sessionEnd'];

test('Cursor hooks merge non-destructively and are idempotent', () => {
  const unrelated = otherHook();
  const config = {
    version: 1,
    description: 'keep me',
    hooks: {
      stop: [unrelated],
      beforeShellExecution: [otherHook('./hooks/approve.sh')],
    },
  };

  const first = mergeCursorHooks(config);
  assert.equal(first.added, 5);
  assert.equal(first.existing, 0);
  assert.equal(first.config.version, 1);
  assert.equal(first.config.description, 'keep me');
  assert.equal(first.config.hooks.stop[0], unrelated);
  assert.equal(first.config.hooks.beforeShellExecution.length, 1);

  const vibeByEvent = Object.fromEntries(
    CURSOR_EVENTS.map((event) => [
      event,
      first.config.hooks[event].find((hook) => hook.command.includes('--tool cursor')),
    ]),
  );

  assert.match(vibeByEvent.sessionStart.command, /__hook session-start --tool cursor --respond-json$/);
  assert.match(vibeByEvent.beforeSubmitPrompt.command, /__hook activity --tool cursor --respond-json$/);
  assert.match(vibeByEvent.postToolUse.command, /__hook activity --tool cursor --respond-json$/);
  assert.match(vibeByEvent.stop.command, /__hook activity --tool cursor --respond-json$/);
  assert.match(vibeByEvent.sessionEnd.command, /__hook session-end --tool cursor --respond-json$/);
  assert.equal(vibeByEvent.sessionEnd.timeout, 10);
  assert.equal('matcher' in vibeByEvent.postToolUse, false);

  const second = mergeCursorHooks(first.config);
  assert.equal(second.added, 0);
  assert.equal(second.existing, 5);
  assert.equal(second.updated, 0);
});

test('reinstall refreshes stale commands without duplicating hooks', () => {
  const first = mergeCursorHooks({});
  const sessionStart = first.config.hooks.sessionStart.find((hook) =>
    hook.command.includes('--tool cursor'),
  );
  sessionStart.command = "'/old/node' '/old/vibe' __hook session-start --tool cursor --respond-json";

  const second = mergeCursorHooks(first.config);
  const vibeHooks = second.config.hooks.sessionStart.filter((hook) =>
    hook.command.includes('--tool cursor'),
  );

  assert.equal(second.added, 0);
  assert.equal(second.updated, 1);
  assert.equal(vibeHooks.length, 1);
  assert.doesNotMatch(vibeHooks[0].command, /old\/node/);
});

test('missing version is filled in on install', () => {
  const { config } = mergeCursorHooks({ hooks: { stop: [otherHook()] } });
  assert.equal(config.version, 1);
});

test('Cursor hook removal preserves unrelated hooks and top-level settings', () => {
  const config = mergeCursorHooks({
    version: 1,
    description: 'keep me',
    hooks: { stop: [otherHook()] },
  }).config;

  const { config: stripped, removed } = stripCursorHooks(config);
  assert.equal(removed, 5);
  assert.equal(stripped.version, 1);
  assert.equal(stripped.description, 'keep me');
  assert.deepEqual(stripped.hooks, { stop: [otherHook()] });
});

test('installer never clobbers an invalid hooks.json', (t) => {
  const path = join(scratch(t), 'hooks.json');
  writeFileSync(path, '{ definitely not json\n');

  const originalLog = console.log;
  console.log = () => {};
  try {
    installCursorHooks(path);
  } finally {
    console.log = originalLog;
  }

  assert.equal(readFileSync(path, 'utf8'), '{ definitely not json\n');
});

test('Cursor hooks return the required JSON response', () => {
  const cli = new URL('../dist/cli.js', import.meta.url);
  const result = spawnSync(process.execPath, [cli.pathname, '__hook', 'activity', '--tool', 'cursor', '--respond-json'], {
    input: '{}',
    encoding: 'utf8',
    env: { ...process.env, VIBE_SESSION: '1' },
  });

  assert.equal(result.status, 0);
  assert.equal(result.stdout, '{}\n');
  assert.equal(result.stderr, '');
});
