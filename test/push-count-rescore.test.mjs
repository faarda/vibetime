import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

// Set before any dist module loads: config.js bakes VIBE_DIR at import time.
process.env.VIBE_DIR = mkdtempSync(join(tmpdir(), 'vibe-home-'));

const { getSessions, addSession, updateSession } = await import('../dist/db.js');
const { refreshRecentSessions } = await import('../dist/rescore.js');
const { baselineRepos } = await import('../dist/git.js');
const { readConfig, writeConfig } = await import('../dist/config.js');

function sh(cmd, cwd) {
  execSync(cmd, { cwd, stdio: 'pipe' });
}

function commit(cwd, msg) {
  sh(`git -c user.email=vibe@test -c user.name=vibe commit -q --allow-empty -m ${msg}`, cwd);
}

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'vibe-push-rescore-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function repoWithRemote(parent) {
  sh('git init -q --bare remote.git', parent);
  sh('git init -qb main work', parent);
  const path = join(parent, 'work');
  commit(path, 'init');
  sh(`git remote add origin ${join(parent, 'remote.git')}`, path);
  sh('git -c push.negotiate=false push -q origin HEAD:refs/heads/main', path);
  sh('git fetch -q origin', path);
  return path;
}

function countPushes(on) {
  writeConfig({ ...readConfig(), countPushes: on });
}

// An open session watching `repo`, already recorded as submitted, so a later
// refresh that clears submittedAt is visible.
async function openSession(repo) {
  const id = randomUUID();
  await addSession({
    id, tool: 'claude', project: 'work', branch: 'main',
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    durationSeconds: 120,
    commits: 0, linesAdded: 0, linesRemoved: 0, filesTouched: 0,
    momentum: 'idle', exitCode: -1,
    lastActivityAt: new Date().toISOString(),
    submittedAt: new Date().toISOString(),
    repos: baselineRepos(repo),
  });
  return id;
}

function find(id) {
  return getSessions().find((s) => s.id === id);
}

test('a push after the session was last measured is picked up by the refresh', async (t) => {
  const repo = repoWithRemote(scratch(t));
  countPushes(true);
  const id = await openSession(repo);

  writeFileSync(join(repo, 'f.txt'), 'one\ntwo\n');
  sh('git add f.txt', repo);
  commit(repo, 'work');
  await refreshRecentSessions();
  assert.equal(find(id).commits, 1);
  assert.equal(find(id).pushedCommits, 0);

  // pushed after the fact — the count moves without any new commit
  sh('git -c push.negotiate=false push -q origin HEAD:refs/heads/main', repo);
  await updateSession(id, { submittedAt: new Date().toISOString() });
  await refreshRecentSessions();

  const after = find(id);
  assert.equal(after.pushedCommits, 1);
  assert.equal(after.commits, 1);
  // the corrected state has to reach the server again
  assert.equal(after.submittedAt, undefined);
});

test('with counting off, a count left over from before does not churn the session', async (t) => {
  const repo = repoWithRemote(scratch(t));
  countPushes(true);
  const id = await openSession(repo);

  writeFileSync(join(repo, 'f.txt'), 'one\n');
  sh('git add f.txt', repo);
  commit(repo, 'work');
  sh('git -c push.negotiate=false push -q origin HEAD:refs/heads/main', repo);
  await refreshRecentSessions();
  assert.equal(find(id).pushedCommits, 1);

  // Off again. The stale count stays on the row, and comparing it against a
  // no-longer-collected value must not read as "changed" on every pass —
  // that would rewrite and resubmit the session forever.
  countPushes(false);
  await updateSession(id, { submittedAt: new Date().toISOString() });
  await refreshRecentSessions();

  const after = find(id);
  assert.equal(after.pushedCommits, 1);
  assert.notEqual(after.submittedAt, undefined);
});
