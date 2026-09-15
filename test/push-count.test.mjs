import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { baselineRepos, getReposDiffStats } from '../dist/git.js';
import { renderEndcard, stripAnsi } from '../dist/render.js';

function sh(cmd, cwd) {
  execSync(cmd, { cwd, stdio: 'pipe' });
}

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'vibe-push-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function commit(cwd, msg) {
  sh(`git -c user.email=vibe@test -c user.name=vibe commit -q --allow-empty -m ${msg}`, cwd);
}

// A repo with a real bare remote on disk, already sharing one commit with it —
// the state any clone starts in. push.negotiate is off because some git builds
// fail the negotiation against a local bare remote and warn on stderr.
function repoWithRemote(parent, name) {
  sh(`git init -q --bare ${name}-remote.git`, parent);
  sh(`git init -qb main ${name}`, parent);
  const path = join(parent, name);
  commit(path, 'init');
  sh(`git remote add origin ${join(parent, `${name}-remote.git`)}`, path);
  push(path, 'HEAD');
  return path;
}

function push(repo, rev) {
  sh(`git -c push.negotiate=false push -q origin ${rev}:refs/heads/main`, repo);
  // A push updates refs/remotes/origin/main by itself; an explicit-refspec push
  // of an older rev does not, so refresh the tracking ref the way a fetch would.
  sh('git fetch -q origin', repo);
}

function work(repo, n) {
  for (let i = 0; i < n; i++) {
    writeFileSync(join(repo, `f${i}.txt`), `line ${i}\n`);
    sh(`git add f${i}.txt`, repo);
    commit(repo, `c${i}`);
  }
}

test('push counting is off unless asked for', (t) => {
  const repo = repoWithRemote(scratch(t), 'repo');
  const baseline = baselineRepos(repo);
  work(repo, 2);

  const stats = getReposDiffStats(baseline);
  assert.equal(stats.commits, 2);
  assert.equal('pushedCommits' in stats, false);
});

test('commits that never left the machine count as none pushed', (t) => {
  const repo = repoWithRemote(scratch(t), 'repo');
  const baseline = baselineRepos(repo);
  work(repo, 3);

  const stats = getReposDiffStats(baseline, true);
  assert.equal(stats.commits, 3);
  assert.equal(stats.pushedCommits, 0);
});

test('a push counts every commit it carried', (t) => {
  const repo = repoWithRemote(scratch(t), 'repo');
  const baseline = baselineRepos(repo);
  work(repo, 3);
  push(repo, 'HEAD');

  const stats = getReposDiffStats(baseline, true);
  assert.equal(stats.commits, 3);
  assert.equal(stats.pushedCommits, 3);
});

test('a partial push counts only what went out', (t) => {
  const repo = repoWithRemote(scratch(t), 'repo');
  const baseline = baselineRepos(repo);
  work(repo, 3);
  push(repo, 'HEAD~1');

  const stats = getReposDiffStats(baseline, true);
  assert.equal(stats.commits, 3);
  assert.equal(stats.pushedCommits, 2);

  // and the tail lands on the next push
  push(repo, 'HEAD');
  assert.equal(getReposDiffStats(baseline, true).pushedCommits, 3);
});

test('uncommitted work is not pushable and never inflates the count', (t) => {
  const repo = repoWithRemote(scratch(t), 'repo');
  const baseline = baselineRepos(repo);
  work(repo, 1);
  push(repo, 'HEAD');
  // edits on top of the pushed commit: they move the line counts, and they
  // must not move the pushed count in either direction
  writeFileSync(join(repo, 'f0.txt'), 'line 0\nand more\n');

  const stats = getReposDiffStats(baseline, true);
  assert.equal(stats.commits, 1);
  assert.equal(stats.pushedCommits, 1);
  assert.equal(stats.linesAdded, 2);
});

test('a repo with no remote reports nothing pushed, not a failure', (t) => {
  const dir = scratch(t);
  sh('git init -qb main local', dir);
  const repo = join(dir, 'local');
  commit(repo, 'init');
  const baseline = baselineRepos(repo);
  work(repo, 2);

  const stats = getReposDiffStats(baseline, true);
  assert.equal(stats.commits, 2);
  assert.equal(stats.pushedCommits, 0);
});

test('a session across two repos sums what each one pushed', (t) => {
  const dir = scratch(t);
  const a = repoWithRemote(dir, 'a');
  const b = repoWithRemote(dir, 'b');
  const baseline = baselineRepos(dir);
  assert.equal(baseline.length, 2);

  work(a, 2);
  push(a, 'HEAD');
  work(b, 3);
  push(b, 'HEAD~2');

  const stats = getReposDiffStats(baseline, true);
  assert.equal(stats.commits, 5);
  assert.equal(stats.pushedCommits, 3);
});

test('a commit pushed from a linked worktree counts', (t) => {
  const dir = scratch(t);
  const repo = repoWithRemote(dir, 'repo');
  sh(`git worktree add -q ${join(dir, 'wt')} -b feat`, repo);
  const baseline = baselineRepos(repo);

  const wt = join(dir, 'wt');
  work(wt, 1);
  sh('git -c push.negotiate=false push -q origin feat:refs/heads/feat', wt);

  const stats = getReposDiffStats(baseline, true);
  assert.equal(stats.commits, 1);
  assert.equal(stats.pushedCommits, 1);
});

test('the endcard shows the count only when there is one to show', () => {
  const base = {
    id: 'x', tool: 'claude', project: 'api', branch: 'main',
    startedAt: '', endedAt: '', durationSeconds: 600,
    commits: 3, linesAdded: 80, linesRemoved: 10, filesTouched: 4,
    momentum: 'shipped', exitCode: 0,
  };

  assert.match(stripAnsi(renderEndcard({ ...base, pushedCommits: 2 })), /2 of 3 pushed/);
  // counting off
  assert.doesNotMatch(stripAnsi(renderEndcard(base)), /pushed/);
  // counting on, nothing committed: nothing to say
  assert.doesNotMatch(stripAnsi(renderEndcard({ ...base, commits: 0, pushedCommits: 0 })), /pushed/);
});

test('the endcard keeps its width with the pushed row in it', () => {
  const card = renderEndcard({
    id: 'x', tool: 'claude', project: 'api', branch: 'main',
    startedAt: '', endedAt: '', durationSeconds: 8040,
    commits: 12, linesAdded: 8470, linesRemoved: 2310, filesTouched: 120,
    momentum: 'shipped', exitCode: 0, pushedCommits: 11,
  });
  const widths = new Set(
    stripAnsi(card).split('\n').filter(Boolean).map((line) => [...line].length)
  );
  assert.equal(widths.size, 1, `ragged card: widths ${[...widths].join(', ')}`);
});
