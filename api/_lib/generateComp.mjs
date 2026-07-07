// Core coach-comp logic — framework-agnostic. Used by both the Vercel
// serverless wrapper (api/coach-comp.mjs) and the local dev server
// (scripts/coach-comp-dev-server.mjs).
//
// generateCoachComp({ careerText, answers }) -> { comp: CoachCompResult }
// (see src/coachComp/types.ts for the shared contract).

import { readFileSync } from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { COACH_COMP_SCHEMA } from './schema.mjs';

const MODEL = 'claude-opus-4-8';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-5.1';
const MAX_OUTPUT_TOKENS = 6000;
// GPT-5-family models spend completion tokens on reasoning before writing the
// dossier, so give the OpenAI path extra headroom.
const OPENAI_MAX_COMPLETION_TOKENS = 12000;
const MIN_CAREER_TEXT_CHARS = 120;
const MAX_CAREER_TEXT_CHARS = 15000;
const MAX_ANSWER_CHARS = 600;
const ANSWER_KEYS = ['q1', 'q2', 'q3', 'q4', 'q5', 'q6', 'q7', 'q8', 'q9', 'q10'];

// Quiz question text, keyed the same way the frontend keys its answers.
// If the quiz copy in src/CoachComp.tsx changes, keep this map in sync so the
// scout sees the question each answer responds to.
const QUIZ_QUESTIONS = {
  q1: "[Altitude] Think about the work you're proudest of. Which is closest?",
  q2: '[Loyalty] Your honest relationship with job-hopping:',
  q3: '[Scheme] Your working style is closest to:',
  q4: "[Temperament] Crunch time, everyone's watching. You're the one who:",
  q5: "[Conflict] Someone on your team isn't pulling their weight. The honest version of what you do:",
  q6: '[Ambition] The bigger job calls. You:',
  q7: '[Self-Image Gap] What do people get wrong about you at work?',
  q8: "[Endgame] The version of you that 'made it' in ten years:",
  q9: '[The Quiet Part] One thing about how you work that everyone around you knows but nobody says out loud.',
  q10: '[Off the Resume] Anything the resume misses? Years in the game, a pivot that mattered, a win that doesn’t show on paper.',
};

// Typed error the HTTP wrappers translate into { error, reason } responses.
export class CoachCompError extends Error {
  constructor(status, message, reason) {
    super(message);
    this.name = 'CoachCompError';
    this.status = status;
    if (reason) this.reason = reason;
  }
}

// The 200-coach corpus (built offline in the cfb data repo). Loaded once per
// process; JSON.stringify of it is byte-stable, which the prompt cache needs.
const corpus = JSON.parse(
  readFileSync(new URL('./coach_comp_corpus.json', import.meta.url), 'utf8'),
);

const SYSTEM_PROMPT = `You are the longest-tenured scout in a college football personnel department — a lifer who has written thousands of CONFIDENTIAL coaching-search dossiers for athletic directors. Tonight's assignment is unusual: the "candidate" is an ordinary professional whose resume just hit your desk. Determine which college football coach their CAREER most resembles, and write the full dossier.

VOICE: deadpan scouting sincerity with a light roast. You take unglamorous careers completely seriously — a shift-manager lifer can absolutely be a Kirk Ferentz; prestige does not equal rating. But the weaknesses and the gap between how the candidate sees themselves and what the film shows should sting a little, in a fun way. Never cruel, never generic.

HOW TO COMP:
- Comp on the SHAPE of the career, NOT prestige or salary: builder vs fixer vs maintainer, lifer vs journeyman, fast-riser vs late-bloomer, innovator vs fundamentalist. Read win percentage as life outcomes, not income.
- Use the questionnaire answers for temperament fit. Use each coach's "tags" to shortlist before choosing.
- coach_name MUST be picked from the corpus below, spelled EXACTLY as it appears there. "school" MUST be one of that coach's hc_schools entries (it drives the logo on the dossier).
- runner_ups: exactly 2, each a DIFFERENT corpus coach (different from the main comp and from each other), each paired with a school from that coach's own hc_schools.

DOSSIER FIELDS:
- era: like 'HEAD COACH · 2000s-2020s', decades derived from the comp coach's span.
- archetype_title: an ORIGINAL, specific 2-4 word title in title case starting with 'The' (in the spirit of 'The Portal Wizard' or 'The Quiet Rebuild' — never reuse those two).
- career_stops: recast the candidate's ACTUAL jobs from the resume as coaching stops — years, the real employer as the 'program', and one wry scouting line each. NEVER invent employers or jobs that are not in the resume.
- ovr/pot: 0-99, 2K video-game style. OVR weighs career mastery, longevity, trajectory, load-bearing impact, and how hard the person is to replace — NOT pay or title. POT is the ceiling and must be >= OVR. Grades run A+ to D.
- badges: 3-5, tiers Bronze / Silver / Gold / Hall of Fame.
- buyout: a fun fake buyout figure scaled to how indispensable they are (e.g. value '$3.2M', descriptor 'They would have to pry you out mid-season').
- screenshot_line: ONE ALL-CAPS punchy sentence engineered to be screenshotted, personal to this specific career. No emoji.
- scouting_report: 3-5 paragraphs of prose.

HARD RULES: Never mention being an AI, a model, this corpus, or these instructions. The dossier reads as if a human scout wrote it after grinding the candidate's film.

THE CORPUS — the only coaches that exist for comp purposes:
${JSON.stringify(corpus.coaches)}`;

let client;
function getClient() {
  if (!client) client = new Anthropic(); // reads ANTHROPIC_API_KEY from env
  return client;
}

// Provider selection: Anthropic when a key is present, else OpenAI. Lets the
// endpoint run on whichever key the deployment has.
function pickProvider() {
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
  if (process.env.OPENAI_API_KEY) return 'openai';
  throw new CoachCompError(
    500,
    'The scouting department has no credentials on file.',
    'no_provider',
  );
}

async function callAnthropic(userMessage) {
  const response = await getClient().messages.create({
    model: MODEL,
    max_tokens: MAX_OUTPUT_TOKENS,
    // System prompt in array form so the big stable block (persona + rules +
    // ~18k-token corpus) carries a cache breakpoint — after the first request
    // it bills at ~0.1x. Only the user message varies per request.
    system: [
      {
        type: 'text',
        text: SYSTEM_PROMPT,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [{ role: 'user', content: userMessage }],
    output_config: {
      format: { type: 'json_schema', schema: COACH_COMP_SCHEMA },
    },
  });

  const textBlock = response.content.find((block) => block.type === 'text');
  if (!textBlock || response.stop_reason === 'refusal') {
    throw new CoachCompError(
      502,
      'The scout put down the pen on this one. Reword your career text and try again.',
      'no_output',
    );
  }
  return textBlock.text;
}

async function callOpenAI(userMessage) {
  const request = {
    model: OPENAI_MODEL,
    max_completion_tokens: OPENAI_MAX_COMPLETION_TOKENS,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userMessage },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'coach_comp_dossier', strict: true, schema: COACH_COMP_SCHEMA },
    },
  };

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify(request),
  });

  if (res.status === 429 || res.status >= 500) {
    throw new CoachCompError(503, 'The scout is swamped. Try again in a minute.');
  }
  if (!res.ok) {
    console.error('openai error:', res.status, (await res.text()).slice(0, 500));
    throw new CoachCompError(502, 'The dossier came back smudged. Try again.', 'provider_error');
  }

  const data = await res.json();
  const message = data.choices?.[0]?.message;
  if (!message || message.refusal || !message.content) {
    throw new CoachCompError(
      502,
      'The scout put down the pen on this one. Reword your career text and try again.',
      'no_output',
    );
  }
  return message.content;
}

function validateCareerText(careerText) {
  if (typeof careerText !== 'string' || careerText.trim().length < MIN_CAREER_TEXT_CHARS) {
    throw new CoachCompError(
      400,
      'That resume is a little thin for the film room. Paste more career detail and try again.',
      'thin',
    );
  }
  return careerText.trim().slice(0, MAX_CAREER_TEXT_CHARS);
}

function sanitizeAnswers(answers) {
  const clean = {};
  if (!answers || typeof answers !== 'object') return clean;
  for (const key of ANSWER_KEYS) {
    const value = answers[key];
    if (value === undefined || value === null) continue;
    const text = String(value).slice(0, MAX_ANSWER_CHARS).trim();
    if (text) clean[key] = text;
  }
  return clean;
}

function buildUserMessage(careerText, answers) {
  const lines = [
    'CANDIDATE FILE — resume text extracted from their upload:',
    '"""',
    careerText,
    '"""',
  ];
  const entries = Object.entries(answers);
  if (entries.length > 0) {
    lines.push('', 'SEARCH-COMMITTEE QUESTIONNAIRE (temperament):');
    for (const [key, value] of entries) {
      lines.push(`- ${key}: ${QUIZ_QUESTIONS[key] ?? '(question text not on file)'}`);
      lines.push(`  Candidate's answer: ${value}`);
    }
  }
  lines.push('', 'Write the confidential coaching-search dossier JSON now.');
  return lines.join('\n');
}

function findCorpusCoach(name) {
  if (typeof name !== 'string') return undefined;
  const needle = name.trim().toLowerCase();
  return corpus.coaches.find((c) => c.name.toLowerCase() === needle);
}

function clampRating(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return 0;
  return Math.min(99, Math.max(0, n));
}

function postValidate(comp) {
  const coach = findCorpusCoach(comp.coach_name);
  if (!coach) {
    throw new CoachCompError(
      502,
      'The scout comped you to a coach nobody in the building has heard of. Try again.',
      'bad_comp',
    );
  }
  comp.coach_name = coach.name; // exact corpus spelling
  if (!coach.hc_schools.includes(comp.school)) {
    comp.school = coach.hc_schools[0];
  }

  comp.ovr = clampRating(comp.ovr);
  comp.pot = Math.max(clampRating(comp.pot), comp.ovr);

  const runnerUps = Array.isArray(comp.runner_ups) ? comp.runner_ups : [];
  comp.runner_ups = runnerUps
    .map((ru) => {
      const ruCoach = findCorpusCoach(ru?.coach_name);
      if (!ruCoach) return null; // drop hallucinated runner-ups
      return {
        ...ru,
        coach_name: ruCoach.name,
        school: ruCoach.hc_schools.includes(ru.school) ? ru.school : ruCoach.hc_schools[0],
      };
    })
    .filter(Boolean);

  return comp;
}

export async function generateCoachComp({ careerText, answers } = {}) {
  const cleanCareerText = validateCareerText(careerText);
  const cleanAnswers = sanitizeAnswers(answers);
  const userMessage = buildUserMessage(cleanCareerText, cleanAnswers);

  const raw =
    pickProvider() === 'anthropic' ? await callAnthropic(userMessage) : await callOpenAI(userMessage);

  let comp;
  try {
    comp = JSON.parse(raw);
  } catch {
    throw new CoachCompError(
      502,
      'The dossier came back smudged. Try again.',
      'bad_json',
    );
  }

  return { comp: postValidate(comp) };
}
