// Vercel Node serverless function: POST /api/coach-comp
// Body: CoachCompRequest -> 200 CoachCompResponse | error { error, reason? }
// (contract in src/coachComp/types.ts). Core logic lives in _lib/generateComp.mjs.

import Anthropic from '@anthropic-ai/sdk';
import { CoachCompError, generateCoachComp } from './_lib/generateComp.mjs';

// One Claude call can take a while at peak; give the function generous headroom.
export const config = { maxDuration: 300 };

export default async function handler(req, res) {
  // Results are personal, one-shot, and cheap to regenerate — never cache them.
  res.setHeader('Cache-Control', 'no-store');
  // No Access-Control-Allow-Origin header on purpose: the Vite site and this
  // function are deployed on the same Vercel origin, so same-origin fetches
  // need no CORS grant — and omitting the header keeps other origins out.

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed. POST a CoachCompRequest.' });
  }

  // Vercel parses JSON bodies into req.body, but tolerate a raw string body
  // (e.g. missing content-type) by parsing it ourselves.
  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      return res.status(400).json({ error: 'Request body must be valid JSON.' });
    }
  }
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ error: 'Request body must be a JSON object.' });
  }

  try {
    const result = await generateCoachComp({
      careerText: body.careerText,
      answers: body.answers,
    });
    return res.status(200).json(result);
  } catch (err) {
    if (err instanceof CoachCompError) {
      return res
        .status(err.status)
        .json({ error: err.message, ...(err.reason ? { reason: err.reason } : {}) });
    }
    if (err instanceof Anthropic.APIError && (err.status === 429 || err.status === 529)) {
      return res.status(503).json({ error: 'The scout is swamped. Try again in a minute.' });
    }
    console.error('coach-comp error:', err);
    return res.status(500).json({ error: 'The scouting department hit a snag. Try again.' });
  }
}
