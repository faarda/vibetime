import { request } from './api.js';

export interface LeaderboardEntry {
  rank: number;
  handle: string;
  avatarUrl: string | null;
  // Days shipped in the window: what the rank is built on.
  shippedCount: number;
  // Total ships, the tiebreak. Absent from servers older than this field, so a
  // CLI pointed at one falls back to showing days alone.
  shipCount?: number;
}

interface LeaderboardResponse {
  window: string;
  updatedAt: string;
  entries: LeaderboardEntry[];
}

export async function fetchLeaderboard(): Promise<LeaderboardResponse> {
  return request<LeaderboardResponse>('/leaderboard.json', { timeoutMs: 5000 });
}
