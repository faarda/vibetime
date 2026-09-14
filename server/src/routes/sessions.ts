import type { Env } from '../env.js';
import { error, json } from '../http.js';
import { requireAuth } from '../auth-middleware.js';
import { checkAndRecord } from '../ratelimit.js';
import { scoreSession, clampBaseline, earnsEvents, type Stats } from '../score.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_TIERS = new Set(['shipped', 'progressed', 'tinkering', 'exploring', 'idle', 'interrupted']);
const VALID_TOOLS_RE = /^[a-z][a-z0-9_-]{0,31}$/i;
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const MIN_DURATION_S = 60;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_SHIP_EVENTS = 62;
const DAY_SLACK_MS = 24 * 60 * 60 * 1000;

interface IncomingSession {
  id: string;
  tool: string;
  projectHash: string;
  startedAt: string;
  endedAt: string;
  durationSeconds: number;
  commits: number;
  linesAdded: number;
  linesRemoved: number;
  filesTouched: number;
  momentum?: string;
  shipEvents?: string[];
}

function parseSession(raw: unknown): IncomingSession | string {
  if (typeof raw !== 'object' || raw === null) return 'body must be an object';
  const s = raw as Record<string, unknown>;
  if (typeof s.id !== 'string' || !UUID_RE.test(s.id)) return 'invalid id';
  if (typeof s.tool !== 'string' || !VALID_TOOLS_RE.test(s.tool)) return 'invalid tool';
  if (typeof s.projectHash !== 'string' || !/^[0-9a-f]{8,64}$/.test(s.projectHash)) return 'invalid projectHash';
  if (typeof s.startedAt !== 'string' || isNaN(Date.parse(s.startedAt))) return 'invalid startedAt';
  if (typeof s.endedAt !== 'string' || isNaN(Date.parse(s.endedAt))) return 'invalid endedAt';
  if (typeof s.durationSeconds !== 'number' || s.durationSeconds < 0) return 'invalid durationSeconds';
  if (typeof s.commits !== 'number' || s.commits < 0) return 'invalid commits';
  if (typeof s.linesAdded !== 'number' || s.linesAdded < 0) return 'invalid linesAdded';
  if (typeof s.linesRemoved !== 'number' || s.linesRemoved < 0) return 'invalid linesRemoved';
  if (typeof s.filesTouched !== 'number' || s.filesTouched < 0) return 'invalid filesTouched';
  // momentum is now optional — server is authoritative — but validate the shape if old clients still send it
  if (s.momentum !== undefined && (typeof s.momentum !== 'string' || !VALID_TIERS.has(s.momentum))) return 'invalid momentum';
  if (s.shipEvents !== undefined) {
    if (!Array.isArray(s.shipEvents) || s.shipEvents.length > MAX_SHIP_EVENTS) return 'invalid shipEvents';
    for (const day of s.shipEvents) {
      if (typeof day !== 'string' || !DAY_RE.test(day) || isNaN(Date.parse(day))) return 'invalid shipEvents';
    }
    // Every event needs at least one new commit in its delta, so a session can
    // never honestly claim more event days than it has commits.
    if (s.shipEvents.length > (s.commits as number)) return 'shipEvents exceed commits';
  }
  return s as unknown as IncomingSession;
}

export async function submitSession(request: Request, env: Env): Promise<Response> {
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;

  let body: unknown;
  try { body = await request.json(); } catch { return error(400, 'invalid json'); }
  const parsed = parseSession(body);
  if (typeof parsed === 'string') return error(400, parsed);

  // Staleness keys on when the session ENDED: long-lived sessions are
  // first-class now that ship events count per day, so a session started
  // weeks ago but active yesterday is current, while one that ended two
  // weeks ago is a zombie resubmission whatever its start date.
  const startedAtMs = Date.parse(parsed.startedAt);
  const endedAtMs = Date.parse(parsed.endedAt);
  if (Date.now() - endedAtMs > MAX_AGE_MS) return error(400, 'session too old');
  if (parsed.durationSeconds < MIN_DURATION_S) return error(400, 'session too short');

  // Event days must fall within the session's lifespan (a day of slack each
  // side for clock skew) — no forging history outside the session.
  if (parsed.shipEvents) {
    for (const day of parsed.shipEvents) {
      const dayMs = Date.parse(day);
      if (dayMs < startedAtMs - DAY_SLACK_MS * 2 || dayMs > endedAtMs + DAY_SLACK_MS) return error(400, 'shipEvents outside session');
    }
  }

  // confirm the user row still exists (defends against FK insert failure if the row was deleted)
  // v1.1 follow-up: verify commit history against the user's public GitHub events
  const user = await env.DB.prepare(
    `SELECT 1 FROM users WHERE github_id = ?`,
  ).bind(auth.sub).first();
  if (!user) return error(401, 'user not found');

  if (!(await checkAndRecord(env, auth.sub))) return error(429, 'rate limit exceeded');

  // server is authoritative for momentum — recompute from raw stats and ignore whatever the client sent
  const momentum = scoreSession({
    commits: parsed.commits,
    linesAdded: parsed.linesAdded,
    linesRemoved: parsed.linesRemoved,
    filesTouched: parsed.filesTouched,
  });

  // Prior state drives the ownership check and the event baseline.
  const prior = await env.DB.prepare(
    `SELECT user_github_id AS uid,
            event_baseline_commits       AS baseCommits,
            event_baseline_lines_added   AS baseLinesAdded,
            event_baseline_lines_removed AS baseLinesRemoved,
            event_baseline_files         AS baseFiles
       FROM sessions WHERE id = ?`,
  ).bind(parsed.id).first<{
    uid: number;
    baseCommits: number | null;
    baseLinesAdded: number | null;
    baseLinesRemoved: number | null;
    baseFiles: number | null;
  }>();
  if (prior && prior.uid !== auth.sub) return error(409, 'session id belongs to another user');

  const stats: Stats = {
    commits: parsed.commits,
    linesAdded: parsed.linesAdded,
    linesRemoved: parsed.linesRemoved,
    filesTouched: parsed.filesTouched,
  };
  // A session nobody has credited yet starts from zero, like a fresh CLI
  // baseline, so its first real shipping day still lands.
  const baseline: Stats = clampBaseline({
    commits: prior?.baseCommits ?? 0,
    linesAdded: prior?.baseLinesAdded ?? 0,
    linesRemoved: prior?.baseLinesRemoved ?? 0,
    filesTouched: prior?.baseFiles ?? 0,
  }, stats);

  const submittedAt = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO sessions (id, user_github_id, tool, project_hash, started_at, ended_at,
                           duration_seconds, commits, lines_added, lines_removed,
                           files_touched, momentum, submitted_at,
                           event_baseline_commits, event_baseline_lines_added,
                           event_baseline_lines_removed, event_baseline_files)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       tool = excluded.tool,
       project_hash = excluded.project_hash,
       started_at = excluded.started_at,
       ended_at = excluded.ended_at,
       duration_seconds = excluded.duration_seconds,
       commits = excluded.commits,
       lines_added = excluded.lines_added,
       lines_removed = excluded.lines_removed,
       files_touched = excluded.files_touched,
       momentum = excluded.momentum,
       event_baseline_commits = excluded.event_baseline_commits,
       event_baseline_lines_added = excluded.event_baseline_lines_added,
       event_baseline_lines_removed = excluded.event_baseline_lines_removed,
       event_baseline_files = excluded.event_baseline_files
     WHERE sessions.user_github_id = excluded.user_github_id`,
  ).bind(
    parsed.id, auth.sub, parsed.tool, parsed.projectHash, parsed.startedAt, parsed.endedAt,
    parsed.durationSeconds, parsed.commits, parsed.linesAdded, parsed.linesRemoved,
    parsed.filesTouched, momentum, submittedAt,
    baseline.commits, baseline.linesAdded, baseline.linesRemoved, baseline.filesTouched,
  ).run();

  // One row per (session, day); past days are announced history and immutable.
  //
  // Where the day list comes from still depends on the client version, but the
  // test it has to pass no longer does. Both paths go through earnsEvents, so
  // a day counts only when the work since the last credited event would score
  // 'shipped' on its own.
  //
  // This used to be two rules. A v0.8+ client's list was taken verbatim, and a
  // pre-0.8 client's end day was derived from cumulative momentum plus "did
  // commits grow" — one commit, no meaningfulness test, every day, forever,
  // for any long-lived session that had ever shipped. The two drifted because
  // nothing compared them; test/score-parity.test.mjs now does.
  const todayDay = new Date().toISOString().slice(0, 10);
  let claimedDays: string[];
  if (parsed.shipEvents) {
    claimedDays = [...new Set(parsed.shipEvents)].sort();
    // Reconciliation is unchanged and still bounded to today and later, so
    // announced history stays append-only.
    await env.DB.prepare(
      `DELETE FROM ship_events WHERE session_id = ? AND day >= ?${claimedDays.length ? ` AND day NOT IN (${claimedDays.map(() => '?').join(',')})` : ''}`,
    ).bind(parsed.id, todayDay, ...claimedDays).run();
  } else {
    claimedDays = momentum === 'shipped' ? [parsed.endedAt.slice(0, 10)] : [];
  }

  // Days this session already holds are paid for; re-claiming one costs
  // nothing and must not consume the delta a new day would need.
  const credited = claimedDays.length
    ? await env.DB.prepare(
        `SELECT day FROM ship_events WHERE session_id = ? AND day IN (${claimedDays.map(() => '?').join(',')})`,
      ).bind(parsed.id, ...claimedDays).all<{ day: string }>()
    : null;
  const already = new Set((credited?.results ?? []).map((r) => r.day));
  const newDays = claimedDays.filter((d) => !already.has(d));

  // No per-day ceiling. There used to be one, 10 events per user per UTC day,
  // silently dropping the rest. It was built when a ship event could appear
  // without shipping, and it was the only thing bounding that. It is not what
  // bounds it now: an event needs its own session, a new commit, and a delta
  // that scores 'shipped' on its own. What the cap actually truncated was
  // someone running several agents on several branches, which is the workflow
  // this tool exists to measure, and it truncated them in silence.
  //
  // What still bounds the table: one row per (session, day) by primary key,
  // event days never exceeding commits, earnsEvents on every day, and the
  // per-user request limiter in ratelimit.ts.
  let landed = 0;
  if (earnsEvents(baseline, stats, newDays.length)) {
    for (const day of newDays) {
      const res = await env.DB.prepare(
        `INSERT OR IGNORE INTO ship_events (session_id, user_github_id, day) VALUES (?1, ?2, ?3)`,
      ).bind(parsed.id, auth.sub, day).run();
      if (res.meta.changes > 0) landed++;
    }
  }

  // Spend the delta only on work that was actually credited. A row lost to a
  // concurrent writer leaves the baseline where it was, so the work rolls
  // forward instead of evaporating.
  if (landed > 0) {
    await env.DB.prepare(
      `UPDATE sessions SET event_baseline_commits = ?, event_baseline_lines_added = ?,
                           event_baseline_lines_removed = ?, event_baseline_files = ?
        WHERE id = ? AND user_github_id = ?`,
    ).bind(stats.commits, stats.linesAdded, stats.linesRemoved, stats.filesTouched, parsed.id, auth.sub).run();
  }

  await env.DB.prepare(`UPDATE users SET last_seen_at = ? WHERE github_id = ?`).bind(submittedAt, auth.sub).run();

  return json({ ok: true, submittedAt });
}
