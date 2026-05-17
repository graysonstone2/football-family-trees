import { toBlob } from 'html-to-image';
import { FormEvent, ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import Tray from './Tray';
import {
  CoachTreeNode,
  buildReverseTree,
  buildTree,
  findCoachName,
  getCoachNames,
  getDatasetSummary,
} from './functions/coachData';
import { trackEvent, trackPageView } from './functions/analytics';
import { getRecordPct, getRecordTone, getSchoolRecord } from './functions/schoolRecords';
import { getTeamLogo } from './functions/teamLogos';

type TreeNodeWithChildren = CoachTreeNode & {
  depth: number;
  children: TreeNodeWithChildren[];
};

const DEFAULT_COACH = 'Nick Saban';
type TreeMode = 'forward' | 'reverse';
type InitialParams = {
  coach: string;
  mode: TreeMode;
  school: string;
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
    return { coach: DEFAULT_COACH, mode: 'forward', school: '' };
  }

  const params = new URLSearchParams(window.location.search);
  const mode = params.get('mode') === 'reverse' ? 'reverse' : 'forward';

  return {
    coach: params.get('coach') || DEFAULT_COACH,
    mode,
    school: params.get('school') || '',
  };
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

  const sorted = [...years].sort((a, b) => a - b);
  return sorted.length === 1 ? String(sorted[0]) : `${sorted[0]}-${sorted[sorted.length - 1]}`;
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

const getMostProductiveStaffs = (root?: TreeNodeWithChildren | null) => {
  if (!root) {
    return [];
  }

  const staffSeasons = new Map<
    string,
    {
      coaches: Set<string>;
      school: string;
      year: number;
    }
  >();

  root.children.forEach((child) => {
    child.years.forEach((year) => {
      const rootJob = root.history.find((job) => job.title === 'hc' && job.year === year);

      if (!rootJob) {
        return;
      }

      const key = `${rootJob.school}-${year}`;
      const season = staffSeasons.get(key) ?? {
        coaches: new Set<string>(),
        school: rootJob.school,
        year,
      };
      season.coaches.add(child.id);
      staffSeasons.set(key, season);
    });
  });

  return Array.from(staffSeasons.values())
    .sort((a, b) => b.coaches.size - a.coaches.size || a.year - b.year || a.school.localeCompare(b.school))
    .slice(0, 6);
};

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
  const coachNames = useMemo(() => getCoachNames(), []);
  const summary = useMemo(() => getDatasetSummary(), []);
  const initialParams = useMemo(() => getInitialParams(), []);
  const initialTree = useMemo(
    () => (initialParams.mode === 'forward' ? buildTree(initialParams.coach) : buildReverseTree(initialParams.coach)),
    [initialParams],
  );
  const [mode, setMode] = useState<TreeMode>(initialParams.mode);
  const [coach, setCoach] = useState(initialParams.coach);
  const [treeData, setTreeData] = useState<CoachTreeNode[] | null>(initialTree);
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
  const [isFocused, setIsFocused] = useState(false);
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
  const productiveStaffs = useMemo(() => getMostProductiveStaffs(forwardHierarchy), [forwardHierarchy]);
  const bestBranchDebuts = useMemo(() => getBestBranchDebuts(forwardHierarchy), [forwardHierarchy]);
  const comparisonStats = useMemo(
    () => ({
      descendants: forwardHierarchy ? countChildren(forwardHierarchy) : 0,
      directDescendants: forwardHierarchy?.children.length ?? 0,
      directMentors: reverseHierarchy?.children.length ?? 0,
      mentors: reverseHierarchy ? countChildren(reverseHierarchy) : 0,
    }),
    [forwardHierarchy, reverseHierarchy],
  );
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
    if (selectedSchool) {
      params.set('school', selectedSchool);
    }

    const nextUrl = `${window.location.pathname}${params.toString() ? `?${params.toString()}` : ''}`;
    window.history.replaceState(null, '', nextUrl);
    trackPageView(`${window.location.pathname}${window.location.search}`);
  }, [coach, mode, selectedSchool]);

  const suggestions = useMemo(() => {
    const query = coach.trim().toLowerCase();

    if (query.length < 2) {
      return [];
    }

    return coachNames
      .filter((name) => name.toLowerCase().startsWith(query))
      .concat(coachNames.filter((name) => !name.toLowerCase().startsWith(query) && name.toLowerCase().includes(query)))
      .slice(0, 8);
  }, [coach, coachNames]);

  const runSearch = (coachName = coach, selectedMode = mode) => {
    setIsFocused(false);
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

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    runSearch();
    setIsFocused(false);
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
    <main className="min-h-screen bg-[#f6f2e8] text-[#1d2528]">
      <section className="border-b border-[#d9d0bf] bg-[#12343b] text-white">
        <div className="mx-auto flex max-w-7xl flex-col gap-6 px-5 py-7 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="flex items-center gap-3">
              <img alt="" className="h-10 w-10 rounded-lg" src="/football-family-trees.svg" />
              <div>
                <p className="text-sm font-black uppercase tracking-[0.2em] text-[#e0b25d]">
                  Football Family Trees
                </p>
                <p className="mt-1 text-xs font-black uppercase tracking-[0.24em] text-[#9bbcff]">
                  A StoneG App
                </p>
              </div>
            </div>
            <h1 className="mt-3 max-w-3xl text-4xl font-black leading-tight sm:text-5xl">
              Trace coaching trees in both directions.
            </h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-[#dce7e7]">
              Search any coach, then follow either the assistants who became head coaches or the mentors whose staffs shaped them.
            </p>
          </div>

          <form className="relative w-full max-w-xl" onSubmit={handleSubmit}>
            <div className="mb-3 grid grid-cols-2 rounded-lg border border-white/15 bg-white/10 p-1">
              <ModeButton active={mode === 'forward'} onClick={() => changeMode('forward')}>
                Descendants
              </ModeButton>
              <ModeButton active={mode === 'reverse'} onClick={() => changeMode('reverse')}>
                Mentors
              </ModeButton>
            </div>
            <label className="mb-2 block text-sm font-semibold text-[#f7e6bd]" htmlFor="coach-search">
              Coach search
            </label>
            <div className="flex gap-2 rounded-lg bg-white p-2 shadow-xl shadow-black/20">
              <input
                id="coach-search"
                className="min-w-0 flex-1 rounded-md border border-transparent px-4 py-3 text-base font-semibold text-[#1d2528] outline-none focus:border-[#e0b25d]"
                placeholder="Try Nick Saban, Mack Brown, Urban Meyer..."
                value={coach}
                onBlur={() => window.setTimeout(() => setIsFocused(false), 120)}
                onChange={(event) => {
                  setCoach(event.target.value);
                  setIsFocused(true);
                }}
                onFocus={() => setIsFocused(true)}
              />
              <button
                className="rounded-md bg-[#d0452f] px-5 py-3 text-sm font-black uppercase tracking-wide text-white transition hover:bg-[#a93424] focus:outline-none focus:ring-2 focus:ring-[#e0b25d]"
                type="submit"
              >
                Search
              </button>
            </div>

            {isFocused && suggestions.length > 0 && (
              <div className="absolute left-0 right-0 top-full z-30 mt-2 overflow-hidden rounded-lg border border-[#d9d0bf] bg-white text-[#1d2528] shadow-2xl">
                {suggestions.map((suggestion) => (
                  <button
                    className="flex w-full items-center justify-between px-4 py-3 text-left text-sm font-semibold hover:bg-[#f6f2e8]"
                    key={suggestion}
                    onMouseDown={() => runSearch(suggestion)}
                    type="button"
                  >
                    <span>{suggestion}</span>
                    <span className="text-xs uppercase tracking-wide text-[#668085]">select</span>
                  </button>
                ))}
              </div>
            )}
          </form>
        </div>
      </section>

      <section className="mx-auto grid max-w-7xl gap-4 px-5 py-5 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Coaches indexed" value={summary.coachCount.toLocaleString()} />
        <Stat label="Schools covered" value={summary.schoolCount.toLocaleString()} />
        <Stat label="Seasons" value={summary.seasonRange} />
        <Stat label="Head coaches" value={summary.headCoachCount.toLocaleString()} />
      </section>

      <section className="mx-auto grid max-w-7xl gap-5 px-5 pb-8 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-h-[620px] overflow-hidden rounded-lg border border-[#d9d0bf] bg-white shadow-sm">
          <div className="flex flex-col gap-3 border-b border-[#e7decd] bg-[#fffaf0] p-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-xl font-black">
                {visibleHierarchy ? `${visibleHierarchy.id}'s ${modeCopy[mode].title}` : 'No tree selected'}
              </h2>
              <p className="mt-1 text-sm text-[#58676a]">
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
                  className="rounded-md border border-[#d9d0bf] bg-white px-3 py-2 text-sm font-bold text-[#12343b]"
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
                  className="rounded-md bg-[#d0452f] px-3 py-2 text-sm font-black uppercase tracking-wide text-white transition hover:bg-[#a93424] disabled:cursor-wait disabled:bg-[#a96f65]"
                  disabled={isExporting}
                  onClick={exportTree}
                  type="button"
                >
                  {isExporting ? 'Exporting...' : 'Export PNG'}
                </button>
                <label className="flex items-center gap-2 rounded-md border border-[#d9d0bf] bg-white px-3 py-2 text-sm font-black text-[#12343b]">
                  <input
                    checked={directOnly}
                    className="h-4 w-4 accent-[#d0452f]"
                    onChange={(event) => setDirectOnly(event.target.checked)}
                    type="checkbox"
                  />
                  Direct only
                </label>
              </div>
              {exportStatus && <p className="text-xs font-bold text-[#58676a]">{exportStatus}</p>}
            </div>
          </div>

          <div className="tree-canvas overflow-auto p-6" ref={canvasRef}>
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
                  <p className="mt-2 max-w-md text-sm text-[#58676a]">
                    Pick a coach from autocomplete or try another spelling.
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>

        <aside className="rounded-lg border border-[#d9d0bf] bg-white shadow-sm">
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
              <p className="mt-2 text-sm leading-6 text-[#58676a]">
                Select any tree card to see coaching stops, mentorship years, schools, and later head coaching roles.
              </p>
            </div>
          )}
        </aside>
      </section>

      <section className="mx-auto grid max-w-7xl gap-4 px-5 pb-8 xl:grid-cols-3">
        <InsightPanel title="Most productive staffs">
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
                        <p className="font-black text-[#12343b]">
                          {season.school}, {season.year}
                        </p>
                        <p className="truncate text-xs font-bold text-[#58676a]">
                          {Array.from(season.coaches).slice(0, 4).join(', ')}
                        </p>
                        {record && (
                          <div className="mt-2 flex flex-wrap items-center gap-2">
                            <span className={`record-chip record-chip-${getRecordTone(getRecordPct(record))}`}>
                              {record.record}
                            </span>
                            {record.record_note && (
                              <span className="text-xs font-black uppercase tracking-wide text-[#8f3b2d]">
                                {record.record_note}
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                    <span className="insight-count">{season.coaches.size}</span>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="text-sm leading-6 text-[#58676a]">No direct descendant staff seasons found.</p>
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
                        <p className="font-black text-[#12343b]">{entry.coach}</p>
                        <p className="truncate text-xs font-bold text-[#58676a]">
                          {entry.job.school}, {entry.job.year}
                        </p>
                      </div>
                    </div>
                    <span className="text-sm font-black text-[#8f3b2d]">{entry.record.record}</span>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="text-sm leading-6 text-[#58676a]">No descendant debut records found.</p>
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
    </main>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-[#d9d0bf] bg-white px-5 py-4 shadow-sm">
      <p className="text-xs font-black uppercase tracking-wide text-[#668085]">{label}</p>
      <p className="mt-2 text-2xl font-black text-[#12343b]">{value}</p>
    </div>
  );
}

function InsightPanel({ children, title }: { children: ReactNode; title: string }) {
  return (
    <div className="rounded-lg border border-[#d9d0bf] bg-white p-4 shadow-sm">
      <h2 className="mb-3 text-sm font-black uppercase tracking-wide text-[#12343b]">{title}</h2>
      {children}
    </div>
  );
}

function ComparisonMetric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-[#e7decd] bg-[#fffaf0] p-3">
      <p className="text-2xl font-black text-[#12343b]">{value}</p>
      <p className="mt-1 text-[11px] font-black uppercase tracking-wide text-[#668085]">{label}</p>
    </div>
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
      className={`rounded-md px-4 py-2 text-sm font-black uppercase tracking-wide transition ${
        active ? 'bg-[#e0b25d] text-[#12343b]' : 'text-white hover:bg-white/10'
      }`}
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  );
}

function Badge({ children }: { children: ReactNode }) {
  return <span className="rounded-full bg-[#12343b] px-3 py-2 text-white">{children}</span>;
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
