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

// Stats can shrink after events were credited (grace-window rescore, worktree
// dedupe, a repo that moved). A baseline left above current stats would block
// every future event, so it clamps down field by field — same as the CLI.
export function clampBaseline(baseline: Stats, stats: Stats): Stats {
  return {
    commits: Math.min(baseline.commits, stats.commits),
    linesAdded: Math.min(baseline.linesAdded, stats.linesAdded),
    linesRemoved: Math.min(baseline.linesRemoved, stats.linesRemoved),
    filesTouched: Math.min(baseline.filesTouched, stats.filesTouched),
  };
}

// Does the work done SINCE THE LAST CREDITED EVENT earn `newDays` more events?
//
// This is the server's copy of the CLI's trackShipEvents gate, and the reason
// it exists: the day list arrives from the client, and until now nothing here
// checked it. Cumulative stats always qualify once they ever did, so a second
// day has to be paid for with the second day's work.
//
// One submission can legitimately carry several new days (a laptop offline
// over a weekend flushes them together), and the server only ever sees the
// total delta, not each day's share of it. Commits are additive so they scale
// honestly; lines and files are checked once against the aggregate. That makes
// a multi-day catch-up the one case the server grades more loosely than the
// CLI did — deliberately, because the alternative is discarding real work.
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
