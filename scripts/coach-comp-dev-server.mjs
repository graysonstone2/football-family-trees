// Local dev API for the coach-comp endpoint. Dependency-free (node:http only);
// the Vite dev server proxies /api -> :8787 (see vite.config.ts).
//
//   ANTHROPIC_API_KEY=sk-ant-... npm run dev:api
//
// Mirrors the Vercel wrapper in api/coach-comp.mjs: same routes, same JSON
// error shapes, so the frontend can't tell the difference.

import http from 'node:http';
import { readFileSync } from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { CoachCompError, generateCoachComp } from '../api/_lib/generateComp.mjs';

const PORT = Number(process.env.PORT) || 8787;
const MAX_BODY_BYTES = 2 * 1024 * 1024; // 2 MB is plenty for extracted resume text

// MOCK_COACH_COMP=1 skips the model call and returns a canned dossier —
// lets you develop the frontend without an API key or token spend.
const MOCK = process.env.MOCK_COACH_COMP === '1';
const mockComp = MOCK
  ? JSON.parse(readFileSync(new URL('./coach-comp-fixture.json', import.meta.url), 'utf8'))
  : null;

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new CoachCompError(413, 'Request body too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function route(req) {
  const path = (req.url || '/').split('?')[0];
  if (path !== '/api/coach-comp') {
    return { status: 404, payload: { error: 'Not found.' }, headers: {} };
  }
  if (req.method !== 'POST') {
    return {
      status: 405,
      payload: { error: 'Method not allowed. POST a CoachCompRequest.' },
      headers: { Allow: 'POST' },
    };
  }

  const raw = await readBody(req);
  let body;
  try {
    body = JSON.parse(raw || 'null');
  } catch {
    return { status: 400, payload: { error: 'Request body must be valid JSON.' }, headers: {} };
  }
  if (!body || typeof body !== 'object') {
    return { status: 400, payload: { error: 'Request body must be a JSON object.' }, headers: {} };
  }

  if (MOCK) {
    if (typeof body.careerText !== 'string' || body.careerText.trim().length < 120) {
      return {
        status: 400,
        payload: {
          error: 'That resume is a little thin for the film room. Paste more career detail and try again.',
          reason: 'thin',
        },
        headers: {},
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 800));
    return { status: 200, payload: { comp: mockComp }, headers: {} };
  }

  const result = await generateCoachComp({
    careerText: body.careerText,
    answers: body.answers,
  });
  return { status: 200, payload: result, headers: {} };
}

function errorToResponse(err) {
  if (err instanceof CoachCompError) {
    return {
      status: err.status,
      payload: { error: err.message, ...(err.reason ? { reason: err.reason } : {}) },
    };
  }
  if (err instanceof Anthropic.APIError && (err.status === 429 || err.status === 529)) {
    return { status: 503, payload: { error: 'The scout is swamped. Try again in a minute.' } };
  }
  console.error('coach-comp error:', err);
  return { status: 500, payload: { error: 'The scouting department hit a snag. Try again.' } };
}

const server = http.createServer(async (req, res) => {
  const startedAt = Date.now();
  let status = 500;
  let payload = { error: 'The scouting department hit a snag. Try again.' };
  let headers = {};

  try {
    ({ status, payload, headers = {} } = await route(req));
  } catch (err) {
    ({ status, payload } = errorToResponse(err));
  }

  if (!res.writableEnded) {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...headers,
    });
    res.end(JSON.stringify(payload));
  }

  console.log(`${req.method} ${req.url} -> ${status} (${Date.now() - startedAt}ms)`);
});

server.listen(PORT, () => {
  console.log(
    `coach-comp dev API on http://localhost:${PORT} (${MOCK ? 'MOCK mode — canned dossier' : 'needs ANTHROPIC_API_KEY'})`,
  );
});
