import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const dataPath = join(rootDir, 'src', 'data.json');
const outputPath = join(rootDir, 'src', 'tree_leaderboard.json');
const staffOutputPath = join(rootDir, 'src', 'staff_leaderboard.json');
const data = JSON.parse(readFileSync(dataPath, 'utf8'));

const formatCoachName = (name) => name.trim().replace(/\s+/g, ' ');
const splitCoachNames = (title, value) => {
  if (title === 'hc') {
    return [value];
  }

  return value
    .split(/\s*(?:,|\/|\band\b)\s*/i)
    .map(formatCoachName)
    .filter(Boolean);
};

const addCoach = (coaches, school, year, title, name) => {
  if (!name || !name.trim()) {
    return;
  }

  const cleanName = formatCoachName(name);
  coaches[cleanName] ??= [];
  coaches[cleanName].push({ school, year: Number(year), title });
};

const buildCoachSet = () => {
  const coaches = {};

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

  Object.values(coaches).forEach((jobs) => jobs.sort((a, b) => a.year - b.year));
  return coaches;
};

const collectAssistantYears = (school, year) => {
  const roster = data[school]?.[String(year)];
  const assistants = {};

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

const firstHeadCoachJob = (jobs) => jobs.find((job) => job.title === 'hc') ?? null;

const uniqueHeadCoachStops = (jobs) => {
  const stops = new Set(
    jobs
      .filter((job) => job.title === 'hc')
      .map((job) => `${job.school}-${job.year}`),
  );
  return stops.size;
};

const buildTree = (rootCoach, coaches, datasetStartYear) => {
  if (!coaches[rootCoach]) {
    return [];
  }

  const queue = [{ id: rootCoach, years: [], cutoffYear: datasetStartYear }];
  const nodes = [];
  const visited = new Set();

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

    nodes.push({ ...currentCoach, history: coachJobs });

    const coachesToAdd = {};
    coachJobs.forEach((job) => {
      if (job.title !== 'hc' || currentCoach.cutoffYear > job.year) {
        return;
      }

      Object.entries(collectAssistantYears(job.school, job.year)).forEach(([coach, years]) => {
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

const getStaffSeasons = (root, children) => {
  const staffSeasons = new Map();

  children.forEach((child) => {
    child.years.forEach((year) => {
      const rootJob = root.history.find((job) => job.title === 'hc' && job.year === year);

      if (!rootJob) {
        return;
      }

      const key = `${rootJob.school}-${year}`;
      const season = staffSeasons.get(key) ?? {
        coaches: new Set(),
        school: rootJob.school,
        year,
      };
      season.coaches.add(child.id);
      staffSeasons.set(key, season);
    });
  });

  return Array.from(staffSeasons.values())
    .sort((a, b) => b.coaches.size - a.coaches.size || a.year - b.year || a.school.localeCompare(b.school))
    .map((season) => ({
      school: season.school,
      year: season.year,
      count: season.coaches.size,
      coaches: Array.from(season.coaches).sort((a, b) => a.localeCompare(b)),
    }));
};

const coaches = buildCoachSet();
const datasetStartYear = Math.min(
  ...Object.values(data).flatMap((seasons) => Object.keys(seasons).map(Number)),
);

const leaderboard = Object.entries(coaches)
  .filter(([, jobs]) => jobs.some((job) => job.title === 'hc'))
  .map(([coach, jobs]) => {
    const tree = buildTree(coach, coaches, datasetStartYear);
    const root = tree.find((node) => !node.parent);
    const directChildren = tree.filter((node) => node.parent === coach);
    const firstJob = firstHeadCoachJob(jobs);
    const staffSeasons = root ? getStaffSeasons(root, directChildren) : [];

    return {
      coach,
      totalDescendants: Math.max(0, tree.length - 1),
      directDescendants: directChildren.length,
      headCoachStops: uniqueHeadCoachStops(jobs),
      firstHeadCoachJob: firstJob
        ? {
            school: firstJob.school,
            year: firstJob.year,
          }
        : null,
      staffSeasons,
      topStaffs: staffSeasons.slice(0, 6),
    };
  })
  .sort(
    (a, b) =>
      b.totalDescendants - a.totalDescendants ||
      b.directDescendants - a.directDescendants ||
      a.coach.localeCompare(b.coach),
  )
  .map((entry, index) => ({ rank: index + 1, ...entry }));

const staffLeaderboard = leaderboard
  .flatMap((entry) =>
    entry.staffSeasons.map((season) => ({
      coach: entry.coach,
      coachRank: entry.rank,
      school: season.school,
      year: season.year,
      count: season.count,
      coaches: season.coaches,
    })),
  )
  .sort(
    (a, b) =>
      b.count - a.count ||
      a.year - b.year ||
      a.school.localeCompare(b.school) ||
      a.coach.localeCompare(b.coach),
  )
  .map((entry, index) => ({ rank: index + 1, ...entry }));

const publicLeaderboard = leaderboard.map(({ staffSeasons, ...entry }) => entry);

writeFileSync(outputPath, `${JSON.stringify(publicLeaderboard, null, 2)}\n`);
writeFileSync(staffOutputPath, `${JSON.stringify(staffLeaderboard, null, 2)}\n`);
console.log(`Generated ${leaderboard.length} coaching tree leaderboard rows.`);
console.log(`Generated ${staffLeaderboard.length} productive staff leaderboard rows.`);
