import { ReactNode, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { trackEvent } from './functions/analytics';
import {
  CONFERENCE_OPTIONS,
  CONNECTION_LABELS,
  LineageConnection,
  LineageTier,
  PATRIARCHS,
  RANKED_GAMES,
  ROLE_LABELS,
  ROLE_SHORT,
  SCHEDULE_GAMES,
  SCHEDULE_SEASON,
  ScheduleGame,
  ScheduleView,
  StaffMember,
  TEAM_OPTIONS,
  TIER_META,
  WEEKS,
  describeSite,
  formatGameDate,
  formatWeekRange,
  getConference,
  getCoreStaff,
  getCurrentWeek,
  getGame,
  getLineage,
  tierForGame,
} from './functions/schedule';
import { getTeamLogo } from './functions/teamLogos';

type ScheduleProps = {
  onChangePatriarch: (coach: string) => void;
  onChangeView: (view: ScheduleView) => void;
  onOpenCoachTree: (coach: string) => void;
  onSelectGame: (gameId: string | null) => void;
  patriarch: string;
  selectedGameId: string | null;
  view: ScheduleView;
};

const VIEW_COPY: Record<ScheduleView, { blurb: string; title: string }> = {
  week: {
    title: 'Week by week',
    blurb: 'Every 2026 game, scored on how much coaching family sits on the far sideline.',
  },
  ranked: {
    title: 'Most tangled games',
    blurb: 'The 2026 matchups where the two coaching trees fold back into each other.',
  },
};

// Only trees with real reach are worth offering as a filter.
const TREE_FILTER_OPTIONS = PATRIARCHS.filter((entry) => entry.gameCount >= 3);

const TIER_ORDER: LineageTier[] = ['reunion', 'family', 'cousins', 'thread', 'strangers'];

function TierChip({ tier, score }: { tier: LineageTier; score: number }) {
  const meta = TIER_META[tier];

  return (
    <span className={`tangle-chip record-chip record-chip-${meta.tone}`}>
      {meta.label}
      {score > 0 && <em>{score}</em>}
    </span>
  );
}

function TeamLine({ school, tracked }: { school: string; tracked: boolean }) {
  const logo = getTeamLogo(school);
  const conference = getConference(school);

  return (
    <span className="game-team">
      {logo ? (
        <img alt="" className="team-logo team-logo-job" loading="lazy" src={logo} />
      ) : (
        <span className="game-team-blank" />
      )}
      <span className="min-w-0">
        <span className="block truncate font-black text-[var(--theme-primary)]">{school}</span>
        <span className="block truncate text-[10px] font-black uppercase tracking-wide text-[var(--theme-muted)]">
          {tracked ? conference ?? 'FBS' : 'Outside this dataset'}
        </span>
      </span>
    </span>
  );
}

function GameRow({
  game,
  onSelect,
  rank,
  selected,
  via,
}: {
  game: ScheduleGame;
  onSelect: () => void;
  rank?: number | null;
  selected: boolean;
  /** When listing one coach's games, say what HIS branch does here. */
  via?: string;
}) {
  const lineage = getLineage(game.id);
  const tier = tierForGame(game, lineage);
  const viaTree = via ? lineage.trees?.find((tree) => tree.coach === via) : undefined;
  const headline = via
    ? viaTree
      ? `${viaTree.links} ${viaTree.links === 1 ? 'link' : 'links'} through ${via} in this matchup.`
      : `Both sidelines sit inside ${via}'s tree.`
    : lineage.headline;

  return (
    <button
      aria-label={`${game.away} ${game.neutralSite ? 'vs' : 'at'} ${game.home}, ${formatGameDate(
        game.date,
      )}: ${TIER_META[tier].label}`}
      className={`game-row leaderboard-row ${selected ? 'game-row-selected' : ''}`}
      onClick={onSelect}
      type="button"
    >
      {rank ? <span className="leaderboard-rank leaderboard-rank-large">{rank}</span> : null}
      <span className="game-row-main">
        <span className="game-row-teams">
          <TeamLine school={game.away} tracked={game.awayTracked} />
          <span className="game-row-vs">{game.neutralSite ? 'vs' : 'at'}</span>
          <TeamLine school={game.home} tracked={game.homeTracked} />
        </span>
        <span className="game-row-meta">
          <span>{formatGameDate(game.date)}</span>
          {game.kickoff && <span>{game.kickoff}</span>}
          {game.tv && <span>{game.tv}</span>}
          {game.name && <span className="game-row-name">{game.name}</span>}
          {!game.conferenceGame && <span>Non-conference</span>}
        </span>
        {headline && <span className="game-row-headline">{headline}</span>}
      </span>
      <span className="game-row-score">
        <TierChip score={lineage.score} tier={tier} />
        {lineage.staffed && lineage.connectionCount ? (
          <span className="game-row-links">
            {lineage.connectionCount} {lineage.connectionCount === 1 ? 'link' : 'links'}
          </span>
        ) : null}
      </span>
    </button>
  );
}

function StaffColumn({
  onOpenCoachTree,
  school,
  side,
  tracked,
}: {
  onOpenCoachTree: (coach: string) => void;
  school: string;
  side: string;
  tracked: boolean;
}) {
  const staff = tracked ? getCoreStaff(school) : [];
  const logo = getTeamLogo(school);

  return (
    <div className="staff-column">
      <div className="staff-column-head">
        {logo && <img alt="" className="team-logo team-logo-signal" loading="lazy" src={logo} />}
        <div className="min-w-0">
          <p className="text-[10px] font-black uppercase tracking-[0.18em] text-[var(--theme-muted)]">{side}</p>
          <p className="truncate text-lg font-black text-[var(--theme-primary)]">{school}</p>
        </div>
      </div>
      {staff.length > 0 ? (
        <ul className="staff-list">
          {staff.map((member) => (
            <li key={`${member.role}-${member.coach}`}>
              <button
                aria-label={`${member.coach}, ${school} ${ROLE_LABELS[member.role].toLowerCase()}`}
                className="staff-coach"
                onClick={() => onOpenCoachTree(member.coach)}
                type="button"
              >
                <span className="staff-role">{ROLE_SHORT[member.role]}</span>
                <span className="staff-name">{member.coach}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="staff-empty">
          {tracked
            ? 'No 2026 staff published for this team yet.'
            : 'This program is not in the coaching dataset.'}
        </p>
      )}
    </div>
  );
}

function CoachLink({ children, onOpenCoachTree }: { children: string; onOpenCoachTree: (coach: string) => void }) {
  return (
    <button className="coach-link" onClick={() => onOpenCoachTree(children)} type="button">
      {children}
    </button>
  );
}

function ConnectionCard({
  connection,
  game,
  onOpenCoachTree,
}: {
  connection: LineageConnection;
  game: ScheduleGame;
  onOpenCoachTree: (coach: string) => void;
}) {
  const { a, b, via } = connection;
  const label = (member: StaffMember, isHome: boolean) =>
    `${isHome ? game.home : game.away} ${ROLE_SHORT[member.role]}`;

  return (
    <li className={`connection-card connection-card-${connection.type}`}>
      <p className="connection-kind">{CONNECTION_LABELS[connection.type]}</p>
      <p className="connection-body">
        {connection.type === 'mentor-protege' && (
          <>
            <CoachLink onOpenCoachTree={onOpenCoachTree}>{via}</CoachLink> hired{' '}
            <CoachLink onOpenCoachTree={onOpenCoachTree}>{connection.protege ?? ''}</CoachLink> at{' '}
            <strong>{connection.stops}</strong>. Now they are on opposite sidelines.
          </>
        )}
        {connection.type === 'shared-staff' && (
          <>
            <CoachLink onOpenCoachTree={onOpenCoachTree}>{a.coach}</CoachLink> ({label(a, true)}) and{' '}
            <CoachLink onOpenCoachTree={onOpenCoachTree}>{b.coach}</CoachLink> ({label(b, false)}) sat in the
            same staff room under <CoachLink onOpenCoachTree={onOpenCoachTree}>{via}</CoachLink> at{' '}
            <strong>{connection.together}</strong>.
          </>
        )}
        {connection.type === 'shared-mentor' && (
          <>
            <CoachLink onOpenCoachTree={onOpenCoachTree}>{a.coach}</CoachLink> ({label(a, true)}) worked for{' '}
            <CoachLink onOpenCoachTree={onOpenCoachTree}>{via}</CoachLink> at <strong>{connection.aStops}</strong>;{' '}
            <CoachLink onOpenCoachTree={onOpenCoachTree}>{b.coach}</CoachLink> ({label(b, false)}) did the same at{' '}
            <strong>{connection.bStops}</strong>.
          </>
        )}
        {connection.type === 'shared-ancestor' && (
          <>
            <CoachLink onOpenCoachTree={onOpenCoachTree}>{a.coach}</CoachLink> ({label(a, true)}) and{' '}
            <CoachLink onOpenCoachTree={onOpenCoachTree}>{b.coach}</CoachLink> ({label(b, false)}) both branch off{' '}
            <CoachLink onOpenCoachTree={onOpenCoachTree}>{via}</CoachLink>, one hire removed.
          </>
        )}
      </p>
    </li>
  );
}

function GameDetail({
  game,
  onClose,
  onOpenCoachTree,
}: {
  game: ScheduleGame;
  onClose: () => void;
  onOpenCoachTree: (coach: string) => void;
}) {
  const lineage = getLineage(game.id);
  const tier = tierForGame(game, lineage);
  const meta = TIER_META[tier];
  const site = describeSite(game);
  const hidden = (lineage.connectionCount ?? 0) - lineage.connections.length;

  return (
    <div className="game-detail">
      <div className="game-detail-top">
        <div className="min-w-0">
          <p className="text-[10px] font-black uppercase tracking-[0.2em] text-[var(--theme-muted)]">
            {[`Week ${game.week}`, formatGameDate(game.date), game.kickoff].filter(Boolean).join(' · ')}
          </p>
          <h3 className="mt-1 text-2xl font-black leading-tight text-[var(--theme-primary)]">
            {game.away} {game.neutralSite ? 'vs' : 'at'} {game.home}
          </h3>
          <p className="mt-1 text-xs font-bold text-[var(--theme-muted)]">
            {[game.name, site, game.tv].filter(Boolean).join(' · ')}
          </p>
        </div>
        <div className="game-detail-verdict">
          <TierChip score={lineage.score} tier={tier} />
          {lineage.rank && <span className="game-detail-rank">#{lineage.rank} most tangled in 2026</span>}
        </div>
        <button className="game-detail-close" onClick={onClose} type="button">
          Close
        </button>
      </div>

      <p className="game-detail-blurb">{meta.blurb}</p>

      <div className="game-detail-staffs">
        <StaffColumn
          onOpenCoachTree={onOpenCoachTree}
          school={game.away}
          side={game.neutralSite ? 'Sideline 1' : 'Visitor'}
          tracked={game.awayTracked}
        />
        <StaffColumn
          onOpenCoachTree={onOpenCoachTree}
          school={game.home}
          side={game.neutralSite ? 'Sideline 2' : 'Host'}
          tracked={game.homeTracked}
        />
      </div>

      {lineage.trees && lineage.trees.length > 0 && (
        <div className="game-detail-trees">
          <p className="game-detail-subhead">Trees on both sidelines, closest tie first</p>
          <div className="flex flex-wrap gap-2">
            {lineage.trees.map((tree) => (
              <button
                aria-label={`${tree.coach}: ${tree.links} ${tree.links === 1 ? 'link' : 'links'} across this matchup`}
                className="tree-pill"
                key={tree.coach}
                onClick={() => onOpenCoachTree(tree.coach)}
                title={`${tree.links} ${tree.links === 1 ? 'link' : 'links'} across this matchup`}
                type="button"
              >
                {tree.coach}
                <em>{tree.links}</em>
              </button>
            ))}
          </div>
        </div>
      )}

      {lineage.connections.length > 0 ? (
        <div>
          <p className="game-detail-subhead">
            How they are related ({lineage.connectionCount} {lineage.connectionCount === 1 ? 'link' : 'links'})
          </p>
          <ul className="connection-list">
            {lineage.connections.map((connection, index) => (
              <ConnectionCard
                connection={connection}
                game={game}
                key={`${connection.type}-${connection.via}-${connection.a.coach}-${connection.b.coach}-${index}`}
                onOpenCoachTree={onOpenCoachTree}
              />
            ))}
          </ul>
          {hidden > 0 && (
            <p className="mt-2 text-xs font-bold text-[var(--theme-muted)]">
              {hidden} weaker {hidden === 1 ? 'link' : 'links'} not shown.
            </p>
          )}
        </div>
      ) : (
        <p className="staff-empty">
          {lineage.staffed
            ? 'No head coach or coordinator on either staff shares a mentor in this dataset.'
            : tier === 'untracked'
              ? 'This matchup gets scored once both programs are in the coaching dataset.'
              : 'This matchup gets scored once Wikipedia posts a 2026 staff for both teams.'}
        </p>
      )}
    </div>
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

function SubNavButton({ active, children, onClick }: { active: boolean; children: ReactNode; onClick: () => void }) {
  return (
    <button
      className={`schedule-tab ${active ? 'schedule-tab-active' : ''}`}
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  );
}

export default function Schedule({
  onChangePatriarch,
  onChangeView,
  onOpenCoachTree,
  onSelectGame,
  patriarch,
  selectedGameId,
  view,
}: ScheduleProps) {
  const deepLinkedGame = selectedGameId ? getGame(selectedGameId) : null;
  const [week, setWeek] = useState(() => deepLinkedGame?.week ?? getCurrentWeek());
  const [team, setTeam] = useState('');
  const [conference, setConference] = useState('');
  const [tier, setTier] = useState('');
  const detailRef = useRef<HTMLDivElement>(null);

  const selectedGame = selectedGameId ? getGame(selectedGameId) : null;

  const treeGameIds = useMemo(() => {
    const entry = patriarch ? PATRIARCHS.find((item) => item.coach === patriarch) : null;
    return entry ? new Set(entry.gameIds) : null;
  }, [patriarch]);

  const matchesFilters = useCallback(
    (game: ScheduleGame) => {
      const teamMatches = !team || game.home === team || game.away === team;
      const conferenceMatches =
        !conference || getConference(game.home) === conference || getConference(game.away) === conference;
      const treeMatches = !treeGameIds || treeGameIds.has(game.id);

      return teamMatches && conferenceMatches && treeMatches;
    },
    [conference, team, treeGameIds],
  );

  // Jumping from the ranked list to the week list should land on the selected
  // game's week, not leave the detail card describing a game the list never shows.
  useEffect(() => {
    if (view === 'week' && selectedGame) {
      setWeek(selectedGame.week);
    }
  }, [selectedGame, view]);

  const weekGames = useMemo(
    () =>
      SCHEDULE_GAMES.filter((game) => game.week === week && matchesFilters(game)).sort(
        (a, b) =>
          a.date.localeCompare(b.date) ||
          getLineage(b.id).score - getLineage(a.id).score ||
          a.home.localeCompare(b.home),
      ),
    [matchesFilters, week],
  );

  const rankedGames = useMemo(
    () =>
      RANKED_GAMES.filter(
        (entry) => matchesFilters(entry.game) && (!tier || entry.lineage.tier === tier),
      ).slice(0, 120),
    [matchesFilters, tier],
  );

  const selectGame = (gameId: string) => {
    const next = gameId === selectedGameId ? null : gameId;
    onSelectGame(next);

    if (next) {
      const lineage = getLineage(next);
      trackEvent('schedule_game_view', {
        game_id: next,
        tangle_score: lineage.score,
        tangle_tier: lineage.tier,
      });
    }
  };

  useEffect(() => {
    if (selectedGame && detailRef.current && window.innerWidth < 1024) {
      detailRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [selectedGame]);

  const scored = RANKED_GAMES.length;

  return (
    <div className="space-y-5">
      <div className="rounded-lg border border-[var(--theme-border)] bg-white p-4 shadow-sm">
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2 className="text-xl font-black text-[var(--theme-primary)]">{VIEW_COPY[view].title}</h2>
            <p className="mt-1 text-sm text-[var(--theme-muted)]">{VIEW_COPY[view].blurb}</p>
          </div>
          <p className="text-xs font-black uppercase tracking-wide text-[var(--theme-muted)]">
            {SCHEDULE_GAMES.length} games &middot; {scored} with shared branches
          </p>
        </div>

        <div className="mb-4 grid grid-cols-2 gap-1 rounded-lg border border-[var(--theme-border)] bg-[var(--theme-surface-soft)] p-1">
          <SubNavButton active={view === 'ranked'} onClick={() => onChangeView('ranked')}>
            Most tangled
          </SubNavButton>
          <SubNavButton active={view === 'week'} onClick={() => onChangeView('week')}>
            By week
          </SubNavButton>
        </div>

        <div className="leaderboard-filters">
          <FilterSelect
            label="Team"
            onChange={setTeam}
            options={[
              { label: 'All teams', value: '' },
              ...TEAM_OPTIONS.map((option) => ({ label: option, value: option })),
            ]}
            value={team}
          />
          <FilterSelect
            label="Conference"
            onChange={setConference}
            options={[
              { label: 'All conferences', value: '' },
              ...CONFERENCE_OPTIONS.map((option) => ({ label: option, value: option })),
            ]}
            value={conference}
          />
          <FilterSelect
            label="Coaching tree"
            onChange={onChangePatriarch}
            options={[
              { label: 'Any tree', value: '' },
              ...TREE_FILTER_OPTIONS.map((entry) => ({
                label: `${entry.coach} (${entry.gameCount})`,
                value: entry.coach,
              })),
            ]}
            value={patriarch}
          />
          {view === 'ranked' && (
            <FilterSelect
              label="Tangle level"
              onChange={setTier}
              options={[
                { label: 'All levels', value: '' },
                ...TIER_ORDER.map((option) => ({ label: TIER_META[option].label, value: option })),
              ]}
              value={tier}
            />
          )}
        </div>

        {patriarch && (
          <div className="tree-filter-note">
            <p>
              Showing only games with a coach out of <strong>{patriarch}</strong>&apos;s tree on each sideline.
            </p>
            <button
              className="accent-button rounded-md px-3 py-2 text-xs font-black uppercase tracking-wide"
              onClick={() => onOpenCoachTree(patriarch)}
              type="button"
            >
              Open the tree
            </button>
          </div>
        )}

        {view === 'week' && (
          <div className="week-picker">
            {WEEKS.map((option) => (
              <button
                className={`week-chip ${option.week === week ? 'week-chip-active' : ''}`}
                key={option.week}
                onClick={() => setWeek(option.week)}
                type="button"
              >
                <strong>Week {option.week}</strong>
                <em>{formatWeekRange(option)}</em>
              </button>
            ))}
          </div>
        )}
      </div>

      {selectedGame && (
        <div ref={detailRef}>
          <GameDetail
            game={selectedGame}
            onClose={() => onSelectGame(null)}
            onOpenCoachTree={onOpenCoachTree}
          />
        </div>
      )}

      <div className="rounded-lg border border-[var(--theme-border)] bg-white p-4 shadow-sm">
        {view === 'ranked' && (
          <>
            <p className="mb-3 text-sm text-[var(--theme-muted)]">
              Showing {rankedGames.length} of {scored} scored games, worst-kept family secrets first.
            </p>
            <div className="leaderboard-list">
              {rankedGames.map((entry) => (
                <GameRow
                  game={entry.game}
                  key={entry.game.id}
                  onSelect={() => selectGame(entry.game.id)}
                  rank={entry.lineage.rank}
                  selected={entry.game.id === selectedGameId}
                  via={patriarch || undefined}
                />
              ))}
              {rankedGames.length === 0 && (
                <p className="staff-empty">No games match these filters.</p>
              )}
            </div>
          </>
        )}

        {view === 'week' && (
          <>
            <p className="mb-3 text-sm text-[var(--theme-muted)]">
              {weekGames.length} {weekGames.length === 1 ? 'game' : 'games'} in Week {week}.
            </p>
            <div className="leaderboard-list">
              {weekGames.map((game) => (
                <GameRow
                  game={game}
                  key={game.id}
                  onSelect={() => selectGame(game.id)}
                  selected={game.id === selectedGameId}
                  via={patriarch || undefined}
                />
              ))}
              {weekGames.length === 0 && <p className="staff-empty">No games match these filters.</p>}
            </div>
          </>
        )}
      </div>

      <p className="text-xs leading-5 text-[var(--theme-muted)]">
        Scoring uses each team&apos;s {SCHEDULE_SEASON} head coach and coordinators only ({Object.values(ROLE_LABELS)
          .map((label) => label.toLowerCase())
          .join(', ')}), so a team with a thoroughly edited Wikipedia page cannot out-rank the field on staff
        volume alone. A shared mentor is a head coach both men worked for before their own first head coaching job.
      </p>
    </div>
  );
}
