import chalk from 'chalk';
import type { Session } from './db.js';
import { TIER_FILLED, type MomentumTier } from './score.js';
import { PURPLE } from './colors.js';
import type { LeaderboardEntry } from './leaderboard.js';
import type { CommitTotals } from './ledger.js';

const DIM = chalk.hex('#444444');
const WIDTH = 47;

export function stripAnsi(str: string): string {
  return str.replace(/\u001B\[[0-9;]*m/g, '');
}

export function pad(str: string, len: number): string {
  return str + ' '.repeat(Math.max(0, len - stripAnsi(str).length));
}

export function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0 && m > 0) return `${h}h ${m}m`;
  if (h > 0) return `${h}h 0m`;
  if (m === 0) return '<1m';
  return `${m}m`;
}

export function truncateProject(name: string, max = 16): string {
  const display = name.includes('/') ? name.split('/').pop()! : name;
  return display.length <= max ? display : display.slice(0, max - 1) + '…';
}

function momentumBar(tier: MomentumTier) {
  const filled = TIER_FILLED[tier];
  return PURPLE('█'.repeat(filled)) + DIM('░'.repeat(10 - filled));
}

function tierLabel(tier: MomentumTier) {
  const icon = tier === 'interrupted' ? '  ⚠' : tier === 'shipped' ? PURPLE('  ✦') : '';
  return `${tier}${icon}`;
}

export function renderEndcard(session: Session): string {
  const project = truncateProject(session.project);
  const duration = formatDuration(session.durationSeconds);
  const tier = session.momentum;

  const headerContent = `  ${PURPLE('◆')} vibe  ·  ${project}  ·  ${duration}`;
  const headerPadded = pad(headerContent, WIDTH - 2);

  const statsContent = session.branch === 'unknown'
    ? `  ${DIM('no git')}`
    : `  ${session.commits} commits  ·  +${session.linesAdded} −${session.linesRemoved}  ·  ${session.filesTouched} files`;
  const statsPadded = pad(statsContent, WIDTH - 2);

  const bar = momentumBar(tier);
  const label = tierLabel(tier);
  const barContent = `  ${bar}  ${label}`;
  const barPadded = pad(barContent, WIDTH - 2);

  const top = DIM('╭' + '─'.repeat(WIDTH - 2) + '╮');
  const sep = DIM('├' + '─'.repeat(WIDTH - 2) + '┤');
  const bot = DIM('╰' + '─'.repeat(WIDTH - 2) + '╯');
  const side = DIM('│');
  const empty = `${side}${' '.repeat(WIDTH - 2)}${side}`;

  // Its own row rather than an extra clause on the stats line: the card is a
  // fixed 47 columns and the stats line is already close to full. Nothing to
  // say when there were no commits, or when counting is off (undefined).
  const pushedRow = session.pushedCommits !== undefined && session.commits > 0
    ? [`${side}${pad(`  ${DIM(`${session.pushedCommits} of ${session.commits} pushed`)}`, WIDTH - 2)}${side}`]
    : [];

  return [
    '',
    top,
    `${side}${headerPadded}${side}`,
    sep,
    empty,
    `${side}${statsPadded}${side}`,
    ...pushedRow,
    empty,
    `${side}${barPadded}${side}`,
    empty,
    bot,
    '',
  ].join('\n');
}

// What git says you committed today, regardless of what the sessions caught.
// Rendered wherever sessions are, because the whole point is to be readable
// side by side with them: when the two disagree, this is the honest one.
function ledgerLine(ledger: CommitTotals): string {
  const commits = `${ledger.total} commit${ledger.total === 1 ? '' : 's'} today`;
  const where = ledger.repos.length === 1
    ? ledger.repos[0].name
    : `${ledger.repos.length} repos`;
  return `  ${commits}  ${DIM('·')}  ${DIM(where)}  ${DIM('· from git')}`;
}

export function renderStatus(sessions: Session[], signedOut = false, ledger?: CommitTotals): string {
  const now = new Date();
  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const dayName = days[now.getDay()];
  const dateStr = `${dayName} ${now.getDate()} ${months[now.getMonth()]}`;

  const header = `${PURPLE('◆')} vibe  ·  today  ·  ${dateStr}`;

  if (sessions.length === 0) {
    if (ledger && ledger.total > 0) {
      // Committed today with nothing tracking it — a tool without hooks, or
      // hooks that missed. Say what git has rather than "no sessions today",
      // which reads as "you did nothing".
      return [
        '', header, '',
        '  no sessions tracked today, but git says otherwise:', '',
        ledgerLine(ledger),
        '',
        `  ${DIM('see where: vibe commits')}`,
        '',
        ...(signedOut ? [renderSignedOutNotice()] : []),
      ].join('\n');
    }
    return `\n${header}\n\n  no sessions today. start a vibe coding session to begin tracking.\n`;
  }

  const maxProjectLen = Math.max(...sessions.map(s => truncateProject(s.project).length));
  const maxDurationLen = Math.max(...sessions.map(s => formatDuration(s.durationSeconds).length));

  const rows = sessions.map((s) => {
    const project = truncateProject(s.project).padEnd(maxProjectLen);
    const duration = formatDuration(s.durationSeconds).padStart(maxDurationLen);
    const tier = s.momentum;
    const icon = tier === 'interrupted' ? '  ⚠' : tier === 'shipped' ? PURPLE('  ✦') : '';
    return `  ${project}  ${DIM(duration)}   ${s.momentum}${icon}`;
  });

  const totalSeconds = sessions.reduce((sum, s) => sum + s.durationSeconds, 0);
  const shipped = sessions.filter(s => s.momentum === 'shipped').length;
  const total = formatDuration(totalSeconds);
  // Only when at least one of today's sessions was actually counted — off, or
  // sessions recorded before it was switched on, say nothing rather than 0.
  const counted = sessions.filter(s => s.pushedCommits !== undefined);
  const pushed = counted.reduce((sum, s) => sum + (s.pushedCommits ?? 0), 0);
  const pushedSuffix = counted.length > 0 ? `  ·  ${pushed} commit${pushed === 1 ? '' : 's'} pushed` : '';
  const summary = `  ${total} total  ·  ${shipped} of ${sessions.length} sessions shipped${pushedSuffix}`;

  return [
    '',
    header,
    '',
    ...rows,
    '',
    `  ${DIM('─'.repeat(37))}`,
    summary,
    ...(ledger && ledger.total > 0 ? [ledgerLine(ledger)] : []),
    '',
    ...(signedOut ? [renderSignedOutNotice()] : []),
  ].join('\n');
}

// The full breakdown behind that line: `vibe commits`.
export function renderCommits(ledger: CommitTotals, label: string, hasRoots: boolean): string {
  const header = `${PURPLE('◆')} vibe  ·  commits  ·  ${label}`;

  if (ledger.total === 0) {
    const body = ledger.reposKnown === 0
      ? [
          '  no repos to look in yet.',
          '',
          `  point vibe at where your code lives:  ${PURPLE('vibe config add-root ~/dev')}`,
        ]
      : [`  no commits ${label}, across ${ledger.reposKnown} repo${ledger.reposKnown === 1 ? '' : 's'}.`];
    return ['', header, '', ...body, ...otherAuthorsBlock(ledger), '', ...(hasRoots ? [] : [rootHint()]), ''].join('\n');
  }

  const nameWidth = Math.max(...ledger.repos.map((r) => truncateProject(r.name).length));
  const rows = ledger.repos.map((r) => {
    const name = truncateProject(r.name).padEnd(nameWidth);
    return `  ${name}   ${PURPLE(String(r.commits).padStart(3))}`;
  });

  const summary = `  ${ledger.total} commit${ledger.total === 1 ? '' : 's'} ${label}  ${DIM('·')}  ${ledger.repos.length} of ${ledger.reposKnown} repos`;

  return [
    '',
    header,
    '',
    ...rows,
    '',
    `  ${DIM('─'.repeat(37))}`,
    summary,
    ...otherAuthorsBlock(ledger),
    '',
    ...(hasRoots ? [] : [rootHint(), '']),
  ].join('\n');
}

// The answer to "I committed today, why does this say nothing". Nearly always
// a second identity rather than anything lost, so name the addresses and the
// one command that fixes it.
function otherAuthorsBlock(ledger: CommitTotals): string[] {
  const others = (ledger.others ?? []).slice(0, 3);
  if (others.length === 0) return [];

  const width = Math.max(...others.map((o) => o.email.length));
  return [
    '',
    `  ${DIM('committed here, but not as you:')}`,
    ...others.map((o) => `    ${DIM(o.email.padEnd(width))}   ${DIM(String(o.commits))}`),
    '',
    `  ${DIM('if one of those is you:')} ${PURPLE(`vibe config add-email ${others[0].email}`)}`,
  ];
}

function rootHint(): string {
  return `  ${DIM('counting only repos vibe has seen in a session.')}\n  ${DIM('add the rest:')} ${PURPLE('vibe config add-root ~/dev')}`;
}

// Shown after the endcard and under `vibe status` when the server rejected the
// saved login. Tracking keeps working locally, only the leaderboard stops, so
// this states the consequence and the one-command fix without crying wolf.
export function renderSignedOutNotice(): string {
  return `  ${PURPLE('◆')} signed out · run ${PURPLE('vibe login')} so your ships keep counting\n`;
}

// Offered right after setup, because signing in is the one step nobody
// discovers on their own and the leaderboard is why most people install this.
// It asks rather than assumes: tracking already works without an account.
export function renderLoginOffer(): string {
  return `  ${PURPLE('◆')} join the leaderboard? sign in with github so your ships count`;
}

export function renderLoginSkipped(): string {
  return `\n  ${PURPLE('◆')} no problem, tracking works without it. join anytime: ${PURPLE('vibe login')}\n`;
}

export function renderLoginPrompt(userCode: string, verificationUri: string): string {
  const top = DIM('╭' + '─'.repeat(WIDTH - 2) + '╮');
  const bot = DIM('╰' + '─'.repeat(WIDTH - 2) + '╯');
  const side = DIM('│');
  const empty = `${side}${' '.repeat(WIDTH - 2)}${side}`;

  const title = pad(`  ${PURPLE('◆')} vibe  ·  sign in with github`, WIDTH - 2);
  const code = pad(`  code:  ${PURPLE(userCode)}`, WIDTH - 2);

  return [
    '',
    top,
    `${side}${title}${side}`,
    empty,
    `${side}${code}${side}`,
    empty,
    bot,
    '',
    `  visit: ${verificationUri}`,
    '',
    '  waiting for github approval…',
    '',
  ].join('\n');
}

export function renderLeaderboard(entries: LeaderboardEntry[], webUrl: string, currentHandle?: string): string {
  const header = `${PURPLE('◆')} vibe  ·  leaderboard  ·  ships · this week`;
  const footer = `  ${DIM(webUrl)}`;

  if (entries.length === 0) {
    return ['', header, '', '  no shipped sessions yet this week. be the first.', '', footer, ''].join('\n');
  }

  const maxHandleLen = Math.max(...entries.map(e => e.handle.length), 8);
  const maxRankLen = String(entries[entries.length - 1].rank).length;

  const rows = entries.map((e) => {
    const isMe = currentHandle && e.handle.toLowerCase() === currentHandle.toLowerCase();
    const rank = String(e.rank).padStart(maxRankLen);
    const handle = e.handle.padEnd(maxHandleLen);
    const count = String(e.shippedCount).padStart(3);
    const days = e.dayCount === undefined ? '' : DIM(`  over ${e.dayCount} day${e.dayCount === 1 ? '' : 's'}`);
    const line = `  ${DIM(rank)}  ${handle}  ${DIM('·')}  ${count} ship${e.shippedCount === 1 ? ' ' : 's'}${days}`;
    return isMe ? PURPLE(line) : line;
  });

  return ['', header, '', ...rows, '', footer, ''].join('\n');
}

export function renderLog(sessions: Session[], all: Session[] = sessions): string {
  if (sessions.length === 0) {
    return '\n  no sessions recorded yet.\n';
  }

  const lines = sessions.map((s) => {
    const date = new Date(s.startedAt);
    const dateStr = date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }).toLowerCase();
    const project = truncateProject(s.project, 20).padEnd(20);
    const duration = formatDuration(s.durationSeconds).padStart(7);
    const tier = s.momentum;
    return `  ${DIM(dateStr)}  ${project}  ${duration}   ${tier}`;
  });

  // The list shows recent sessions; the footer totals everything ever
  // recorded, and says so — the two would otherwise read as one sum.
  const totalSeconds = all.reduce((sum, s) => sum + s.durationSeconds, 0);
  const shipped = all.filter((s) => s.momentum === 'shipped').length;
  const summary = `  all time: ${formatDuration(totalSeconds)} across ${all.length} session${all.length === 1 ? '' : 's'}  ·  ${shipped} shipped`;

  return ['\n', ...lines, '', `  ${DIM('─'.repeat(44))}`, summary, ''].join('\n');
}
