import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { scoreSession, trackShipEvents } from '../dist/score.js';
import { DEFAULTS } from '../dist/config.js';

// The server package never emits JS — wrangler bundles straight from TS — so
// transpile its score module on the fly and import it as a data URI. The module
// is dependency-free, which is what makes this possible.
const serverSource = readFileSync(new URL('../server/src/score.ts', import.meta.url), 'utf-8');
const { outputText } = ts.transpileModule(serverSource, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
const server = await import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'));

// Values straddling both thresholds (lines > 50, files > 3), so a > drifting to
// >= — or a constant drifting on either side — fails a case at the boundary.
const COMMITS = [0, 1, 3];
const LINES_ADDED = [0, 1, 24, 49, 50, 51, 200];
const LINES_REMOVED = [0, 1, 26];
const FILES_TOUCHED = [0, 1, 3, 4, 10];

test('CLI and server score identically for every non-interrupted input', () => {
  for (const commits of COMMITS) {
    for (const linesAdded of LINES_ADDED) {
      for (const linesRemoved of LINES_REMOVED) {
        for (const filesTouched of FILES_TOUCHED) {
          const stats = { commits, linesAdded, linesRemoved, filesTouched };
          const cli = scoreSession({ ...stats, exitCode: 0 }, DEFAULTS);
          const remote = server.scoreSession(stats);
          assert.equal(cli, remote, `diverged on ${JSON.stringify(stats)}: cli=${cli} server=${remote}`);
        }
      }
    }
  }
});

// The ship-event rule is the one the leaderboard actually counts, and it lived
// in two implementations for a week without anything comparing them: the CLI
// delta-gated each day, the server took the list on trust and derived pre-0.8
// days from "did commits grow". That divergence is what this sweep exists to
// stop from happening a second time.
const NOW = Date.parse('2026-09-14T12:00:00Z');

test('CLI and server agree on whether a single new day is earned', () => {
  for (const commits of COMMITS) {
    for (const linesAdded of LINES_ADDED) {
      for (const linesRemoved of LINES_REMOVED) {
        for (const filesTouched of FILES_TOUCHED) {
          for (const baseCommits of [0, 1]) {
            const baseline = { commits: baseCommits, linesAdded: 0, linesRemoved: 0, filesTouched: 0 };
            const stats = { commits, linesAdded, linesRemoved, filesTouched };

            const cli = trackShipEvents({ eventBaseline: baseline }, stats, DEFAULTS, NOW);
            const cliEmitted = cli?.shipEvents?.includes('2026-09-14') ?? false;
            const remote = server.earnsEvents(baseline, stats, 1);

            assert.equal(cliEmitted, remote,
              `diverged on ${JSON.stringify({ baseline, stats })}: cli=${cliEmitted} server=${remote}`);
          }
        }
      }
    }
  }
});

test('an already-credited baseline blocks both, so day two must earn itself', () => {
  const shipped = { commits: 4, linesAdded: 400, linesRemoved: 20, filesTouched: 9 };
  // Baseline caught up to the stats: nothing new since the last event.
  assert.equal(server.earnsEvents(shipped, shipped, 1), false);
  assert.equal(trackShipEvents({ eventBaseline: shipped, shipEvents: [] }, shipped, DEFAULTS, NOW), null);

  // One more commit alone is not a shipping day. This is exactly the hole the
  // old legacy branch had: commits > priorCommits was the entire test.
  const oneMore = { ...shipped, commits: 5, linesAdded: 405 };
  assert.equal(server.earnsEvents(shipped, oneMore, 1), false);

  // Real work since the last event is.
  const realWork = { commits: 6, linesAdded: 600, linesRemoved: 40, filesTouched: 15 };
  assert.equal(server.earnsEvents(shipped, realWork, 1), true);
});

test('a shrunken stat clamps the baseline instead of freezing the session', () => {
  // Grace-window rescore and worktree dedupe can both pull stats down. A
  // baseline stranded above them would block every future event forever.
  const baseline = { commits: 10, linesAdded: 900, linesRemoved: 90, filesTouched: 30 };
  const shrunk = { commits: 8, linesAdded: 700, linesRemoved: 70, filesTouched: 20 };
  assert.deepEqual(server.clampBaseline(baseline, shrunk), shrunk);
  assert.equal(server.earnsEvents(baseline, shrunk, 1), false);

  const grown = { commits: 12, linesAdded: 1400, linesRemoved: 90, filesTouched: 35 };
  assert.equal(server.earnsEvents(baseline, grown, 1), true);
});

test('a multi-day catch-up needs a commit per day', () => {
  const baseline = { commits: 0, linesAdded: 0, linesRemoved: 0, filesTouched: 0 };
  const threeCommits = { commits: 3, linesAdded: 900, linesRemoved: 0, filesTouched: 12 };
  assert.equal(server.earnsEvents(baseline, threeCommits, 3), true);
  assert.equal(server.earnsEvents(baseline, threeCommits, 4), false, 'four days on three commits');
  assert.equal(server.earnsEvents(baseline, threeCommits, 0), false, 'no new days, no spend');
});

test('interrupted is the one deliberate divergence: CLI-only, from exitCode', () => {
  const stats = { commits: 5, linesAdded: 500, linesRemoved: 100, filesTouched: 20 };
  assert.equal(scoreSession({ ...stats, exitCode: 1 }, DEFAULTS), 'interrupted');
  // The server never sees an exitCode and must not have the tier at all — the
  // leaderboard scores reaped sessions from their raw stats.
  assert.equal(server.scoreSession(stats), 'shipped');
  assert.ok(!serverSource.includes('interrupted'), 'server score.ts must not know about interrupted');
});
