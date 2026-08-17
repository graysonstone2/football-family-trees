# React + TypeScript + Vite

## Refreshing a season

`scripts/refresh-season.py` pulls one season of coaching staffs and schedule off the
Wikipedia season pages:

```bash
python3 scripts/refresh-season.py 2026     # writes src/data.json + src/schedule_2026.json
npm run generate:schedule-lineage          # rescores every matchup (also runs in prebuild)
```

Only the head coach, coordinators, and named assistants are taken; player-transfer and
poll tables are skipped. Programs whose season page does not exist yet fall back to the
head coach on their program page, so a mid-summer run is correct but thin — rerun it at
kickoff and again after the season for the rest of the staffs. Coach names are matched
against the spellings already in `src/data.json` so a refresh never forks a coach's
history. Downloaded wikitext is cached under `scripts/.wiki-cache/` (gitignored); pass
`--offline` to rebuild from the cache, or delete the folder to force a fresh fetch.

The schedule tab scores each game on how much coaching lineage the two staffs share.
That scoring lives in `scripts/generate-schedule-lineage.mjs`, which uses the same
mentor rules as `buildReverseTree` in `src/functions/coachData.ts`, and writes
`src/schedule_lineage_2026.json`.

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
