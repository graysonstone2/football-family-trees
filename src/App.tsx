import { toBlob } from 'html-to-image';
import { CSSProperties, FormEvent, ReactNode, useEffect, useId, useMemo, useRef, useState } from 'react';
import Tray from './Tray';
import {
  CoachTreeNode,
  buildReverseTree,
  buildTree,
  findCoachName,
  getDatasetSummary,
} from './functions/coachData';
import { trackEvent, trackPageView } from './functions/analytics';
import { getRecordPct, getRecordTone, getSchoolRecord } from './functions/schoolRecords';
import { DEFAULT_THEME, TEAM_THEMES, getThemeVars } from './functions/teamThemes';
import { getTeamLogo } from './functions/teamLogos';
import staffLeaderboard from './staff_leaderboard.json';
import treeLeaderboard from './tree_leaderboard.json';

type TreeNodeWithChildren = CoachTreeNode & {
  depth: number;
  children: TreeNodeWithChildren[];
};

const DEFAULT_COACH = 'Nick Saban';
const ERA_OPTIONS = [
  { label: 'All eras', value: '' },
  { label: '1990s', value: '1990' },
  { label: '2000s', value: '2000' },
  { label: '2010s', value: '2010' },
  { label: '2020s', value: '2020' },
];
const MIN_DESCENDANT_OPTIONS = [
  { label: 'All tree sizes', value: '0' },
  { label: '10+ descendants', value: '10' },
  { label: '25+ descendants', value: '25' },
  { label: '50+ descendants', value: '50' },
];
const MIN_STAFF_OPTIONS = [
  { label: 'All staff sizes', value: '0' },
  { label: '2+ future HCs', value: '2' },
  { label: '3+ future HCs', value: '3' },
  { label: '4+ future HCs', value: '4' },
  { label: '5 future HCs', value: '5' },
];
type TreeMode = 'forward' | 'reverse';
type AppPage = 'tree' | 'biggest-trees' | 'productive-staffs';
type InitialParams = {
  coach: string;
  mode: TreeMode;
  page: AppPage;
  school: string;
};

type TreeLeaderboardEntry = {
  coach: string;
  directDescendants: number;
  firstHeadCoachJob: {
    school: string;
    year: number;
  } | null;
  headCoachStops: number;
  rank: number;
  totalDescendants: number;
  topStaffs: Array<{
    coaches: string[];
    count: number;
    school: string;
    year: number;
  }>;
};

type StaffLeaderboardEntry = {
  coach: string;
  coachRank: number;
  coaches: string[];
  count: number;
  rank: number;
  school: string;
  year: number;
};

const modeCopy = {
  forward: {
    action: 'Trace coaching tree',
    badge: 'descendants',
    empty: 'no later head-coach descendants were found',
    message: 'Direct staff branches are shown first; each card can open the coach detail panel.',
    plural: 'later head coaches',
    title: 'tree',
  },
  reverse: {
    action: 'Trace mentor lineage',
    badge: 'mentors',
    empty: 'no earlier head-coach mentors were found',
    message: 'Mentor branches show head coaches this coach worked under before becoming a head coach.',
    plural: 'mentor coaches',
    title: 'mentor tree',
  },
} satisfies Record<TreeMode, Record<string, string>>;

const groupByParent = (nodes: CoachTreeNode[]) => {
  const childrenByParent = new Map<string, CoachTreeNode[]>();

  nodes.forEach((node) => {
    if (!node.parent) {
      return;
    }

    childrenByParent.set(node.parent, [...(childrenByParent.get(node.parent) ?? []), node]);
  });

  return childrenByParent;
};

const getInitialParams = (): InitialParams => {
  if (typeof window === 'undefined') {
    return { coach: DEFAULT_COACH, mode: 'forward', page: 'tree', school: '' };
  }

  const params = new URLSearchParams(window.location.search);
  const mode = params.get('mode') === 'reverse' ? 'reverse' : 'forward';
  const pageParam = params.get('page');
  const page = pageParam === 'biggest-trees' || pageParam === 'productive-staffs' ? pageParam : 'tree';

  return {
    coach: params.get('coach') || DEFAULT_COACH,
    mode,
    page,
    school: params.get('school') || '',
  };
};

const getInitialTheme = () => {
  if (typeof window === 'undefined') {
    return DEFAULT_THEME.school;
  }

  const savedTheme = window.localStorage.getItem('team-theme');
  return TEAM_THEMES.some((theme) => theme.school === savedTheme) ? savedTheme ?? DEFAULT_THEME.school : DEFAULT_THEME.school;
};

const buildHierarchy = (nodes: CoachTreeNode[]) => {
  const childrenByParent = groupByParent(nodes);
  const root = nodes.find((node) => !node.parent) ?? nodes[0];

  const attachChildren = (node: CoachTreeNode, depth: number): TreeNodeWithChildren => ({
    ...node,
    depth,
    children: (childrenByParent.get(node.id) ?? [])
      .sort((a, b) => b.years.length - a.years.length || a.id.localeCompare(b.id))
      .map((child) => attachChildren(child, depth + 1)),
  });

  return root ? attachChildren(root, 0) : null;
};

const countChildren = (node: TreeNodeWithChildren): number =>
  node.children.reduce((total, child) => total + 1 + countChildren(child), 0);

const flattenHierarchy = (node: TreeNodeWithChildren): TreeNodeWithChildren[] => [
  node,
  ...node.children.flatMap(flattenHierarchy),
];

const getHeadCoachJobs = (node: CoachTreeNode) => node.history.filter((job) => job.title === 'hc');

const getSchools = (node: CoachTreeNode) =>
  Array.from(new Set(node.history.map((job) => job.school))).slice(0, 3);

const nodeHasSchool = (node: CoachTreeNode, school: string) =>
  node.history.some((job) => job.school === school);

const filterHierarchy = (node: TreeNodeWithChildren, school: string): TreeNodeWithChildren | null => {
  if (!school) {
    return node;
  }

  const children = node.children
    .map((child) => filterHierarchy(child, school))
    .filter((child): child is TreeNodeWithChildren => Boolean(child));

  if (node.depth === 0 || nodeHasSchool(node, school) || children.length > 0) {
    return { ...node, children };
  }

  return null;
};

const limitHierarchyDepth = (node: TreeNodeWithChildren, maxDepth: number): TreeNodeWithChildren => ({
  ...node,
  children:
    node.depth >= maxDepth
      ? []
      : node.children.map((child) => limitHierarchyDepth(child, maxDepth)),
});

const formatYears = (years: number[]) => {
  if (years.length === 0) {
    return 'Root coach';
  }

  const sorted = Array.from(new Set(years)).sort((a, b) => a - b);
  const ranges: string[] = [];
  let rangeStart = sorted[0];
  let rangeEnd = sorted[0];

  sorted.slice(1).forEach((year) => {
    if (year === rangeEnd + 1) {
      rangeEnd = year;
      return;
    }

    ranges.push(rangeStart === rangeEnd ? String(rangeStart) : `${rangeStart}-${rangeEnd}`);
    rangeStart = year;
    rangeEnd = year;
  });

  ranges.push(rangeStart === rangeEnd ? String(rangeStart) : `${rangeStart}-${rangeEnd}`);

  return ranges.join(', ');
};

const getEdgeLabel = (mode: TreeMode, node: CoachTreeNode, parentNode?: CoachTreeNode | null) => {
  if (node.years.length === 0) {
    return '';
  }

  const years = new Set(node.years);
  const relationshipJobs =
    mode === 'reverse'
      ? node.history.filter((job) => job.title === 'hc' && years.has(job.year))
      : (parentNode?.history ?? []).filter((job) => job.title === 'hc' && years.has(job.year));
  const schoolNames = Array.from(new Set(relationshipJobs.map((job) => job.school))).slice(0, 2);

  return `${schoolNames.join(' / ') || 'Overlap'}, ${formatYears(node.years)}`;
};

const makeFilename = (coachName: string, mode: TreeMode) =>
  `${coachName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}-${mode}-tree.png`;

const yearToEra = (year: number) => `${Math.floor(year / 10) * 10}`;

const getBestBranchDebuts = (root?: TreeNodeWithChildren | null) => {
  if (!root) {
    return [];
  }

  return flattenHierarchy(root)
    .filter((node) => node.depth > 0)
    .map((node) => {
      const firstHeadCoachJob = getHeadCoachJobs(node)[0];
      const record = firstHeadCoachJob ? getSchoolRecord(firstHeadCoachJob.school, firstHeadCoachJob.year) : null;

      return firstHeadCoachJob && record
        ? {
            coach: node.id,
            job: firstHeadCoachJob,
            record,
          }
        : null;
    })
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
    .sort((a, b) => getRecordPct(b.record) - getRecordPct(a.record) || b.record.wins - a.record.wins || a.coach.localeCompare(b.coach))
    .slice(0, 6);
};

function App() {
  const summary = useMemo(() => getDatasetSummary(), []);
  const initialParams = useMemo(() => getInitialParams(), []);
  const initialTree = useMemo(
    () => (initialParams.mode === 'forward' ? buildTree(initialParams.coach) : buildReverseTree(initialParams.coach)),
    [initialParams],
  );
  const [mode, setMode] = useState<TreeMode>(initialParams.mode);
  const [coach, setCoach] = useState(initialParams.coach);
  const [treeData, setTreeData] = useState<CoachTreeNode[] | null>(initialTree);
  const [page, setPage] = useState<AppPage>(initialParams.page);
  const [selectedNode, setSelectedNode] = useState<CoachTreeNode | null>(initialTree?.[0] ?? null);
  const [message, setMessage] = useState(
    initialTree && initialTree.length > 1
      ? `${initialTree[0].id}'s ${modeCopy[initialParams.mode].title} includes ${initialTree.length - 1} ${modeCopy[initialParams.mode].plural} in this dataset.`
      : '',
  );
  const [selectedSchool, setSelectedSchool] = useState(initialParams.school);
  const [exportStatus, setExportStatus] = useState('');
  const [isExporting, setIsExporting] = useState(false);
  const [directOnly, setDirectOnly] = useState(false);
  const [treeLeaderboardMinDescendants, setTreeLeaderboardMinDescendants] = useState('0');
  const [treeLeaderboardSchool, setTreeLeaderboardSchool] = useState('');
  const [staffLeaderboardEra, setStaffLeaderboardEra] = useState('');
  const [staffLeaderboardMinCount, setStaffLeaderboardMinCount] = useState('0');
  const [staffLeaderboardSchool, setStaffLeaderboardSchool] = useState('');
  const [selectedThemeSchool, setSelectedThemeSchool] = useState(getInitialTheme);
  const canvasRef = useRef<HTMLDivElement>(null);
  const exportRef = useRef<HTMLDivElement>(null);

  const hierarchy = useMemo(() => (treeData ? buildHierarchy(treeData) : null), [treeData]);
  const forwardHierarchy = useMemo(() => {
    const forwardTree = buildTree(coach);
    return forwardTree ? buildHierarchy(forwardTree) : null;
  }, [coach]);
  const reverseHierarchy = useMemo(() => {
    const reverseTree = buildReverseTree(coach);
    return reverseTree ? buildHierarchy(reverseTree) : null;
  }, [coach]);
  const schoolOptions = useMemo(
    () =>
      treeData
        ? Array.from(new Set(treeData.flatMap((node) => node.history.map((job) => job.school)))).sort((a, b) =>
            a.localeCompare(b),
          )
        : [],
    [treeData],
  );
  const visibleHierarchy = useMemo(
    () => {
      const filtered = hierarchy ? filterHierarchy(hierarchy, selectedSchool) : null;
      return filtered && directOnly ? limitHierarchyDepth(filtered, 1) : filtered;
    },
    [directOnly, hierarchy, selectedSchool],
  );
  const selectedTreeCoach = hierarchy?.id ?? coach;
  const selectedLeaderboardEntry = useMemo(
    () => (treeLeaderboard as TreeLeaderboardEntry[]).find((entry) => entry.coach === selectedTreeCoach) ?? null,
    [selectedTreeCoach],
  );
  const productiveStaffs = selectedLeaderboardEntry?.topStaffs ?? [];
  const bestBranchDebuts = useMemo(() => getBestBranchDebuts(forwardHierarchy), [forwardHierarchy]);
  const biggestTrees = useMemo(() => treeLeaderboard as TreeLeaderboardEntry[], []);
  const productiveStaffLeaderboard = useMemo(() => staffLeaderboard as StaffLeaderboardEntry[], []);
  const treeLeaderboardSchoolOptions = useMemo(
    () =>
      Array.from(
        new Set(
          biggestTrees
            .map((entry) => entry.firstHeadCoachJob?.school)
            .filter((school): school is string => Boolean(school)),
        ),
      ).sort((a, b) => a.localeCompare(b)),
    [biggestTrees],
  );
  const staffLeaderboardSchoolOptions = useMemo(
    () => Array.from(new Set(productiveStaffLeaderboard.map((entry) => entry.school))).sort((a, b) => a.localeCompare(b)),
    [productiveStaffLeaderboard],
  );
  const filteredBiggestTrees = useMemo(() => {
    const minDescendants = Number(treeLeaderboardMinDescendants);

    return biggestTrees.filter((entry) => {
      const schoolMatches = !treeLeaderboardSchool || entry.firstHeadCoachJob?.school === treeLeaderboardSchool;
      return schoolMatches && entry.totalDescendants >= minDescendants;
    });
  }, [biggestTrees, treeLeaderboardMinDescendants, treeLeaderboardSchool]);
  const filteredProductiveStaffLeaderboard = useMemo(() => {
    const minCount = Number(staffLeaderboardMinCount);

    return productiveStaffLeaderboard.filter((entry) => {
      const schoolMatches = !staffLeaderboardSchool || entry.school === staffLeaderboardSchool;
      const eraMatches = !staffLeaderboardEra || yearToEra(entry.year) === staffLeaderboardEra;
      return schoolMatches && eraMatches && entry.count >= minCount;
    });
  }, [productiveStaffLeaderboard, staffLeaderboardEra, staffLeaderboardMinCount, staffLeaderboardSchool]);
  const comparisonStats = useMemo(
    () => ({
      descendants: forwardHierarchy ? countChildren(forwardHierarchy) : 0,
      directDescendants: forwardHierarchy?.children.length ?? 0,
      directMentors: reverseHierarchy?.children.length ?? 0,
      mentors: reverseHierarchy ? countChildren(reverseHierarchy) : 0,
    }),
    [forwardHierarchy, reverseHierarchy],
  );
  const selectedTheme = useMemo(
    () => TEAM_THEMES.find((theme) => theme.school === selectedThemeSchool) ?? DEFAULT_THEME,
    [selectedThemeSchool],
  );
  const themeVars = useMemo(() => getThemeVars(selectedTheme) as CSSProperties, [selectedTheme]);
  const selectedTreeNode = useMemo(() => {
    if (!hierarchy || !selectedNode) {
      return null;
    }

    const stack = [hierarchy];
    while (stack.length) {
      const next = stack.pop();
      if (next?.id === selectedNode.id) {
        return next;
      }

      if (next) {
        stack.push(...next.children);
      }
    }

    return null;
  }, [hierarchy, selectedNode]);

  useEffect(() => {
    window.requestAnimationFrame(() => {
      const canvas = canvasRef.current;

      if (!canvas) {
        return;
      }

      canvas.scrollLeft = Math.max(0, (canvas.scrollWidth - canvas.clientWidth) / 2);
    });
  }, [visibleHierarchy?.id, selectedSchool]);

  useEffect(() => {
    if (selectedSchool && !schoolOptions.includes(selectedSchool)) {
      setSelectedSchool('');
    }
  }, [schoolOptions, selectedSchool]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const params = new URLSearchParams();
    if (coach) {
      params.set('coach', coach);
    }
    if (mode !== 'forward') {
      params.set('mode', mode);
    }
    if (page !== 'tree') {
      params.set('page', page);
    }
    if (selectedSchool) {
      params.set('school', selectedSchool);
    }

    const nextUrl = `${window.location.pathname}${params.toString() ? `?${params.toString()}` : ''}`;
    window.history.replaceState(null, '', nextUrl);
    trackPageView(`${window.location.pathname}${window.location.search}`);
  }, [coach, mode, page, selectedSchool]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    window.localStorage.setItem('team-theme', selectedThemeSchool);
  }, [selectedThemeSchool]);

  const runSearch = (coachName = coach, selectedMode = mode) => {
    const exactName = findCoachName(coachName);

    if (!exactName) {
      setTreeData(null);
      setSelectedNode(null);
      setMessage(`No coach named "${coachName}" was found in this dataset.`);
      return;
    }

    const nextTree = selectedMode === 'forward' ? buildTree(exactName) : buildReverseTree(exactName);
    trackEvent('coach_search', {
      coach_name: exactName,
      tree_mode: selectedMode,
      result_count: nextTree ? nextTree.length - 1 : 0,
    });
    setCoach(exactName);
    setTreeData(nextTree);
    setSelectedNode(nextTree?.[0] ?? null);
    setMessage(
      nextTree && nextTree.length > 1
        ? `${exactName}'s ${modeCopy[selectedMode].title} includes ${nextTree.length - 1} ${modeCopy[selectedMode].plural} in this dataset.`
        : `${exactName} is present, but ${modeCopy[selectedMode].empty}.`,
    );
  };

  const changeMode = (nextMode: TreeMode) => {
    setMode(nextMode);
    runSearch(coach, nextMode);
  };

  const openCoachTree = (coachName: string) => {
    setPage('tree');
    setMode('forward');
    setSelectedSchool('');
    setDirectOnly(false);
    runSearch(coachName, 'forward');
    window.requestAnimationFrame(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    runSearch();
  };

  const exportTree = async () => {
    const target = exportRef.current;

    if (!target || !visibleHierarchy) {
      return;
    }

    setIsExporting(true);
    setExportStatus('Rendering PNG...');

    try {
      await document.fonts?.ready;

      const width = target.scrollWidth;
      const height = target.scrollHeight;
      const blob = await toBlob(target, {
        backgroundColor: '#ffffff',
        cacheBust: true,
        height,
        pixelRatio: 2,
        style: {
          height: `${height}px`,
          width: `${width}px`,
        },
        width,
      });

      if (!blob) {
        throw new Error('The browser did not return image data.');
      }

      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.download = makeFilename(coach, mode);
      link.href = url;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      trackEvent('tree_export_png', {
        coach_name: coach,
        tree_mode: mode,
        school_filter: selectedSchool || 'all',
      });
      setExportStatus('PNG downloaded.');
    } catch (error) {
      console.error(error);
      setExportStatus('Export failed. Try a smaller filtered tree.');
    } finally {
      setIsExporting(false);
    }
  };

  const descendants = visibleHierarchy ? countChildren(visibleHierarchy) : 0;
  const headCoachStops = visibleHierarchy ? getHeadCoachJobs(visibleHierarchy).length : 0;
  const selectedDescendants = selectedTreeNode ? countChildren(selectedTreeNode) : 0;
  const selectedParentNode = selectedNode?.parent
    ? treeData?.find((node) => node.id === selectedNode.parent) ?? null
    : null;

  return (
    <main className="app-shell min-h-screen" style={themeVars}>
      <section className="hero-section border-b">
        <div className="site-container relative flex flex-col gap-6 py-7 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="flex items-center gap-3">
              <img alt="" className="h-10 w-10 rounded-lg" src="/football-family-trees.svg" />
              <div>
                <p className="brand-title text-sm font-black uppercase tracking-[0.2em]">
                  Football Family Trees
                </p>
                <p className="stoneg-kicker mt-1 text-xs font-black uppercase tracking-[0.24em]">
                  A StoneG App
                </p>
              </div>
            </div>
            <h1 className="mt-3 max-w-3xl text-4xl font-black leading-tight sm:text-5xl">
              {page === 'tree' && 'Trace coaching trees in both directions.'}
              {page === 'biggest-trees' && 'The biggest coaching trees.'}
              {page === 'productive-staffs' && 'The most productive staffs.'}
            </h1>
            <p className="hero-copy mt-3 max-w-2xl text-sm leading-6">
              {page === 'tree' &&
                'Search any coach, then follow either the assistants who became head coaches or the mentors whose staffs shaped them.'}
              {page === 'biggest-trees' &&
                'Rank every head coach by total descendant branches, then jump straight into the full tree.'}
              {page === 'productive-staffs' &&
                'Find the single-season staffs with the most assistants who became head coaches in this dataset.'}
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <PageButton active={page === 'tree'} onClick={() => setPage('tree')}>
                Tree search
              </PageButton>
              <PageButton active={page === 'biggest-trees'} onClick={() => setPage('biggest-trees')}>
                Biggest trees
              </PageButton>
              <PageButton active={page === 'productive-staffs'} onClick={() => setPage('productive-staffs')}>
                Productive staffs
              </PageButton>
            </div>
          </div>

          <div className="header-actions flex w-full max-w-xs items-end justify-between gap-3 self-end lg:absolute lg:right-5 lg:top-5 lg:w-auto lg:max-w-none lg:justify-end">
            <a
              className="support-link rounded-md px-3 py-2 text-xs font-black uppercase tracking-wide"
              href="https://buymeacoffee.com/stoneg"
              onClick={() => trackEvent('support_link_click')}
              rel="noreferrer"
              target="_blank"
            >
              Buy me a coffee
            </a>
            <div className="theme-control w-full max-w-[190px]">
              <label className="mb-1 block text-[10px] font-black uppercase tracking-wide text-[var(--theme-accent)]" htmlFor="team-theme">
                Team Theme
              </label>
              <select
                className="theme-select w-full rounded-md px-2 py-2 text-xs font-black uppercase tracking-wide"
                id="team-theme"
                onChange={(event) => setSelectedThemeSchool(event.target.value)}
                value={selectedThemeSchool}
              >
                {TEAM_THEMES.map((theme) => (
                  <option key={theme.school} value={theme.school}>
                    {theme.school}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {page === 'tree' && (
            <form className="relative w-full max-w-xl" onSubmit={handleSubmit}>
              <div className="mb-3 grid grid-cols-2 rounded-lg border border-white/15 bg-white/10 p-1">
                <ModeButton active={mode === 'forward'} onClick={() => changeMode('forward')}>
                  Descendants
                </ModeButton>
                <ModeButton active={mode === 'reverse'} onClick={() => changeMode('reverse')}>
                  Mentors
                </ModeButton>
              </div>
              <label className="mb-2 block text-sm font-semibold text-[var(--theme-accent)]" htmlFor="coach-search">
                Coach search
              </label>
              <div className="flex gap-2 rounded-lg bg-white p-2 shadow-xl shadow-black/20">
                <input
                  id="coach-search"
                  className="min-w-0 flex-1 rounded-md border border-transparent px-4 py-3 text-base font-semibold text-[var(--theme-ink)] outline-none focus:border-[var(--theme-accent)]"
                  placeholder="Try Nick Saban, Mack Brown, Urban Meyer..."
                  value={coach}
                  onChange={(event) => {
                    setCoach(event.target.value);
                  }}
                />
                <button
                  className="primary-button rounded-md px-5 py-3 text-sm font-black uppercase tracking-wide transition focus:outline-none focus:ring-2 focus:ring-[var(--theme-accent)]"
                  type="submit"
                >
                  Search
                </button>
              </div>
            </form>
          )}
        </div>
      </section>

      <section className="site-container grid gap-4 py-5 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Coaches indexed" value={summary.coachCount.toLocaleString()} />
        <Stat label="Schools covered" value={summary.schoolCount.toLocaleString()} />
        <Stat label="Seasons" value={summary.seasonRange} />
        <Stat label="Head coaches" value={summary.headCoachCount.toLocaleString()} />
      </section>

      {page === 'biggest-trees' && (
        <section className="site-container pb-8">
          <div className="rounded-lg border border-[var(--theme-border)] bg-white p-4 shadow-sm">
            <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <h2 className="text-xl font-black text-[var(--theme-primary)]">Biggest trees</h2>
                <p className="mt-1 text-sm text-[var(--theme-muted)]">
                  Showing {filteredBiggestTrees.length.toLocaleString()} of {biggestTrees.length.toLocaleString()} ranked head coaches by total descendant branches.
                </p>
              </div>
              <button className="primary-button rounded-md px-4 py-2 text-sm font-black uppercase tracking-wide" onClick={() => setPage('tree')} type="button">
                Back to tree
              </button>
            </div>
            <div className="leaderboard-filters">
              <FilterSelect
                label="First HC school"
                onChange={setTreeLeaderboardSchool}
                options={[
                  { label: 'All schools', value: '' },
                  ...treeLeaderboardSchoolOptions.map((school) => ({ label: school, value: school })),
                ]}
                value={treeLeaderboardSchool}
              />
              <FilterSelect
                label="Tree size"
                onChange={setTreeLeaderboardMinDescendants}
                options={MIN_DESCENDANT_OPTIONS}
                value={treeLeaderboardMinDescendants}
              />
            </div>
            <div className="leaderboard-list">
              {filteredBiggestTrees.map((entry) => (
                <LeaderboardRow entry={entry} key={entry.coach} onOpenTree={openCoachTree} />
              ))}
            </div>
          </div>
        </section>
      )}

      {page === 'productive-staffs' && (
        <section className="site-container pb-8">
          <div className="rounded-lg border border-[var(--theme-border)] bg-white p-4 shadow-sm">
            <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <h2 className="text-xl font-black text-[var(--theme-primary)]">Most productive staffs</h2>
                <p className="mt-1 text-sm text-[var(--theme-muted)]">
                  Showing {filteredProductiveStaffLeaderboard.length.toLocaleString()} of {productiveStaffLeaderboard.length.toLocaleString()} staff seasons ranked by future head coaches produced.
                </p>
              </div>
              <button className="primary-button rounded-md px-4 py-2 text-sm font-black uppercase tracking-wide" onClick={() => setPage('tree')} type="button">
                Back to tree
              </button>
            </div>
            <div className="leaderboard-filters">
              <FilterSelect
                label="School"
                onChange={setStaffLeaderboardSchool}
                options={[
                  { label: 'All schools', value: '' },
                  ...staffLeaderboardSchoolOptions.map((school) => ({ label: school, value: school })),
                ]}
                value={staffLeaderboardSchool}
              />
              <FilterSelect
                label="Era"
                onChange={setStaffLeaderboardEra}
                options={ERA_OPTIONS}
                value={staffLeaderboardEra}
              />
              <FilterSelect
                label="Staff output"
                onChange={setStaffLeaderboardMinCount}
                options={MIN_STAFF_OPTIONS}
                value={staffLeaderboardMinCount}
              />
            </div>
            <div className="leaderboard-list">
              {filteredProductiveStaffLeaderboard.map((entry) => (
                <StaffLeaderboardRow entry={entry} key={`${entry.coach}-${entry.school}-${entry.year}`} onOpenTree={openCoachTree} />
              ))}
            </div>
          </div>
        </section>
      )}

      {page === 'tree' && (
        <>
      <section className="site-container grid gap-5 pb-8 xl:grid-cols-[minmax(0,1fr)_360px] 2xl:grid-cols-[minmax(0,1fr)_420px]">
        <div className="flex min-h-[620px] flex-col overflow-hidden rounded-lg border border-[var(--theme-border)] bg-white shadow-sm">
          <div className="flex flex-col gap-3 border-b border-[var(--theme-border)] bg-[var(--theme-surface-soft)] p-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-xl font-black">
                {visibleHierarchy ? `${visibleHierarchy.id}'s ${modeCopy[mode].title}` : 'No tree selected'}
              </h2>
              <p className="mt-1 text-sm text-[var(--theme-muted)]">
                {message || modeCopy[mode].message}
              </p>
            </div>
            <div className="flex flex-col gap-3 sm:items-end">
              <div className="flex gap-2 text-xs font-black uppercase tracking-wide">
                <Badge>
                  {descendants} {modeCopy[mode].badge}
                </Badge>
                <Badge>{headCoachStops} HC stops</Badge>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <select
                  aria-label="Filter tree by school"
                  className="rounded-md border border-[var(--theme-border)] bg-white px-3 py-2 text-sm font-bold text-[var(--theme-primary)]"
                  onChange={(event) => setSelectedSchool(event.target.value)}
                  value={selectedSchool}
                >
                  <option value="">All schools</option>
                  {schoolOptions.map((school) => (
                    <option key={school} value={school}>
                      {school}
                    </option>
                  ))}
                </select>
                <button
                  className="primary-button rounded-md px-3 py-2 text-sm font-black uppercase tracking-wide transition disabled:cursor-wait disabled:opacity-60"
                  disabled={isExporting}
                  onClick={exportTree}
                  type="button"
                >
                  {isExporting ? 'Exporting...' : 'Export PNG'}
                </button>
                <label className="flex items-center gap-2 rounded-md border border-[var(--theme-border)] bg-white px-3 py-2 text-sm font-black text-[var(--theme-primary)]">
                  <input
                    checked={directOnly}
                    className="h-4 w-4 accent-[var(--theme-line)]"
                    onChange={(event) => setDirectOnly(event.target.checked)}
                    type="checkbox"
                  />
                  Direct only
                </label>
              </div>
              {exportStatus && <p className="text-xs font-bold text-[var(--theme-muted)]">{exportStatus}</p>}
            </div>
          </div>

          <div className="tree-canvas flex-1 overflow-auto p-6" ref={canvasRef}>
            {visibleHierarchy ? (
              <div className="tree-export-surface" ref={exportRef}>
                <TreeBranch
                  mode={mode}
                  node={visibleHierarchy}
                  onSelect={setSelectedNode}
                  selectedId={selectedNode?.id}
                  selectedParentId={selectedNode?.parent}
                />
              </div>
            ) : (
              <div className="flex min-h-[420px] items-center justify-center text-center">
                <div>
                  <p className="text-2xl font-black">No tree to show.</p>
                  <p className="mt-2 max-w-md text-sm text-[var(--theme-muted)]">
                    Pick a coach from autocomplete or try another spelling.
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>

        <aside className="rounded-lg border border-[var(--theme-border)] bg-white shadow-sm">
          {selectedNode ? (
            <Tray
              mode={mode}
              node={selectedNode}
              parentNode={selectedParentNode}
              relatedCount={selectedDescendants}
              onClose={() => setSelectedNode(null)}
              onSearchCoach={(coachName) => runSearch(coachName)}
            />
          ) : (
            <div className="p-6">
              <h2 className="text-xl font-black">Coach details</h2>
              <p className="mt-2 text-sm leading-6 text-[var(--theme-muted)]">
                Select any tree card to see coaching stops, mentorship years, schools, and later head coaching roles.
              </p>
            </div>
          )}
        </aside>
      </section>

      <section className="site-container grid gap-4 pb-8 lg:grid-cols-3">
        <InsightPanel title={`Most productive staffs for ${selectedTreeCoach}`}>
          {productiveStaffs.length > 0 ? (
            <div className="space-y-2">
              {productiveStaffs.map((season) => {
                const logo = getTeamLogo(season.school);
                const record = getSchoolRecord(season.school, season.year);

                return (
                  <div className="insight-row" key={`${season.school}-${season.year}`}>
                    <div className="flex min-w-0 items-center gap-3">
                      {logo && <img alt="" className="team-logo team-logo-job" loading="lazy" src={logo} />}
                      <div className="min-w-0">
                        <p className="font-black text-[var(--theme-primary)]">
                          {season.school}, {season.year}
                        </p>
                        <p className="truncate text-xs font-bold text-[var(--theme-muted)]">
                          {season.coaches.slice(0, 4).join(', ')}
                        </p>
                        {record && (
                          <div className="mt-2 flex flex-wrap items-center gap-2">
                            <span className={`record-chip record-chip-${getRecordTone(getRecordPct(record))}`}>
                              {record.record}
                            </span>
                            {record.record_note && (
                              <span className="text-xs font-black uppercase tracking-wide text-[var(--theme-line)]">
                                {record.record_note}
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                    <span className="insight-count">{season.count}</span>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="text-sm leading-6 text-[var(--theme-muted)]">No direct descendant staff seasons found.</p>
          )}
        </InsightPanel>

        <InsightPanel title="Best branch debuts">
          {bestBranchDebuts.length > 0 ? (
            <div className="space-y-2">
              {bestBranchDebuts.map((entry) => {
                const logo = getTeamLogo(entry.job.school);

                return (
                  <div className="insight-row" key={`${entry.coach}-${entry.job.school}-${entry.job.year}`}>
                    <div className="flex min-w-0 items-center gap-3">
                      {logo && <img alt="" className="team-logo team-logo-job" loading="lazy" src={logo} />}
                      <div className="min-w-0">
                        <p className="font-black text-[var(--theme-primary)]">{entry.coach}</p>
                        <p className="truncate text-xs font-bold text-[var(--theme-muted)]">
                          {entry.job.school}, {entry.job.year}
                        </p>
                      </div>
                    </div>
                    <span className="text-sm font-black text-[var(--theme-line)]">{entry.record.record}</span>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="text-sm leading-6 text-[var(--theme-muted)]">No descendant debut records found.</p>
          )}
        </InsightPanel>

        <InsightPanel title="Both directions">
          <div className="grid grid-cols-2 gap-3">
            <ComparisonMetric label="Descendants" value={comparisonStats.descendants} />
            <ComparisonMetric label="Direct kids" value={comparisonStats.directDescendants} />
            <ComparisonMetric label="Mentors" value={comparisonStats.mentors} />
            <ComparisonMetric label="Direct mentors" value={comparisonStats.directMentors} />
          </div>
        </InsightPanel>
      </section>
        </>
      )}
    </main>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-[var(--theme-border)] bg-white px-5 py-4 shadow-sm">
      <p className="text-xs font-black uppercase tracking-wide text-[var(--theme-muted)]">{label}</p>
      <p className="mt-2 text-2xl font-black text-[var(--theme-primary)]">{value}</p>
    </div>
  );
}

function InsightPanel({ children, title }: { children: ReactNode; title: string }) {
  return (
    <div className="rounded-lg border border-[var(--theme-border)] bg-white p-4 shadow-sm">
      <h2 className="mb-3 text-sm font-black uppercase tracking-wide text-[var(--theme-primary)]">{title}</h2>
      {children}
    </div>
  );
}

function LeaderboardRow({ entry, onOpenTree }: { entry: TreeLeaderboardEntry; onOpenTree: (coach: string) => void }) {
  const logo = getTeamLogo(entry.firstHeadCoachJob?.school ?? '');
  const topStaff = entry.topStaffs[0];

  return (
    <button className="leaderboard-row" onClick={() => onOpenTree(entry.coach)} type="button">
      <span className="leaderboard-rank leaderboard-rank-large">{entry.rank}</span>
      {logo && <img alt="" className="team-logo team-logo-signal" loading="lazy" src={logo} />}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-lg font-black text-[var(--theme-primary)]">{entry.coach}</span>
        <span className="mt-1 block text-sm font-bold text-[var(--theme-muted)]">
          {entry.firstHeadCoachJob
            ? `${entry.firstHeadCoachJob.school}, ${entry.firstHeadCoachJob.year}`
            : `${entry.headCoachStops} HC stops`}
        </span>
      </span>
      <span className="leaderboard-metrics">
        <span>
          <strong>{entry.totalDescendants}</strong>
          <em>descendants</em>
        </span>
        <span>
          <strong>{entry.directDescendants}</strong>
          <em>direct</em>
        </span>
        <span>
          <strong>{topStaff?.count ?? 0}</strong>
          <em>{topStaff ? `${topStaff.school} ${topStaff.year}` : 'top staff'}</em>
        </span>
      </span>
    </button>
  );
}

function FilterSelect({
  label,
  onChange,
  options,
  value,
}: {
  label: string;
  onChange: (value: string) => void;
  options: Array<{ label: string; value: string }>;
  value: string;
}) {
  const id = useId();

  return (
    <div className="leaderboard-filter">
      <label htmlFor={id}>{label}</label>
      <select id={id} onChange={(event) => onChange(event.target.value)} value={value}>
        {options.map((option) => (
          <option key={`${label}-${option.value}`} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function StaffLeaderboardRow({ entry, onOpenTree }: { entry: StaffLeaderboardEntry; onOpenTree: (coach: string) => void }) {
  const logo = getTeamLogo(entry.school);
  const record = getSchoolRecord(entry.school, entry.year);

  return (
    <button className="leaderboard-row" onClick={() => onOpenTree(entry.coach)} type="button">
      <span className="leaderboard-rank leaderboard-rank-large">{entry.rank}</span>
      {logo && <img alt="" className="team-logo team-logo-signal" loading="lazy" src={logo} />}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-lg font-black text-[var(--theme-primary)]">
          {entry.school}, {entry.year}
        </span>
        <span className="mt-1 block text-sm font-bold text-[var(--theme-muted)]">
          {entry.coach}'s staff
        </span>
        <span className="mt-1 block text-xs font-bold leading-5 text-[var(--theme-muted)]">
          {entry.coaches.join(', ')}
        </span>
      </span>
      <span className="leaderboard-metrics">
        <span>
          <strong>{entry.count}</strong>
          <em>future HCs</em>
        </span>
        <span>
          <strong>{entry.coachRank}</strong>
          <em>tree rank</em>
        </span>
        <span>
          <strong>{record?.record ?? 'N/A'}</strong>
          <em>record</em>
        </span>
      </span>
    </button>
  );
}

function ComparisonMetric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-[var(--theme-border)] bg-[var(--theme-surface-soft)] p-3">
      <p className="text-2xl font-black text-[var(--theme-primary)]">{value}</p>
      <p className="mt-1 text-[11px] font-black uppercase tracking-wide text-[var(--theme-muted)]">{label}</p>
    </div>
  );
}

function PageButton({
  active,
  children,
  onClick,
}: {
  active: boolean;
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      className={`page-button rounded-md px-3 py-2 text-xs font-black uppercase tracking-wide transition ${
        active ? 'page-button-active' : ''
      }`}
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  );
}

function ModeButton({
  active,
  children,
  onClick,
}: {
  active: boolean;
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      className={`mode-button rounded-md px-4 py-2 text-sm font-black uppercase tracking-wide transition ${
        active ? 'mode-button-active' : ''
      }`}
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  );
}

function Badge({ children }: { children: ReactNode }) {
  return <span className="tree-badge rounded-full px-3 py-2">{children}</span>;
}

function TreeBranch({
  node,
  onSelect,
  mode,
  parentNode,
  selectedId,
  selectedParentId,
}: {
  mode: TreeMode;
  node: TreeNodeWithChildren;
  onSelect: (node: CoachTreeNode) => void;
  parentNode?: TreeNodeWithChildren | null;
  selectedId?: string;
  selectedParentId?: string;
}) {
  return (
    <ul className={node.depth === 0 ? 'tree-root' : 'tree-children'}>
      <li>
        {node.depth > 0 && <span className="edge-label">{getEdgeLabel(mode, node, parentNode)}</span>}
        <CoachCard
          node={node}
          onSelect={onSelect}
          parentHighlighted={selectedParentId === node.id}
          selected={selectedId === node.id}
        />
        {node.children.length > 0 && (
          <div className="tree-child-wrap">
            {node.children.map((child) => (
              <TreeBranch
                key={`${child.parent}-${child.id}`}
                mode={mode}
                node={child}
                onSelect={onSelect}
                parentNode={node}
                selectedId={selectedId}
                selectedParentId={selectedParentId}
              />
            ))}
          </div>
        )}
      </li>
    </ul>
  );
}

function CoachCard({
  node,
  onSelect,
  parentHighlighted,
  selected,
}: {
  node: TreeNodeWithChildren;
  onSelect: (node: CoachTreeNode) => void;
  parentHighlighted: boolean;
  selected: boolean;
}) {
  const headCoachJobs = getHeadCoachJobs(node);
  const firstHeadCoachJob = headCoachJobs[0];
  const schools = getSchools(node);
  const primarySchool = firstHeadCoachJob?.school ?? schools[0];
  const primaryLogo = getTeamLogo(primarySchool);

  return (
    <button
      className={`coach-card ${selected ? 'coach-card-selected' : ''} ${parentHighlighted ? 'coach-card-parent' : ''}`}
      onClick={() => onSelect(node)}
      type="button"
    >
      <span className="flex items-start justify-between gap-3">
        <span className="coach-card-depth">Level {node.depth}</span>
        {primaryLogo && (
          <img
            alt=""
            className="team-logo team-logo-card"
            loading="lazy"
            src={primaryLogo}
          />
        )}
      </span>
      <span className="coach-card-name">{node.id}</span>
      <span className="coach-card-meta">
        {firstHeadCoachJob ? `${firstHeadCoachJob.school}, ${firstHeadCoachJob.year}` : 'Head coach'}
      </span>
      <span className="coach-card-bottom">
        <span className="coach-card-years">{formatYears(node.years)}</span>
        {node.children.length > 0 && <span className="coach-card-count">{countChildren(node)}</span>}
      </span>
    </button>
  );
}

export default App;
