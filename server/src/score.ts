export type MomentumTier = 'shipped' | 'progressed' | 'tinkering' | 'exploring' | 'idle';

export interface Stats {
  commits: number;
  linesAdded: number;
  linesRemoved: number;
  filesTouched: number;
}

const THRESHOLD_LINES = 50;
const THRESHOLD_FILES = 3;

export function scoreSession(stats: Stats): MomentumTier {
  const hasCommit = stats.commits > 0;
  const linesNet = stats.linesAdded + stats.linesRemoved;
  const meaningful = linesNet > THRESHOLD_LINES || stats.filesTouched > THRESHOLD_FILES;

  if (hasCommit && meaningful) return 'shipped';
  if (hasCommit && !meaningful) return 'progressed';
  if (!hasCommit && meaningful) return 'tinkering';
  if (!hasCommit && linesNet > 0) return 'exploring';
  return 'idle';
}

// Stats can shrink after events were credited (rescore, worktree dedupe, a
// moved repo). A baseline stranded above them would block every future event.
export function clampBaseline(baseline: Stats, stats: Stats): Stats {
  return {
    commits: Math.min(baseline.commits, stats.commits),
    linesAdded: Math.min(baseline.linesAdded, stats.linesAdded),
    linesRemoved: Math.min(baseline.linesRemoved, stats.linesRemoved),
    filesTouched: Math.min(baseline.filesTouched, stats.filesTouched),
  };
}

// Does the work since the last credited event earn `newDays` more? Cumulative
// stats always qualify once they ever did, so each day is paid for separately.
//
// One submission can carry several new days (a laptop offline over a weekend),
// and only the total delta is visible here, never each day's share. Commits
// are additive so they scale; lines and files are checked once against the
// aggregate. That grades a multi-day catch-up more loosely than the CLI does,
// which beats discarding real work.
export function earnsEvents(baseline: Stats, stats: Stats, newDays: number): boolean {
  if (newDays < 1) return false;
  const base = clampBaseline(baseline, stats);
  const delta: Stats = {
    commits: stats.commits - base.commits,
    linesAdded: stats.linesAdded - base.linesAdded,
    linesRemoved: stats.linesRemoved - base.linesRemoved,
    filesTouched: stats.filesTouched - base.filesTouched,
  };
  return delta.commits >= newDays && scoreSession(delta) === 'shipped';
}
