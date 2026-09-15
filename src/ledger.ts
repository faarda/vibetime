import { existsSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { getSessions } from './db.js';
import { readConfig } from './config.js';
import {
  commitsAuthoredBetween,
  dedupeByRepo,
  discoverReposUnder,
  getAuthorEmail,
  otherAuthorsBetween,
} from './git.js';

// The commit ledger: what you committed on a given day, read out of git itself.
//
// Every other number in vibetime is a session measurement — a baseline taken
// when a session opened, and the delta from it. That is the better number when
// a session was captured, because it knows which work belonged to which sitting.
// But it is only as good as the capture: an editor whose hooks don't fire, a
// workspace layout nothing recognised, a session that never ended. When that
// happens the work is not mis-measured, it is absent.
//
// This is the fallback. It asks git directly, needs no session to have existed,
// and cannot double count, because it counts distinct commits rather than
// adding session totals together.

export interface RepoCommits {
  path: string;
  name: string;
  commits: number;
}

export interface CommitTotals {
  total: number;
  repos: RepoCommits[];
  // How many repos were known and how many were actually asked — the rest were
  // untouched in the window (see touchedSince) and could hold nothing new.
  reposKnown: number;
  reposRead: number;
  // Commits found in those repos that aren't attributed to you, by address.
  // Only filled in when explicitly asked for (`vibe commits`): it costs a
  // second pass over the log, and it exists to answer "where did my work go".
  others?: { email: string; commits: number }[];
}

export function startOfLocalDay(date = new Date()): number {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function dayCount(days: number, from = new Date()): { fromMs: number; toMs: number } {
  const end = startOfLocalDay(from) + 24 * 60 * 60 * 1000;
  return { fromMs: end - Math.max(days, 1) * 24 * 60 * 60 * 1000, toMs: end };
}

// Every repo the ledger can look in: the ones sessions have already watched,
// plus everything under the roots the user registered. Session history alone
// isn't enough — the layouts most likely to go uncounted are exactly the ones
// that never produced a session to remember them by.
export function knownRepos(): string[] {
  const config = readConfig();

  const fromSessions = getSessions()
    .flatMap((s) => s.repos?.map((r) => r.path) ?? [])
    .filter((path) => existsSync(join(path, '.git')));

  const fromRoots = (config.repoRoots ?? []).flatMap((root) =>
    existsSync(root) ? discoverReposUnder(root) : []
  );

  return dedupeByRepo([...new Set([...fromRoots, ...fromSessions])]);
}

// Could this repo hold a commit made since `sinceMs`? Committing appends to the
// reflog and writes a ref, so a repo whose git directory has not been touched
// since then has nothing to find — and skipping it saves two git spawns.
//
// Deliberately biased towards reading: anything unreadable, unusual, or simply
// unknown (a linked worktree, whose .git is a file that a commit need not
// touch) answers yes. Under-counting is the bug this whole module exists to
// fix, so a wasted git call is always the better mistake.
function touchedSince(repoPath: string, sinceMs: number): boolean {
  const gitPath = join(repoPath, '.git');
  try {
    if (!statSync(gitPath).isDirectory()) return true;
  } catch {
    return true;
  }

  let newest = 0;
  for (const candidate of [gitPath, join(gitPath, 'logs', 'HEAD'), join(gitPath, 'refs'), join(gitPath, 'packed-refs')]) {
    try {
      newest = Math.max(newest, statSync(candidate).mtimeMs);
    } catch {}
  }
  return newest === 0 || newest >= sinceMs;
}

// Who counts as you in a given repo: whatever email git would stamp on a
// commit made there, plus any address you have told vibe is also yours. The
// per-repo value is what makes a work checkout and a personal one each count
// correctly without any configuration at all.
function identitiesFor(repoPath: string, extra: string[]): string[] {
  const own = getAuthorEmail(repoPath);
  return [...new Set([own, ...extra].filter(Boolean).map((e) => e.toLowerCase()))];
}

interface Options {
  repos?: string[];
  // Also report commits that aren't yours. Costs a second log pass per repo.
  explain?: boolean;
}

// Distinct commits you authored in [fromMs, toMs), per repo. Nobody else's
// commits — a colleague's, or anything a fetch dragged in — are ever yours.
export function commitsBetween(fromMs: number, toMs: number, options: Options = {}): CommitTotals {
  const repos = options.repos ?? knownRepos();
  const extra = readConfig().authorEmails ?? [];
  const counted: RepoCommits[] = [];
  const others = new Map<string, number>();
  let total = 0;
  let reposRead = 0;

  for (const path of repos) {
    if (!touchedSince(path, fromMs)) continue;
    reposRead++;

    const mine = identitiesFor(path, extra);
    if (mine.length === 0) continue; // git itself could not commit here

    const commits = commitsAuthoredBetween(path, mine, fromMs, toMs);
    if (commits.length > 0) {
      total += commits.length;
      counted.push({ path, name: basename(path), commits: commits.length });
    }

    if (options.explain) {
      for (const { email, commits: n } of otherAuthorsBetween(path, mine, fromMs, toMs)) {
        others.set(email, (others.get(email) ?? 0) + n);
      }
    }
  }

  counted.sort((a, b) => b.commits - a.commits || a.name.localeCompare(b.name));
  return {
    total,
    repos: counted,
    reposKnown: repos.length,
    reposRead,
    ...(options.explain
      ? {
          others: [...others.entries()]
            .map(([email, commits]) => ({ email, commits }))
            .sort((a, b) => b.commits - a.commits),
        }
      : {}),
  };
}

export function commitsToday(options: Options = {}): CommitTotals {
  const start = startOfLocalDay();
  return commitsBetween(start, start + 24 * 60 * 60 * 1000, options);
}
