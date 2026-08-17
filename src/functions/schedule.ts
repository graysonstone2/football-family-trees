import rawSchedule from '../schedule_2026.json';
import rawLineage from '../schedule_lineage_2026.json';

export type { ScheduleView } from './scheduleView';

export type StaffRole = 'hc' | 'oc' | 'dc';

export type StaffMember = {
  coach: string;
  role: StaffRole;
};

export type ConnectionType = 'mentor-protege' | 'shared-staff' | 'shared-mentor' | 'shared-ancestor';

export type LineageConnection = {
  type: ConnectionType;
  via: string;
  a: StaffMember;
  b: StaffMember;
  aStops: string | null;
  bStops: string | null;
  together: string | null;
  stops: string | null;
  protege: string | null;
  hops: number | null;
  weight: number;
};

export type LineageTier =
  | 'reunion'
  | 'family'
  | 'cousins'
  | 'thread'
  | 'strangers'
  | 'unknown'
  | 'untracked';

export type GameLineage = {
  score: number;
  tier: LineageTier;
  staffed: boolean;
  rank: number | null;
  connectionCount?: number;
  headline?: string | null;
  trees?: Array<{ coach: string; links: number }>;
  connections: LineageConnection[];
};

export type ScheduleGame = {
  id: string;
  date: string;
  week: number;
  home: string;
  away: string;
  homeTracked: boolean;
  awayTracked: boolean;
  neutralSite: boolean;
  conferenceGame: boolean;
  kickoff: string | null;
  stadium: string | null;
  city: string | null;
  tv: string | null;
  name: string | null;
};

export type Patriarch = {
  coach: string;
  gameCount: number;
  linkCount: number;
  gameIds: string[];
};

type ScheduleFile = {
  season: number;
  week0Saturday: string;
  conferences: Record<string, string>;
  games: ScheduleGame[];
};

type LineageFile = {
  season: number;
  games: Record<string, GameLineage>;
  patriarchs: Patriarch[];
  staffs: Record<string, StaffMember[]>;
};

const schedule = rawSchedule as ScheduleFile;
const lineage = rawLineage as unknown as LineageFile;

export const SCHEDULE_SEASON = schedule.season;
export const SCHEDULE_GAMES = schedule.games;
export const CONFERENCES = schedule.conferences;
export const PATRIARCHS = lineage.patriarchs;

export const ROLE_LABELS: Record<StaffRole, string> = {
  hc: 'Head coach',
  oc: 'Offensive coordinator',
  dc: 'Defensive coordinator',
};

export const ROLE_SHORT: Record<StaffRole, string> = { hc: 'HC', oc: 'OC', dc: 'DC' };

export const TIER_META: Record<LineageTier, { label: string; tone: string; blurb: string }> = {
  reunion: {
    label: 'Family reunion',
    tone: 'great',
    blurb: 'Both sidelines are stacked with coaches out of the same tree.',
  },
  family: {
    label: 'Immediate family',
    tone: 'good',
    blurb: 'Several direct mentor links run across this matchup.',
  },
  cousins: {
    label: 'Cousins',
    tone: 'middling',
    blurb: 'A few coaches on each side answer to the same old boss.',
  },
  thread: {
    label: 'One loose thread',
    tone: 'rough',
    blurb: 'A single faint branch ties these staffs together.',
  },
  strangers: {
    label: 'No shared branches',
    tone: 'neutral',
    blurb: 'Nothing in this dataset connects these two staffs.',
  },
  unknown: {
    label: 'Staff not published',
    tone: 'neutral',
    blurb: 'Wikipedia has not posted a 2026 staff for one of these teams yet.',
  },
  untracked: {
    label: 'Outside this dataset',
    tone: 'neutral',
    blurb: 'One of these programs is not among the 127 schools this dataset follows.',
  },
};

const EMPTY_LINEAGE: GameLineage = {
  score: 0,
  tier: 'unknown',
  staffed: false,
  rank: null,
  connections: [],
};

export const getLineage = (gameId: string): GameLineage => lineage.games[gameId] ?? EMPTY_LINEAGE;

/** Separates "nobody has posted a staff" from "this program isn't tracked at all". */
export const tierForGame = (game: ScheduleGame, entry: GameLineage): LineageTier =>
  game.homeTracked && game.awayTracked ? entry.tier : 'untracked';

export const getCoreStaff = (school: string): StaffMember[] => lineage.staffs[school] ?? [];

export const getConference = (school: string): string | null => schedule.conferences[school] ?? null;

const gamesById = new Map(SCHEDULE_GAMES.map((game) => [game.id, game]));

export const getGame = (gameId: string): ScheduleGame | null => gamesById.get(gameId) ?? null;

export const WEEKS = Array.from(new Set(SCHEDULE_GAMES.map((game) => game.week)))
  .sort((a, b) => a - b)
  .map((week) => {
    const games = SCHEDULE_GAMES.filter((game) => game.week === week);
    const dates = games.map((game) => game.date).sort();

    return {
      week,
      label: `Week ${week}`,
      count: games.length,
      start: dates[0],
      end: dates[dates.length - 1],
    };
  });

/** The week a visitor most likely cares about: the one in progress, or the next one. */
export const getCurrentWeek = (today = new Date()) => {
  const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(
    today.getDate(),
  ).padStart(2, '0')}`;
  const upcoming = WEEKS.find((week) => week.end >= iso);

  return upcoming?.week ?? WEEKS[WEEKS.length - 1]?.week ?? 0;
};

export const RANKED_GAMES = SCHEDULE_GAMES.map((game) => ({ game, lineage: getLineage(game.id) }))
  .filter((entry) => entry.lineage.rank !== null)
  .sort((a, b) => (a.lineage.rank ?? 0) - (b.lineage.rank ?? 0));

/** Only teams the coaching dataset covers — FCS opponents would bloat the filter. */
export const TEAM_OPTIONS = Array.from(
  new Set(
    SCHEDULE_GAMES.flatMap((game) => [
      ...(game.homeTracked ? [game.home] : []),
      ...(game.awayTracked ? [game.away] : []),
    ]),
  ),
).sort((a, b) => a.localeCompare(b));

export const CONFERENCE_OPTIONS = Array.from(new Set(Object.values(schedule.conferences))).sort(
  (a, b) => a.localeCompare(b),
);

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const formatGameDate = (iso: string) => {
  const [year, month, day] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));

  return `${WEEKDAYS[date.getUTCDay()]} ${MONTHS[month - 1]} ${day}`;
};

export const formatWeekRange = (week: (typeof WEEKS)[number]) => {
  const start = formatGameDate(week.start);

  return week.start === week.end ? start : `${start} - ${formatGameDate(week.end)}`;
};

export const describeSite = (game: ScheduleGame) => {
  const parts = [game.stadium, game.city].filter(Boolean);
  return parts.join(', ');
};

export const CONNECTION_LABELS: Record<ConnectionType, string> = {
  'mentor-protege': 'Boss vs. protege',
  'shared-staff': 'Same staff, same season',
  'shared-mentor': 'Same mentor',
  'shared-ancestor': 'Same tree, a generation up',
};
