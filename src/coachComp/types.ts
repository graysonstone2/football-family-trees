// Shared contract for the "Which Coach Are You?" feature.
// The api/coach-comp serverless function returns CoachCompResponse; keep the
// JSON schema in api/_lib/schema.mjs in sync with CoachCompResult.

export type CoachCompGrades = {
  recruiting: string;
  scheme: string;
  culture: string;
  game_management: string;
};

export type CoachCompBadge = {
  label: string;
  tier: 'Bronze' | 'Silver' | 'Gold' | 'Hall of Fame';
  earned_by: string;
};

export type CoachCompCareerStop = {
  years: string;
  team: string;
  line: string;
};

export type CoachCompRunnerUp = {
  coach_name: string;
  school: string;
  note: string;
};

export type CoachCompResult = {
  coach_name: string;
  school: string;
  era: string;
  archetype_title: string;
  ovr: number;
  pot: number;
  ovr_rationale: string;
  grades: CoachCompGrades;
  badges: CoachCompBadge[];
  strengths: string[];
  weaknesses: string[];
  career_stops: CoachCompCareerStop[];
  stat_line: {
    seasons: string;
    programs: string;
    pivots: string;
    status: string;
  };
  buyout: {
    value: string;
    descriptor: string;
  };
  why_this_coach: string;
  screenshot_line: string;
  scouting_report: string[];
  best_fit_program: string;
  runner_ups: CoachCompRunnerUp[];
};

export type CoachCompRequest = {
  careerText: string;
  answers: Record<string, string>;
};

export type CoachCompResponse = {
  comp: CoachCompResult;
};
