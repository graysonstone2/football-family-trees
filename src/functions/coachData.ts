import rawData from '../data.json';

export type CoachRole = 'hc' | 'dc' | 'oc' | 'other' | string;

export type CoachJob = {
  school: string;
  year: number;
  title: CoachRole;
};

export type CoachTreeNode = {
  id: string;
  parent?: string;
  years: number[];
  cutoffYear: number;
  history: CoachJob[];
  relation?: 'descendant' | 'mentor';
};

export type DatasetSummary = {
  coachCount: number;
  schoolCount: number;
  seasonRange: string;
  headCoachCount: number;
};

type Roster = {
  hc?: string | string[];
  dc?: string | string[];
  oc?: string | string[];
  other?: string[];
  [title: string]: string | string[] | undefined;
};

type DataSet = Record<string, Record<string, Roster>>;
type CoachSet = Record<string, CoachJob[]>;

const data = rawData as unknown as DataSet;
let coachSet: CoachSet | null = null;
let coachNames: string[] | null = null;
let datasetStartYear: number | null = null;

const byYear = (a: CoachJob, b: CoachJob) => a.year - b.year;
const formatCoachName = (name: string) => name.trim().replace(/\s+/g, ' ');
const splitCoachNames = (title: CoachRole, value: string) => {
  if (title === 'hc') {
    return [value];
  }

  return value
    .split(/\s*(?:,|\/|\band\b)\s*/i)
    .map(formatCoachName)
    .filter(Boolean);
};

const addCoach = (
  coaches: CoachSet,
  school: string,
  year: string,
  title: CoachRole,
  name?: string,
) => {
  if (!name || !name.trim()) {
    return;
  }

  const cleanName = formatCoachName(name);
  coaches[cleanName] = coaches[cleanName] ?? [];
  coaches[cleanName].push({ school, year: Number(year), title });
};

export const buildCoachSet = () => {
  if (coachSet) {
    return coachSet;
  }

  const coaches: CoachSet = {};

  Object.entries(data).forEach(([school, seasons]) => {
    Object.entries(seasons).forEach(([year, roster]) => {
      Object.entries(roster).forEach(([title, value]) => {
        const coachNames = Array.isArray(value)
          ? value
          : typeof value === 'string'
            ? splitCoachNames(title, value)
            : [];

        coachNames.forEach((coach) => addCoach(coaches, school, year, title, coach));
      });
    });
  });

  Object.values(coaches).forEach((jobs) => jobs.sort(byYear));
  coachSet = coaches;

  return coachSet;
};

export const getCoachNames = () => {
  if (coachNames) {
    return coachNames;
  }

  coachNames = Object.keys(buildCoachSet()).sort((a, b) => a.localeCompare(b));
  return coachNames;
};

export const findCoachName = (query: string) => {
  const cleanQuery = formatCoachName(query).toLowerCase();
  return getCoachNames().find((name) => name.toLowerCase() === cleanQuery) ?? null;
};

export const getDatasetSummary = (): DatasetSummary => {
  const coaches = buildCoachSet();
  const seasons = Object.values(data).flatMap((school) => Object.keys(school).map(Number));
  const headCoachCount = Object.values(coaches).filter((jobs) =>
    jobs.some((job) => job.title === 'hc'),
  ).length;

  return {
    coachCount: Object.keys(coaches).length,
    schoolCount: Object.keys(data).length,
    seasonRange: `${Math.min(...seasons)}-${Math.max(...seasons)}`,
    headCoachCount,
  };
};

const collectAssistantYears = (school: string, year: number) => {
  const roster = data[school]?.[String(year)];
  const assistants: Record<string, number[]> = {};

  if (!roster) {
    return assistants;
  }

  Object.entries(roster).forEach(([title, value]) => {
    if (title === 'hc') {
      return;
    }

    const coachNames = Array.isArray(value)
      ? value
      : typeof value === 'string'
        ? splitCoachNames(title, value)
        : [];

    coachNames.forEach((coach) => {
      const cleanName = formatCoachName(coach);
      assistants[cleanName] = [...(assistants[cleanName] ?? []), year];
    });
  });

  return assistants;
};

const firstHeadCoachYear = (jobs: CoachJob[]) => {
  const headCoachYears = jobs.filter((job) => job.title === 'hc').map((job) => job.year);
  return headCoachYears.length ? Math.min(...headCoachYears) : Number.POSITIVE_INFINITY;
};

const getDatasetStartYear = () => {
  if (datasetStartYear !== null) {
    return datasetStartYear;
  }

  const years = Object.values(data).flatMap((school) => Object.keys(school).map(Number));
  datasetStartYear = Math.min(...years);

  return datasetStartYear;
};

const collectMentorYears = (coachId: string, cutoffYear: number) => {
  const coaches = buildCoachSet();
  const mentorYears: Record<string, number[]> = {};
  const coachJobs = coaches[coachId] ?? [];

  coachJobs.forEach((job) => {
    if (job.title === 'hc' || job.year >= cutoffYear) {
      return;
    }

    const headCoach = data[job.school]?.[String(job.year)]?.hc;
    const headCoachNames = Array.isArray(headCoach) ? headCoach : headCoach ? [headCoach] : [];

    headCoachNames.forEach((mentor) => {
      const cleanMentor = formatCoachName(mentor);

      if (cleanMentor && cleanMentor !== coachId) {
        mentorYears[cleanMentor] = [...(mentorYears[cleanMentor] ?? []), job.year];
      }
    });
  });

  return mentorYears;
};

export const buildTree = (rootCoach: string): CoachTreeNode[] | null => {
  const coaches = buildCoachSet();
  const exactRoot = findCoachName(rootCoach);

  if (!exactRoot || !coaches[exactRoot]) {
    return null;
  }

  const queue: Array<{
    id: string;
    parent?: string;
    years: number[];
    cutoffYear: number;
  }> = [{ id: exactRoot, years: [], cutoffYear: getDatasetStartYear() }];
  const nodes: CoachTreeNode[] = [];
  const visited = new Set<string>();

  while (queue.length > 0) {
    const currentCoach = queue.shift();

    if (!currentCoach || visited.has(currentCoach.id)) {
      continue;
    }

    visited.add(currentCoach.id);

    const coachJobs = coaches[currentCoach.id] ?? [];
    const wasHeadCoachLater = coachJobs.some((job) => {
      if (currentCoach.parent === undefined) {
        return job.title === 'hc';
      }

      return job.title === 'hc' && job.year > currentCoach.years[0];
    });

    if (!wasHeadCoachLater) {
      continue;
    }

    nodes.push({ ...currentCoach, history: coachJobs, relation: 'descendant' });

    const coachesToAdd: Record<string, number[]> = {};
    coachJobs.forEach((job) => {
      if (job.title !== 'hc' || currentCoach.cutoffYear > job.year) {
        return;
      }

      const assistants = collectAssistantYears(job.school, job.year);
      Object.entries(assistants).forEach(([coach, years]) => {
        coachesToAdd[coach] = [...(coachesToAdd[coach] ?? []), ...years];
      });
    });

    Object.entries(coachesToAdd).forEach(([coach, years]) => {
      const sortedYears = Array.from(new Set(years)).sort((a, b) => b - a);
      queue.push({
        id: coach,
        years: sortedYears,
        parent: currentCoach.id,
        cutoffYear: sortedYears[0],
      });
    });
  }

  return nodes;
};

export const buildReverseTree = (rootCoach: string): CoachTreeNode[] | null => {
  const coaches = buildCoachSet();
  const exactRoot = findCoachName(rootCoach);

  if (!exactRoot || !coaches[exactRoot]) {
    return null;
  }

  const rootJobs = coaches[exactRoot] ?? [];
  const queue: Array<{
    id: string;
    parent?: string;
    years: number[];
    cutoffYear: number;
  }> = [{ id: exactRoot, years: [], cutoffYear: firstHeadCoachYear(rootJobs) }];
  const nodes: CoachTreeNode[] = [];
  const visited = new Set<string>();

  while (queue.length > 0) {
    const currentCoach = queue.shift();

    if (!currentCoach || visited.has(currentCoach.id)) {
      continue;
    }

    visited.add(currentCoach.id);

    const coachJobs = coaches[currentCoach.id] ?? [];
    nodes.push({ ...currentCoach, history: coachJobs, relation: 'mentor' });

    const mentorYears = collectMentorYears(currentCoach.id, currentCoach.cutoffYear);

    Object.entries(mentorYears).forEach(([mentor, years]) => {
      if (!coaches[mentor]) {
        return;
      }

      const sortedYears = Array.from(new Set(years)).sort((a, b) => b - a);
      queue.push({
        id: mentor,
        years: sortedYears,
        parent: currentCoach.id,
        cutoffYear: firstHeadCoachYear(coaches[mentor] ?? []),
      });
    });
  }

  return nodes;
};

export default buildTree;
