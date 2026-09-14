import type { Env } from './env.js';

const WINDOW_SECONDS = 3600;
// Abuse guard only, not the anti-gaming control: that is the 10 ship events per
// UTC day cap in routes/sessions.ts, and it is unaffected by this number.
// Sized for how people actually work: every open session resubmits while it is
// shipping, so someone running a dozen agents across repos legitimately posts
// far more than one submission a minute. At 60 they were silently 429'd and
// lost in-progress updates, which is worse than anything this guard prevents.
const MAX_PER_WINDOW = 300;

export async function checkAndRecord(env: Env, userGithubId: number): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  const cutoff = now - WINDOW_SECONDS;
  await env.DB.prepare(`DELETE FROM submission_log WHERE at < ?`).bind(cutoff).run();
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM submission_log WHERE user_github_id = ? AND at >= ?`,
  ).bind(userGithubId, cutoff).first<{ n: number }>();
  if ((row?.n ?? 0) >= MAX_PER_WINDOW) return false;
  await env.DB.prepare(`INSERT INTO submission_log (user_github_id, at) VALUES (?, ?)`).bind(userGithubId, now).run();
  return true;
}
