import rawRecords from '../school_records_frontend.json';

export type SchoolRecord = {
  losses: number;
  pct?: number;
  raw_record: string;
  record: string;
  record_note?: string;
  source_url?: string;
  teamKey: string;
  teamName: string;
  wins: number;
  year: number;
  yearKey: string;
};

type TeamRecord = {
  teamKey: string;
  teamName: string;
  yearKeys: string[];
  years: Record<string, SchoolRecord>;
};

type SchoolRecordsData = {
  recordsByYear: Record<string, Record<string, SchoolRecord>>;
  schemaVersion: number;
  teamKeys: string[];
  teams: Record<string, TeamRecord>;
  yearKeys: string[];
};

export type RecordSummary = {
  losses: number;
  pct: number;
  records: SchoolRecord[];
  wins: number;
};

const data = rawRecords as unknown as SchoolRecordsData;

const normalizeSchool = (school: string) =>
  school
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/\(([^)]+)\)/g, ' $1 ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

const teamKeyByName = new Map<string, string>();

Object.values(data.teams).forEach((team) => {
  teamKeyByName.set(normalizeSchool(team.teamName), team.teamKey);
  teamKeyByName.set(normalizeSchool(team.teamKey), team.teamKey);
});

const resolveTeamKey = (school: string) => {
  const normalized = normalizeSchool(school);
  return data.teams[normalized] ? normalized : teamKeyByName.get(normalized) ?? null;
};

export const getSchoolRecord = (school: string, year: number) => {
  const teamKey = resolveTeamKey(school);

  if (!teamKey) {
    return null;
  }

  return data.recordsByYear[String(year)]?.[teamKey] ?? null;
};

export const summarizeRecords = (records: Array<SchoolRecord | null | undefined>): RecordSummary | null => {
  const validRecords = records.filter((record): record is SchoolRecord => Boolean(record));

  if (!validRecords.length) {
    return null;
  }

  const wins = validRecords.reduce((total, record) => total + record.wins, 0);
  const losses = validRecords.reduce((total, record) => total + record.losses, 0);

  return {
    losses,
    pct: wins + losses > 0 ? wins / (wins + losses) : 0,
    records: validRecords,
    wins,
  };
};

export const getRecordPct = (record: SchoolRecord) => {
  if (record.pct !== undefined) {
    return record.pct;
  }

  return record.wins + record.losses > 0 ? record.wins / (record.wins + record.losses) : 0;
};

export const summarizeSchoolYears = (school: string, years: number[]) =>
  summarizeRecords(years.map((year) => getSchoolRecord(school, year)));

export const getSurroundingRecordSummary = (school: string, years: number[]) => {
  if (!years.length) {
    return { after: null, before: null, during: null };
  }

  const sortedYears = Array.from(new Set(years)).sort((a, b) => a - b);
  const startYear = sortedYears[0];
  const endYear = sortedYears[sortedYears.length - 1];
  const beforeYears = [startYear - 3, startYear - 2, startYear - 1];
  const afterYears = [endYear + 1, endYear + 2, endYear + 3];

  return {
    after: summarizeSchoolYears(school, afterYears),
    before: summarizeSchoolYears(school, beforeYears),
    during: summarizeSchoolYears(school, sortedYears),
  };
};

export const formatRecordSummary = (summary?: RecordSummary | null) => {
  if (!summary) {
    return 'No record data';
  }

  return `${summary.wins}-${summary.losses} (${Math.round(summary.pct * 100)}%)`;
};

export const getRecordTone = (pct?: number | null) => {
  if (pct === undefined || pct === null) {
    return 'neutral';
  }

  if (pct >= 0.75) {
    return 'great';
  }

  if (pct >= 0.6) {
    return 'good';
  }

  if (pct >= 0.45) {
    return 'middling';
  }

  return 'rough';
};
