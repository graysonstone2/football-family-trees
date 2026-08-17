import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Cross-references every 2026 matchup against the coaching data so each game can
// be scored on how tangled the two sidelines are. Mentor relationships follow the
// same rules as buildReverseTree in src/functions/coachData.ts: a coach's mentors
// are the head coaches whose staffs they served on before their own first head
// coaching job.

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const data = JSON.parse(readFileSync(join(rootDir, 'src', 'data.json'), 'utf8'));
const schedule = JSON.parse(readFileSync(join(rootDir, 'src', 'schedule_2026.json'), 'utf8'));
const outputPath = join(rootDir, 'src', 'schedule_lineage_2026.json');

const SEASON = schedule.season;
const CORE_ROLES = ['hc', 'oc', 'dc'];
const ROLE_FACTOR = { hc: 1.5, oc: 1, dc: 1 };
const WEIGHT = { mentorProtege: 8, sharedStaff: 6, sharedMentor: 4, sharedAncestor: 1.5 };
const MAX_SHARED_PER_PAIR = 3;
const MAX_ANCESTORS_PER_PAIR = 2;
const MAX_CONNECTIONS_PER_GAME = 12;
const MAX_ANCESTOR_CARDS = 3;
// Pages list up to three co-coordinators per side. Capping the staff keeps a team
// with a thoroughly edited Wikipedia page from outranking everyone on volume.
const MAX_PER_ROLE = { hc: 1, oc: 2, dc: 2 };
// Mentor chains are transitive, so almost every coach eventually reaches Bobby
// Bowden. Two hops is the furthest a shared tree still says something.
const MAX_ANCESTOR_DEPTH = 2;

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

const namesFor = (title, value) =>
  (Array.isArray(value) ? value : typeof value === 'string' ? splitCoachNames(title, value) : [])
    .map(formatCoachName)
    .filter(Boolean);

const buildCoachSet = () => {
  const coaches = {};

  Object.entries(data).forEach(([school, seasons]) => {
    Object.entries(seasons).forEach(([year, roster]) => {
      Object.entries(roster).forEach(([title, value]) => {
        namesFor(title, value).forEach((coach) => {
          coaches[coach] ??= [];
          coaches[coach].push({ school, year: Number(year), title });
        });
      });
    });
  });

  Object.values(coaches).forEach((jobs) => jobs.sort((a, b) => a.year - b.year));
  return coaches;
};

const coaches = buildCoachSet();

const firstHeadCoachYear = (coach) => {
  const years = (coaches[coach] ?? [])
    .filter((job) => job.title === 'hc')
    .map((job) => job.year);
  return years.length ? Math.min(...years) : Number.POSITIVE_INFINITY;
};

const headCoachesOf = (school, year) =>
  namesFor('hc', data[school]?.[String(year)]?.hc);

/**
 * Head coaches this coach served under before their own first head coaching job,
 * mapped to the stops where that happened.
 */
const directMentorsOf = (() => {
  const cache = new Map();

  return (coach) => {
    const cached = cache.get(coach);
    if (cached) {
      return cached;
    }

    const cutoff = firstHeadCoachYear(coach);
    const mentors = new Map();

    (coaches[coach] ?? []).forEach((job) => {
      if (job.title === 'hc' || job.year >= cutoff) {
        return;
      }

      // A hire made for THIS season has not produced any shared history yet, and
      // counting it would put every new coordinator inside his new boss's tree
      // (and inside the tree of everyone his boss ever worked for).
      if (job.year >= SEASON) {
        return;
      }

      headCoachesOf(job.school, job.year).forEach((mentor) => {
        if (mentor === coach) {
          return;
        }

        const stops = mentors.get(mentor) ?? [];
        stops.push({ school: job.school, year: job.year, title: job.title });
        mentors.set(mentor, stops);
      });
    });

    cache.set(coach, mentors);
    return mentors;
  };
})();

/**
 * Mentor closure out to MAX_ANCESTOR_DEPTH hops: coach -> { hops, through }.
 *
 * `blocked` coaches can be reached but never traversed *through*. Without that,
 * "Pete Golding and Lane Kiffin both branch off Pat Hill" gets reported for a
 * game Kiffin is coaching in — and Golding's only route to Pat Hill is through
 * Kiffin, so the claim is just "Golding worked for Kiffin" wearing a hat.
 */
const ancestorsOf = (coach, blocked) => {
  const found = new Map();
  let frontier = [{ id: coach, through: null }];

  for (let depth = 1; depth <= MAX_ANCESTOR_DEPTH; depth += 1) {
    const next = [];

    frontier.forEach(({ id, through }) => {
      directMentorsOf(id).forEach((_stops, mentor) => {
        if (mentor === coach || found.has(mentor)) {
          return;
        }

        found.set(mentor, { hops: depth, through });
        if (!blocked.has(mentor)) {
          next.push({ id: mentor, through: through ?? mentor });
        }
      });
    });

    frontier = next;
  }

  return found;
};

const headCoachSeasons = (coach) =>
  new Set((coaches[coach] ?? []).filter((job) => job.title === 'hc').map((job) => job.year)).size;

const coreStaff = (school) => {
  const roster = data[school]?.[String(SEASON)];

  if (!roster) {
    return [];
  }

  return CORE_ROLES.flatMap((role) =>
    namesFor(role, roster[role])
      .slice(0, MAX_PER_ROLE[role])
      .map((coach) => ({ coach, role })),
  ).filter((entry, index, all) => all.findIndex((other) => other.coach === entry.coach) === index);
};

/** Everyone on a school's payroll this season, position coaches and analysts included. */
const wholeStaff = (school) => {
  const roster = data[school]?.[String(SEASON)] ?? {};
  return new Set(Object.entries(roster).flatMap(([role, value]) => namesFor(role, value)));
};

const stopKey = (stop) => `${stop.school}-${stop.year}`;

/**
 * Years as consecutive runs, matching formatYears in src/Tray.tsx. A coach who
 * left and came back reads "Maryland 2001-2004 & 2008-2010", never as one
 * unbroken decade he did not actually serve.
 */
const yearRuns = (years) => {
  const sorted = Array.from(new Set(years)).sort((a, b) => a - b);
  const runs = [];
  let start = sorted[0];
  let end = sorted[0];

  sorted.slice(1).forEach((year) => {
    if (year === end + 1) {
      end = year;
      return;
    }

    runs.push(start === end ? `${start}` : `${start}-${end}`);
    start = year;
    end = year;
  });
  runs.push(start === end ? `${start}` : `${start}-${end}`);

  return runs.join(' & ');
};

const stopLabel = (stops) => {
  const bySchool = new Map();
  stops.forEach((stop) => {
    bySchool.set(stop.school, [...(bySchool.get(stop.school) ?? []), stop.year]);
  });

  return Array.from(bySchool.entries())
    .map(([school, years]) => `${school} ${yearRuns(years)}`)
    .join(', ');
};

/**
 * @param inGame every coach employed by either team this season. A coach standing
 *   on one of these two sidelines is never a third-party "shared tree": the
 *   mentor-protege card already says it, and the whole staff has to be checked
 *   because a position coach or analyst can be a former head coach.
 */
const connectionsFor = (homeStaff, awayStaff, inGame) => {
  const connections = [];

  homeStaff.forEach((a) => {
    awayStaff.forEach((b) => {
      if (a.coach === b.coach) {
        return;
      }

      const aMentors = directMentorsOf(a.coach);
      const bMentors = directMentorsOf(b.coach);
      const factor = ROLE_FACTOR[a.role] * ROLE_FACTOR[b.role];

      // One coach hired the other: the sharpest version of a shared tree.
      const aUnderB = aMentors.get(b.coach);
      const bUnderA = bMentors.get(a.coach);

      if (aUnderB || bUnderA) {
        const protege = aUnderB ? a : b;
        const mentor = aUnderB ? b : a;
        const stops = aUnderB ?? bUnderA;
        connections.push({
          type: 'mentor-protege',
          a,
          b,
          via: mentor.coach,
          protege: protege.coach,
          stops: stopLabel(stops),
          weight: WEIGHT.mentorProtege * factor,
        });
      }

      const shared = [];
      aMentors.forEach((aStops, mentor) => {
        const bStops = bMentors.get(mentor);
        if (!bStops || inGame.has(mentor)) {
          return;
        }

        const aKeys = new Set(aStops.map(stopKey));
        const together = bStops.filter((stop) => aKeys.has(stopKey(stop)));
        shared.push({ mentor, aStops, bStops, together });
      });

      shared
        .sort((x, y) => y.together.length - x.together.length || headCoachSeasons(y.mentor) - headCoachSeasons(x.mentor))
        .slice(0, MAX_SHARED_PER_PAIR)
        .forEach((entry) => {
          const sameStaff = entry.together.length > 0;
          connections.push({
            type: sameStaff ? 'shared-staff' : 'shared-mentor',
            a,
            b,
            via: entry.mentor,
            aStops: stopLabel(entry.aStops),
            bStops: stopLabel(entry.bStops),
            together: sameStaff ? stopLabel(entry.together) : null,
            weight: (sameStaff ? WEIGHT.sharedStaff : WEIGHT.sharedMentor) * factor,
          });
        });

      if (shared.length > 0) {
        return;
      }

      // No shared boss, but both sit inside the same coach's tree a hop or two up.
      const aAncestors = ancestorsOf(a.coach, inGame);
      const bAncestors = ancestorsOf(b.coach, inGame);
      Array.from(aAncestors.keys())
        .filter((name) => bAncestors.has(name) && !inGame.has(name))
        .map((name) => {
          const from = aAncestors.get(name);
          const to = bAncestors.get(name);
          return { name, hops: from.hops + to.hops, aThrough: from.through, bThrough: to.through };
        })
        .sort((x, y) => x.hops - y.hops || headCoachSeasons(y.name) - headCoachSeasons(x.name) || x.name.localeCompare(y.name))
        .slice(0, MAX_ANCESTORS_PER_PAIR)
        .forEach(({ name, hops, aThrough, bThrough }) => {
          connections.push({
            type: 'shared-ancestor',
            a,
            b,
            via: name,
            hops,
            // The intermediate hire on each side, so the claim can be checked.
            aThrough,
            bThrough,
            weight: WEIGHT.sharedAncestor * factor,
          });
        });
    });
  });

  return connections.sort((x, y) => y.weight - x.weight || x.via.localeCompare(y.via));
};

const roleWord = { hc: 'HC', oc: 'OC', dc: 'DC' };

const headlineFor = (game, connections) => {
  if (connections.length === 0) {
    return null;
  }

  const top = connections[0];

  if (top.type === 'mentor-protege') {
    const mentorIsHome = top.via === top.a.coach;
    const mentor = mentorIsHome ? top.a : top.b;
    const protege = mentorIsHome ? top.b : top.a;
    const mentorSide = mentorIsHome ? game.home : game.away;
    const protegeSide = mentorIsHome ? game.away : game.home;
    return `${mentor.coach} (${mentorSide} ${roleWord[mentor.role]}) coached ${protege.coach} (${protegeSide} ${roleWord[protege.role]}) at ${top.stops}.`;
  }

  if (top.type === 'shared-staff') {
    return `${top.a.coach} and ${top.b.coach} shared ${top.via}'s staff at ${top.together}.`;
  }

  if (top.type === 'shared-mentor') {
    return `${top.a.coach} (${top.aStops}) and ${top.b.coach} (${top.bStops}) both worked for ${top.via}.`;
  }

  const route = (coach, through) => (through ? `${coach} via ${through}` : coach);
  return `${route(top.a.coach, top.aThrough)} and ${route(top.b.coach, top.bThrough)} both trace back to ${top.via}.`;
};

/**
 * What the game detail shows. Two-hop tree links are the weakest evidence and the
 * most repetitive, so they get their own quota instead of filling the whole card.
 */
const shortlist = (connections) => {
  const strong = connections.filter((c) => c.type !== 'shared-ancestor');
  const seenTree = new Set();
  // One card per tree: "both branch off Pat Hill" five times over is not five facts.
  const faint = connections.filter((c) => {
    if (c.type !== 'shared-ancestor' || seenTree.has(c.via)) {
      return false;
    }

    seenTree.add(c.via);
    return true;
  });

  return [
    ...strong.slice(0, MAX_CONNECTIONS_PER_GAME),
    ...faint.slice(0, Math.max(0, Math.min(MAX_ANCESTOR_CARDS, MAX_CONNECTIONS_PER_GAME - strong.length))),
  ];
};

const tierFor = (score) => {
  if (score >= 40) return 'reunion';
  if (score >= 20) return 'family';
  if (score >= 8) return 'cousins';
  if (score > 0) return 'thread';
  return 'strangers';
};

const patriarchs = new Map();
const results = [];

schedule.games.forEach((game) => {
  const homeStaff = game.homeTracked ? coreStaff(game.home) : [];
  const awayStaff = game.awayTracked ? coreStaff(game.away) : [];

  if (homeStaff.length === 0 || awayStaff.length === 0) {
    results.push({ id: game.id, score: 0, tier: 'unknown', staffed: false, connections: [] });
    return;
  }

  const connections = connectionsFor(homeStaff, awayStaff, new Set([
    ...wholeStaff(game.home),
    ...wholeStaff(game.away),
  ]));
  const score = Math.round(connections.reduce((sum, c) => sum + c.weight, 0) * 10) / 10;
  const viaTotals = new Map();
  connections.forEach((c) => {
    if (c.type === 'mentor-protege') {
      return;
    }

    const entry = viaTotals.get(c.via) ?? { links: 0, weight: 0, best: 0 };
    entry.links += 1;
    entry.weight += c.weight;
    entry.best = Math.max(entry.best, c.weight);
    viaTotals.set(c.via, entry);
  });

  viaTotals.forEach(({ links }, via) => {
    const entry = patriarchs.get(via) ?? { coach: via, gameCount: 0, linkCount: 0, gameIds: [] };
    entry.gameCount += 1;
    entry.linkCount += links;
    entry.gameIds.push(game.id);
    patriarchs.set(via, entry);
  });

  results.push({
    id: game.id,
    score,
    tier: tierFor(score),
    staffed: true,
    connectionCount: connections.length,
    headline: headlineFor(game, connections),
    // Closest relationship first, so one shared boss outranks a pile of two-hop ties.
    trees: Array.from(viaTotals.entries())
      .sort((x, y) => y[1].best - x[1].best || y[1].weight - x[1].weight || x[0].localeCompare(y[0]))
      .slice(0, 6)
      .map(([via, totals]) => ({ coach: via, links: totals.links })),
    connections: shortlist(connections).map((c) => ({
      type: c.type,
      via: c.via,
      a: c.a,
      b: c.b,
      aStops: c.aStops ?? null,
      bStops: c.bStops ?? null,
      together: c.together ?? null,
      stops: c.stops ?? null,
      protege: c.protege ?? null,
      hops: c.hops ?? null,
      aThrough: c.aThrough ?? null,
      bThrough: c.bThrough ?? null,
      weight: Math.round(c.weight * 10) / 10,
    })),
  });
});

const ranked = [...results]
  .filter((entry) => entry.staffed && entry.score > 0)
  .sort((x, y) => y.score - x.score || y.connectionCount - x.connectionCount || x.id.localeCompare(y.id));

const rankById = new Map(ranked.map((entry, index) => [entry.id, index + 1]));
results.forEach((entry) => {
  entry.rank = rankById.get(entry.id) ?? null;
});

const staffs = Object.fromEntries(
  Object.keys(data)
    .map((school) => [school, coreStaff(school)])
    .filter(([, staff]) => staff.length > 0),
);

const output = {
  season: SEASON,
  scoring: {
    roles: CORE_ROLES,
    roleFactor: ROLE_FACTOR,
    weights: WEIGHT,
    note: 'Head coaches and coordinators only, so schools with thin Wikipedia staff pages are not penalised.',
  },
  games: Object.fromEntries(results.map(({ id, ...rest }) => [id, rest])),
  patriarchs: Array.from(patriarchs.values())
    .sort((x, y) => y.gameCount - x.gameCount || y.linkCount - x.linkCount || x.coach.localeCompare(y.coach))
    .map((entry) => ({ ...entry, gameIds: entry.gameIds.sort() })),
  staffs,
};

writeFileSync(outputPath, `${JSON.stringify(output, null, 1)}\n`);

const scored = results.filter((entry) => entry.staffed);
console.log(`Scored ${scored.length} of ${schedule.games.length} 2026 games for shared coaching lineage.`);
console.log(`Top matchups: ${ranked.slice(0, 5).map((entry) => `${entry.id} (${entry.score})`).join(', ')}`);
console.log(`Tracked coaching trees touching both sidelines: ${output.patriarchs.length}`);
