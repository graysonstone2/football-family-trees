# React + TypeScript + Vite

## Google Analytics

This app ships with the GA4 tag for `G-BW0VPWSN3M`.

1. Create a GA4 web stream in Google Analytics.
2. Copy the measurement ID that starts with `G-`.
3. To use a different stream locally, create a `.env.local` file:

```bash
VITE_GA_MEASUREMENT_ID=G-XXXXXXXXXX
```

4. Update `index.html` with the same measurement ID, then rebuild and deploy the site.

Tracked automatically:

- Page views when the selected coach, mode, or school changes in the URL.
- `coach_search` events with coach name, tree mode, and result count.
- `tree_export_png` events with coach name, tree mode, and school filter.

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react/README.md) uses [Babel](https://babeljs.io/) for Fast Refresh
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react-swc) uses [SWC](https://swc.rs/) for Fast Refresh

## Expanding the ESLint configuration

If you are developing a production application, we recommend updating the configuration to enable type aware lint rules:

- Configure the top-level `parserOptions` property like this:

```js
export default tseslint.config({
  languageOptions: {
    // other options...
    parserOptions: {
      project: ['./tsconfig.node.json', './tsconfig.app.json'],
      tsconfigRootDir: import.meta.dirname,
    },
  },
})
```

- Replace `tseslint.configs.recommended` to `tseslint.configs.recommendedTypeChecked` or `tseslint.configs.strictTypeChecked`
- Optionally add `...tseslint.configs.stylisticTypeChecked`
- Install [eslint-plugin-react](https://github.com/jsx-eslint/eslint-plugin-react) and update the config:

```js
// eslint.config.js
import react from 'eslint-plugin-react'

export default tseslint.config({
  // Set the react version
  settings: { react: { version: '18.3' } },
  plugins: {
    // Add the react plugin
    react,
  },
  rules: {
    // other rules...
    // Enable its recommended rules
    ...react.configs.recommended.rules,
    ...react.configs['jsx-runtime'].rules,
  },
})
```

## Coach Comp API

The "Which Coach Are You?" feature calls a single backend endpoint that asks Claude to
comp your career against a fixed corpus of 200 college football coaches
(`api/_lib/coach_comp_corpus.json`). See `COACH_COMP.md` for the full design.

### Local dev

```bash
export ANTHROPIC_API_KEY=sk-ant-...
npm run dev:api   # coach-comp API on http://localhost:8787
npm run dev       # vite dev server; proxies /api -> :8787
```

The dev API is `scripts/coach-comp-dev-server.mjs` (plain `node:http`, no extra deps).
`PORT` overrides the default 8787.

### Deploy

On Vercel no config is needed: the `api/` directory is picked up automatically and
`api/coach-comp.mjs` becomes the `POST /api/coach-comp` serverless function
(`maxDuration: 300`). Set `ANTHROPIC_API_KEY` in the Vercel project environment.
The static site and the function share an origin, so the function intentionally sends
no CORS headers.

### Contract

Types live in `src/coachComp/types.ts`; the structured-output JSON schema that mirrors
them is `api/_lib/schema.mjs`.

- **Request** — `POST /api/coach-comp` with JSON `CoachCompRequest`:
  `{ careerText: string, answers: Record<string, string> }`. `careerText` is the
  extracted resume text (min 120 chars, truncated at 15k); `answers` is optional quiz
  answers keyed `q1`..`q10` (each truncated at 600 chars).
- **Response** — `200` with `CoachCompResponse`: `{ comp: CoachCompResult }` — the full
  dossier (coach comp, OVR/POT, grades, badges, career stops, buyout, scouting report,
  runner-ups, ...).
- **Errors** — JSON `{ error: string, reason?: string }`: `400` for bad input
  (`reason: "thin"` when `careerText` is too short), `502` when the model output can't
  be validated, `503` when Claude is rate-limited/overloaded, `500` otherwise.
