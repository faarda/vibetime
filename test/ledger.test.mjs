import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

// Set before any dist module loads: config.js bakes VIBE_DIR at import time.
process.env.VIBE_DIR = mkdtempSync(join(tmpdir(), 'vibe-home-'));

const { commitsToday, commitsBetween, knownRepos, startOfLocalDay } = await import('../dist/ledger.js');
const { readConfig, writeConfig } = await import('../dist/config.js');
const { addSession } = await import('../dist/db.js');
const { baselineRepos } = await import('../dist/git.js');

const ME = 'me@example.com';
const DAY_MS = 24 * 60 * 60 * 1000;

function sh(cmd, cwd, env) {
  execSync(cmd, { cwd, stdio: 'pipe', env: { ...process.env, ...env } });
}

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'vibe-ledger-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function initRepo(parent, name, email = ME) {
  mkdirSync(parent, { recursive: true });
  sh(`git init -qb main ${name}`, parent);
  const path = join(parent, name);
  sh(`git config user.email ${email}`, path);
  sh('git config user.name me', path);
  return path;
}

// One commit, optionally attributed to someone else or backdated.
function commit(repo, msg, { email = ME, authorDate, commitDate } = {}) {
  writeFileSync(join(repo, `${msg}.txt`), `${msg}\n`);
  sh(`git add ${msg}.txt`, repo);
  const date = authorDate ? ` --date=${authorDate}` : '';
  sh(
    `git -c user.email=${email} -c user.name=someone commit -q${date} -m ${msg}`,
    repo,
    commitDate ? { GIT_COMMITTER_DATE: commitDate } : undefined,
  );
}

function setRoots(roots) {
  writeConfig({ ...readConfig(), repoRoots: roots });
}

function reset() {
  writeFileSync(join(process.env.VIBE_DIR, 'sessions.json'), JSON.stringify({ sessions: [] }));
  setRoots([]);
}

test('commits are counted with no session ever recorded', (t) => {
  reset();
  const dir = scratch(t);
  // the layout that produces no session at all: repos two levels down
  const api = initRepo(join(dir, 'dev', 'group'), 'api');
  const web = initRepo(join(dir, 'dev', 'group'), 'web');
  commit(api, 'one');
  commit(api, 'two');
  commit(web, 'three');
  setRoots([join(dir, 'dev')]);

  const ledger = commitsToday();
  assert.equal(ledger.total, 3);
  assert.deepEqual(ledger.repos.map((r) => [r.name, r.commits]), [['api', 2], ['web', 1]]);
});

test('only your own commits count, and a longer email is not you', (t) => {
  reset();
  const dir = scratch(t);
  const repo = initRepo(dir, 'repo');
  commit(repo, 'mine');
  commit(repo, 'theirs', { email: 'colleague@example.com' });
  // the substring trap: notme@example.com contains me@example.com
  commit(repo, 'nearly', { email: `not${ME}` });
  setRoots([dir]);

  assert.equal(commitsToday().total, 1);
});

test('a commit on a branch that was never checked out still counts', (t) => {
  reset();
  const dir = scratch(t);
  const repo = initRepo(dir, 'repo');
  commit(repo, 'base');
  sh('git checkout -qb side', repo);
  commit(repo, 'onside');
  sh('git checkout -q main', repo);
  setRoots([dir]);

  assert.equal(commitsToday().total, 2);
});

test("yesterday's work is not today's, even when rebased today", (t) => {
  reset();
  const dir = scratch(t);
  const repo = initRepo(dir, 'repo');
  const yesterday = new Date(startOfLocalDay() - 6 * 60 * 60 * 1000).toISOString();

  // authored yesterday, committed just now — what a rebase leaves behind
  commit(repo, 'old', { authorDate: yesterday });
  commit(repo, 'new');
  setRoots([dir]);

  assert.equal(commitsToday().total, 1);
  // widen the window and the older one comes back
  assert.equal(commitsBetween(startOfLocalDay() - DAY_MS, startOfLocalDay() + DAY_MS).total, 2);
});

test('a repo known from both a session and a root is counted once', async (t) => {
  reset();
  const dir = scratch(t);
  const repo = initRepo(dir, 'repo');
  commit(repo, 'one');
  commit(repo, 'two');

  await addSession({
    id: randomUUID(), tool: 'cursor', project: 'repo', branch: 'main',
    startedAt: new Date().toISOString(), endedAt: new Date().toISOString(),
    durationSeconds: 120, commits: 2, linesAdded: 2, linesRemoved: 0, filesTouched: 2,
    momentum: 'progressed', exitCode: 0, repos: baselineRepos(repo),
  });
  setRoots([dir]);

  assert.equal(knownRepos().length, 1);
  assert.equal(commitsToday().total, 2);
});

test('repos a session already knows are counted with no root registered', async (t) => {
  reset();
  const dir = scratch(t);
  const repo = initRepo(dir, 'repo');
  commit(repo, 'one');

  await addSession({
    id: randomUUID(), tool: 'cursor', project: 'repo', branch: 'main',
    startedAt: new Date().toISOString(), endedAt: new Date().toISOString(),
    durationSeconds: 120, commits: 1, linesAdded: 1, linesRemoved: 0, filesTouched: 1,
    momentum: 'progressed', exitCode: 0, repos: baselineRepos(repo),
  });

  assert.equal(commitsToday().total, 1);
});

test('an address you declared yours is counted too', (t) => {
  reset();
  const dir = scratch(t);
  const repo = initRepo(dir, 'repo');
  commit(repo, 'mine');
  commit(repo, 'work', { email: 'me@company.com' });
  setRoots([dir]);

  assert.equal(commitsToday().total, 1);
  writeConfig({ ...readConfig(), authorEmails: ['me@company.com'] });
  assert.equal(commitsToday().total, 2);
});

test('commits that are not yours are named, so you can see why', (t) => {
  reset();
  const dir = scratch(t);
  const repo = initRepo(dir, 'repo');
  commit(repo, 'mine');
  commit(repo, 'theirs', { email: 'colleague@example.com' });
  commit(repo, 'alsotheirs', { email: 'colleague@example.com' });
  setRoots([dir]);

  const plain = commitsToday();
  assert.equal(plain.others, undefined); // not paid for unless asked

  const explained = commitsToday({ explain: true });
  assert.equal(explained.total, 1);
  assert.deepEqual(explained.others, [{ email: 'colleague@example.com', commits: 2 }]);
});

test('nothing registered and nothing committed reads as nothing, not an error', () => {
  reset();
  const ledger = commitsToday();
  assert.equal(ledger.total, 0);
  assert.equal(ledger.reposKnown, 0);
  assert.deepEqual(ledger.repos, []);
});

test('a root that no longer exists is skipped', (t) => {
  reset();
  const dir = scratch(t);
  const repo = initRepo(dir, 'repo');
  commit(repo, 'one');
  setRoots([dir, join(dir, 'deleted-long-ago')]);

  assert.equal(commitsToday().total, 1);
});
