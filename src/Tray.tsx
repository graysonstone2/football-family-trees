import type { ReactNode } from 'react';
import { CoachJob, CoachTreeNode } from './functions/coachData';
import {
  formatRecordSummary,
  getRecordTone,
  getSurroundingRecordSummary,
} from './functions/schoolRecords';
import { getTeamLogo } from './functions/teamLogos';

type TrayProps = {
  mode: 'forward' | 'reverse';
  node: CoachTreeNode;
  parentNode?: CoachTreeNode | null;
  relatedCount: number;
  onClose: () => void;
  onSearchCoach: (coachName: string) => void;
};

const roleLabels: Record<string, string> = {
  hc: 'Head coach',
  dc: 'Defensive coordinator',
  oc: 'Offensive coordinator',
  other: 'Assistant',
};

const formatRole = (role: string) => roleLabels[role] ?? role.toUpperCase();

const formatYears = (years: number[]) => {
  if (!years.length) {
    return 'Origin coach';
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

const groupJobs = (history: CoachJob[]) => {
  const sortedJobs = [...history].sort((a, b) => {
    if (a.year !== b.year) {
      return a.year - b.year;
    }

    if (a.school !== b.school) {
      return a.school.localeCompare(b.school);
    }

    return a.title.localeCompare(b.title);
  });
  const groups: CoachJob[][] = [];

  sortedJobs.forEach((job) => {
    const currentGroup = groups[groups.length - 1];
    const previousJob = currentGroup?.[currentGroup.length - 1];
    const continuesCurrentGroup =
      previousJob &&
      previousJob.school === job.school &&
      previousJob.title === job.title &&
      job.year <= previousJob.year + 1;

    if (continuesCurrentGroup) {
      currentGroup.push(job);
      return;
    }

    groups.push([job]);
  });

  return groups.map((jobs) => ({
    school: jobs[0].school,
    title: jobs[0].title,
    years: Array.from(new Set(jobs.map((job) => job.year))).sort((a, b) => a - b),
  }));
};

const getOverlapJobs = (mode: TrayProps['mode'], node: CoachTreeNode, parentNode?: CoachTreeNode | null) => {
  if (!parentNode || node.years.length === 0) {
    return [];
  }

  const edgeYears = new Set(node.years);
  const nodeJobs = node.history.filter((job) => edgeYears.has(job.year));
  const parentJobs = parentNode.history.filter((job) => edgeYears.has(job.year));

  return nodeJobs
    .map((job) => ({
      coachJob: job,
      parentJob:
        parentJobs.find((parentJob) => {
          const expectedTitle = mode === 'forward' ? parentJob.title === 'hc' : job.title === 'hc';
          return expectedTitle && parentJob.school === job.school && parentJob.year === job.year;
        }),
    }))
    .filter((overlap) => overlap.parentJob);
};

const overlapKey = (job: Pick<CoachJob, 'school' | 'title'>, years: number[]) =>
  `${job.school}-${job.title}-${years.join(',')}`;

const getDataQualityHints = ({
  hasMissingOverlap,
  node,
}: {
  hasMissingOverlap: boolean;
  node: CoachTreeNode;
}) => {
  const hints: string[] = [];

  if (/[/(]|,|\binterim\b/i.test(node.id)) {
    hints.push('This coach name looks like it may include a split role, parenthetical note, or interim label.');
  }

  const jobsBySeason = new Map<string, CoachJob[]>();
  node.history.forEach((job) => {
    const key = `${job.school}-${job.year}`;
    jobsBySeason.set(key, [...(jobsBySeason.get(key) ?? []), job]);
  });

  const duplicateRoleStops = Array.from(jobsBySeason.values()).filter((jobs) => jobs.length > 1);
  if (duplicateRoleStops.length > 0) {
    hints.push('This coach appears in multiple roles at the same school in at least one season.');
  }

  const unusualTitles = Array.from(new Set(node.history.map((job) => job.title))).filter(
    (title) => !['hc', 'dc', 'oc', 'other'].includes(title),
  );
  if (unusualTitles.length > 0) {
    hints.push(`This history includes non-standard role labels: ${unusualTitles.join(', ')}.`);
  }

  if (hasMissingOverlap) {
    hints.push('The tree relationship has years attached, but the matching school staff row could not be reconstructed cleanly.');
  }

  return hints;
};

const Tray = ({ mode, node, parentNode, relatedCount, onClose, onSearchCoach }: TrayProps) => {
  const headCoachJobs = node.history.filter((job) => job.title === 'hc');
  const schools = Array.from(new Set(node.history.map((job) => job.school)));
  const latestJob = [...node.history].sort((a, b) => b.year - a.year)[0];
  const latestLogo = getTeamLogo(latestJob?.school);
  const overlapJobs = getOverlapJobs(mode, node, parentNode);
  const overlapYears = new Set(overlapJobs.map((overlap) => overlap.coachJob.year));
  const connectionGroups = groupJobs(overlapJobs.map((overlap) => overlap.coachJob));
  const dataQualityHints = getDataQualityHints({
    hasMissingOverlap: Boolean(parentNode && node.years.length > 0 && overlapJobs.length === 0),
    node,
  });
  const relationText =
    mode === 'reverse'
      ? node.parent
        ? `${node.parent} worked under ${node.id} in ${formatYears(node.years)}.`
        : 'Root of the selected mentor lineage.'
      : node.parent
        ? `Worked under ${node.parent} in ${formatYears(node.years)}.`
        : 'Root of the selected coaching tree.';

  return (
    <div className="flex h-full flex-col">
      <div className="tray-header border-b p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs font-black uppercase tracking-[0.2em] text-[var(--theme-accent)]">Coach card</p>
            <h2 className="mt-2 text-2xl font-black leading-tight">{node.id}</h2>
            <p className="mt-2 text-sm leading-6 text-[var(--theme-hero-muted)]">{relationText}</p>
            <button
              className="accent-button mt-4 rounded-md px-3 py-2 text-xs font-black uppercase tracking-wide transition"
              onClick={() => onSearchCoach(node.id)}
              type="button"
            >
              Open this tree
            </button>
          </div>
          <button
            aria-label="Close coach details"
            className="rounded-md border border-white/20 px-3 py-2 text-sm font-black transition hover:bg-white/10"
            onClick={onClose}
            type="button"
          >
            X
          </button>
        </div>
      </div>

      <div className="grid grid-cols-3 border-b border-[var(--theme-border)] bg-[var(--theme-surface-soft)] text-center">
        <Metric label={mode === 'reverse' ? 'Mentors' : 'Branches'} value={relatedCount} />
        <Metric label="HC jobs" value={headCoachJobs.length} />
        <Metric label="Schools" value={schools.length} />
      </div>

      <div className="space-y-6 overflow-auto p-5">
        {parentNode && (
          <section>
            <h3 className="section-title">Connection to parent</h3>
            <div className="rounded-lg border border-[var(--theme-accent)] bg-[var(--theme-accent-soft)] p-4 shadow-sm">
              <p className="text-sm font-black text-[var(--theme-primary)]">
                {mode === 'reverse'
                  ? `${parentNode.id} overlapped with ${node.id}`
                  : `${node.id} overlapped with ${parentNode.id}`}
              </p>
              {overlapJobs.length > 0 ? (
                <div className="mt-3 space-y-2">
                  {connectionGroups.map((job) => (
                    <div
                      className="rounded-md border border-[var(--theme-border)] bg-white px-3 py-2"
                      key={overlapKey(job, job.years)}
                    >
                      <div className="flex items-center gap-2">
                        {getTeamLogo(job.school) && (
                          <img
                            alt=""
                            className="team-logo team-logo-job"
                            loading="lazy"
                            src={getTeamLogo(job.school) ?? undefined}
                          />
                        )}
                        <p className="text-sm font-black text-[var(--theme-line)]">
                          {job.school}, {formatYears(job.years)}
                        </p>
                      </div>
                      <p className="mt-1 text-sm leading-5 text-[var(--theme-muted)]">
                        {mode === 'reverse'
                          ? `${node.id} was ${formatRole(job.title).toLowerCase()} while ${parentNode.id} was on staff.`
                          : `${node.id} was ${formatRole(job.title).toLowerCase()} while ${parentNode.id} was head coach.`}
                      </p>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="mt-2 text-sm leading-6 text-[var(--theme-muted)]">
                  The relationship years are recorded, but this dataset does not include a matching staff row for the selected coach.
                </p>
              )}
            </div>
          </section>
        )}

        <section>
          <h3 className="section-title">Current dataset signal</h3>
          <div className="rounded-lg border border-[var(--theme-border)] bg-[var(--theme-primary-soft)] p-4">
            <div className="flex items-center gap-3">
              {latestLogo && <img alt="" className="team-logo team-logo-signal" loading="lazy" src={latestLogo} />}
              <p className="text-sm font-bold text-[var(--theme-primary)]">
                {latestJob ? `${formatRole(latestJob.title)} at ${latestJob.school} in ${latestJob.year}` : 'No job history found.'}
              </p>
            </div>
            <p className="mt-2 text-sm leading-6 text-[var(--theme-muted)]">
              {headCoachJobs.length > 0
                ? `${node.id} has ${headCoachJobs.length} head coaching season${headCoachJobs.length === 1 ? '' : 's'} recorded.`
                : `${node.id} appears in staff history, but no head coaching seasons are recorded.`}
            </p>
          </div>
        </section>

        {dataQualityHints.length > 0 && (
          <section>
            <h3 className="section-title">Data quality notes</h3>
            <div className="space-y-2 rounded-lg border border-[var(--theme-border)] bg-[var(--theme-surface-soft)] p-4">
              {dataQualityHints.map((hint) => (
                <p className="text-sm leading-6 text-[var(--theme-muted)]" key={hint}>
                  {hint}
                </p>
              ))}
            </div>
          </section>
        )}

        {headCoachJobs.length > 0 && (
          <section>
            <h3 className="section-title">Head coaching stops</h3>
            <div className="space-y-2">
              {groupJobs(headCoachJobs).map((job) => {
                const surroundingSummary = getSurroundingRecordSummary(job.school, job.years);

                return (
                  <JobPill
                    highlighted={job.years.some((year) => overlapYears.has(year))}
                    key={overlapKey(job, job.years)}
                    school={job.school}
                    title={job.title}
                    years={job.years}
                  >
                    <div className="mt-3 grid grid-cols-3 gap-2">
                      <RecordMetric label="Before" summary={surroundingSummary.before} />
                      <RecordMetric label="During" summary={surroundingSummary.during} />
                      <RecordMetric label="After" summary={surroundingSummary.after} />
                    </div>
                  </JobPill>
                );
              })}
            </div>
          </section>
        )}

        <section>
          <h3 className="section-title">Full recorded history</h3>
          <div className="space-y-2">
            {groupJobs(node.history).map((job) => (
              <JobPill
                highlighted={job.years.some((year) => overlapYears.has(year))}
                key={overlapKey(job, job.years)}
                school={job.school}
                title={job.title}
                years={job.years}
              />
            ))}
          </div>
        </section>
      </div>
    </div>
  );
};

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="border-r border-[var(--theme-border)] px-3 py-4 last:border-r-0">
      <p className="text-xl font-black text-[var(--theme-primary)]">{value}</p>
      <p className="mt-1 text-[11px] font-black uppercase tracking-wide text-[var(--theme-muted)]">{label}</p>
    </div>
  );
}

function JobPill({
  children,
  highlighted = false,
  school,
  title,
  years,
}: {
  children?: ReactNode;
  highlighted?: boolean;
  school: string;
  title: string;
  years: number[];
}) {
  const logo = getTeamLogo(school);
  return (
    <div className={`rounded-lg border bg-white p-3 ${highlighted ? 'connection-highlight' : 'border-[var(--theme-border)]'}`}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          {logo && <img alt="" className="team-logo team-logo-job" loading="lazy" src={logo} />}
          <p className="min-w-0 font-black text-[var(--theme-ink)]">{school}</p>
        </div>
        <span className="rounded-full bg-[var(--theme-primary-soft)] px-2 py-1 text-xs font-black text-[var(--theme-line)]">
          {formatYears(years)}
        </span>
      </div>
      <p className="mt-1 text-sm text-[var(--theme-muted)]">{formatRole(title)}</p>
      {children}
    </div>
  );
}

function RecordMetric({
  label,
  summary,
}: {
  label: string;
  summary: ReturnType<typeof getSurroundingRecordSummary>['before'];
}) {
  return (
    <div className={`record-metric record-metric-${getRecordTone(summary?.pct)}`}>
      <p>{formatRecordSummary(summary)}</p>
      <span>{label}</span>
    </div>
  );
}

export default Tray;
