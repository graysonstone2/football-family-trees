// JSON schema for the coach-comp structured output.
// Mirrors CoachCompResult in src/coachComp/types.ts — keep the two in sync.
//
// Structured-output constraints (see Anthropic docs): every object must set
// additionalProperties: false and list every property in `required`; numeric
// and string bounds (minimum/maximum/minLength/...) are NOT supported, so all
// ranges are expressed in `description` and enforced in generateComp.mjs.

const GRADE_DESCRIPTION = 'Letter grade from A+ down to D, e.g. "A-" or "B+".';

export const COACH_COMP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'coach_name',
    'school',
    'era',
    'archetype_title',
    'ovr',
    'pot',
    'ovr_rationale',
    'grades',
    'badges',
    'strengths',
    'weaknesses',
    'career_stops',
    'stat_line',
    'buyout',
    'why_this_coach',
    'screenshot_line',
    'scouting_report',
    'best_fit_program',
    'runner_ups',
  ],
  properties: {
    coach_name: {
      type: 'string',
      description:
        'The comp coach. MUST be a name from the provided corpus, spelled exactly as it appears there.',
    },
    school: {
      type: 'string',
      description:
        "MUST be one of the comp coach's hc_schools entries from the corpus (drives the team logo).",
    },
    era: {
      type: 'string',
      description:
        "Like 'HEAD COACH · 2000s-2020s' — decades derived from the comp coach's span in the corpus.",
    },
    archetype_title: {
      type: 'string',
      description:
        "Original, specific 2-4 word archetype in title case starting with 'The' (e.g. 'The Quiet Rebuild').",
    },
    ovr: {
      type: 'integer',
      description:
        '2K-style overall rating, integer 0-99. Weighs career mastery, longevity, trajectory, load-bearing impact, and irreplaceability — never pay or title.',
    },
    pot: {
      type: 'integer',
      description: '2K-style potential (ceiling) rating, integer 0-99. Must be >= ovr.',
    },
    ovr_rationale: {
      type: 'string',
      description: 'One or two sentences justifying the OVR in scout-speak.',
    },
    grades: {
      type: 'object',
      additionalProperties: false,
      required: ['recruiting', 'scheme', 'culture', 'game_management'],
      properties: {
        recruiting: { type: 'string', description: GRADE_DESCRIPTION },
        scheme: { type: 'string', description: GRADE_DESCRIPTION },
        culture: { type: 'string', description: GRADE_DESCRIPTION },
        game_management: { type: 'string', description: GRADE_DESCRIPTION },
      },
    },
    badges: {
      type: 'array',
      description: '3 to 5 badges.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['label', 'tier', 'earned_by'],
        properties: {
          label: { type: 'string', description: 'Short punchy badge name.' },
          tier: {
            type: 'string',
            enum: ['Bronze', 'Silver', 'Gold', 'Hall of Fame'],
          },
          earned_by: {
            type: 'string',
            description: 'The specific career evidence that earned the badge.',
          },
        },
      },
    },
    strengths: {
      type: 'array',
      description: '3 to 5 short strength lines.',
      items: { type: 'string' },
    },
    weaknesses: {
      type: 'array',
      description:
        '3 to 5 short weakness lines. These should sting a little, in a fun way.',
      items: { type: 'string' },
    },
    career_stops: {
      type: 'array',
      description:
        "The candidate's ACTUAL jobs from the resume recast as coaching stops, in chronological order. Never invent employers.",
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['years', 'team', 'line'],
        properties: {
          years: { type: 'string', description: "Years at the stop, e.g. '2018-2021'." },
          team: {
            type: 'string',
            description: "The real employer from the resume, presented as the 'program'.",
          },
          line: { type: 'string', description: 'One wry scouting line about the stop.' },
        },
      },
    },
    stat_line: {
      type: 'object',
      additionalProperties: false,
      required: ['seasons', 'programs', 'pivots', 'status'],
      properties: {
        seasons: { type: 'string', description: "Career length, e.g. '12 seasons'." },
        programs: { type: 'string', description: "Employer count, e.g. '4 programs'." },
        pivots: { type: 'string', description: "Career pivots, e.g. '2 scheme changes'." },
        status: { type: 'string', description: "Current standing, e.g. 'Signed through 2027'." },
      },
    },
    buyout: {
      type: 'object',
      additionalProperties: false,
      required: ['value', 'descriptor'],
      properties: {
        value: {
          type: 'string',
          description: "Fun fake buyout figure scaled to indispensability, e.g. '$3.2M'.",
        },
        descriptor: {
          type: 'string',
          description: "e.g. 'They would have to pry you out mid-season'.",
        },
      },
    },
    why_this_coach: {
      type: 'string',
      description: 'A short paragraph on why this coach is the comp — career shape, not prestige.',
    },
    screenshot_line: {
      type: 'string',
      description:
        "ONE ALL-CAPS punchy sentence engineered to be screenshotted, personal to this candidate's career. No emoji.",
    },
    scouting_report: {
      type: 'array',
      description: '3 to 5 prose paragraphs, one string per paragraph.',
      items: { type: 'string' },
    },
    best_fit_program: {
      type: 'string',
      description: 'The kind of workplace/program where this candidate wins biggest.',
    },
    runner_ups: {
      type: 'array',
      description:
        "Exactly 2. Different corpus coaches from the main comp (and from each other), each with a school from that coach's own hc_schools.",
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['coach_name', 'school', 'note'],
        properties: {
          coach_name: {
            type: 'string',
            description: 'A corpus coach name, spelled exactly as in the corpus.',
          },
          school: {
            type: 'string',
            description: "One of that coach's hc_schools entries.",
          },
          note: { type: 'string', description: 'One line on why they were in the mix.' },
        },
      },
    },
  },
};
