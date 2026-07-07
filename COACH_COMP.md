# Coach Comp — "Which Coach Are You?"

A viral extension of Football Family Trees, modeled on [careerplayercomp.com](https://careerplayercomp.com):
upload your LinkedIn PDF (or paste your work history), answer eight quick questions, and the
"search committee" returns a confidential **Coaching Search Dossier** telling you which college
football coach had your career — with a rating, grades, badges, a fake buyout, and a full
scouting report designed to be screenshotted.

## How careerplayercomp.com does it (research summary)

- Next.js on Vercel; the AI is **Anthropic Claude** (the fictional scout is literally "Claude S.").
- The PDF never leaves the browser: **pdf.js extracts text client-side**, and only the text is
  sent to a single `POST /api/generate-comp` endpoint.
- One LLM call returns the entire report as structured JSON (player, 2K-style OVR/POT, grades,
  badges, season-by-season stats recast from your jobs, a `screenshot_line` engineered for
  sharing, runner-up comps).
- Virality levers: nothing is stored ("screenshot before you close the tab"), share cards,
  a re-roll button, a live "careers scouted" counter, and a tone that flatters the career
  shape while roasting the self-image gap. Comp is based on the **shape** of a career, not
  its prestige ("CEOs aren't automatically worth more than janitors").
- Cost control: IP-based daily free cap (Upstash) with a $2 Stripe skip-the-line link.

## Our architecture

```
cfb repo                          cfb-trees repo
─────────                         ──────────────
build_coach_comp_corpus.py  ──►   api/_lib/coach_comp_corpus.json   (200-coach persona corpus)
(school_data.json +               api/_lib/schema.mjs               (structured-output JSON schema)
 school_records.json)             api/_lib/generateComp.mjs         (prompt + Claude call + validation)
                                  api/coach-comp.mjs                (Vercel serverless wrapper)
                                  scripts/coach-comp-dev-server.mjs (local dev API on :8787)
                                  src/coachComp/types.ts            (shared TS contract)
                                  src/CoachComp.tsx                 (the page: intake → quiz → result)
```

1. **Corpus (offline).** `build_coach_comp_corpus.py` in the data repo derives per-coach career
   features from `school_data.json` + `school_records.json`: stints, tenure, school count,
   promotion path, boomerang returns, HC win-loss via the records join, and archetype tags
   (`lifer`, `journeyman`, `fast-riser`, `retread`, `boomerang`, `proven-winner`, …).
   It keeps every sitting head coach (fans know them) plus the historical greats by a
   prominence score — 200 coaches, ~18k tokens compact. Regenerate + copy with:
   ```bash
   cd ../cfb && python3 build_coach_comp_corpus.py
   cp coach_comp/coach_comp_corpus.json ../cfb-trees/api/_lib/coach_comp_corpus.json
   ```
2. **Client-side PDF parsing.** `pdfjs-dist` extracts text in the browser; only extracted text
   is POSTed. Privacy story matches careerplayercomp: "your file is read on your device."
3. **One Claude call.** `claude-opus-4-8`, structured output (`output_config.format`
   JSON schema), with the corpus embedded in a **prompt-cached system block** — so the ~18k-token
   corpus bills at ~0.1× on every request after the first. The model must pick `coach_name`
   from the corpus and `school` from that coach's HC schools (drives the logo + theme), comps
   on career *shape* not prestige, and recasts the user's real jobs as "career film" stops.
4. **Result page.** Team-themed dossier card reusing the site's CSS vars, `getTeamLogo`,
   PNG export via the existing `html-to-image` pattern, and — the piece careerplayercomp can't
   do — **"Explore this coach's tree"**, which jumps straight into the existing family-tree view.

## Running locally

```bash
export ANTHROPIC_API_KEY=sk-ant-...
npm run dev:api   # coach-comp API on :8787
npm run dev       # vite dev server (proxies /api → :8787)
```

## Deploying

The site is currently a static bundle. The path of least resistance is Vercel: it serves the
Vite build and picks up `api/coach-comp.mjs` as a serverless function automatically — set
`ANTHROPIC_API_KEY` in the project env. Any host works for the static site; the function just
needs to live somewhere and the frontend reads `VITE_COACH_COMP_API` if the API lives on a
different origin.

## Cost envelope

Per report with a warm cache: ~18k cached input (~$0.01) + ~3k fresh input (~$0.015) +
~3k output (~$0.075) ≈ **$0.10 on claude-opus-4-8**. 1,000 reports ≈ $100. Levers if it
takes off: switch the model string in `generateComp.mjs` to `claude-sonnet-5` (~3× cheaper)
or add a daily cap + Stripe skip like careerplayercomp (their exact playbook).

## Later ideas

- AI-annotated persona blurbs per coach (batch job in the data repo) for richer matching.
- A live "careers scouted" counter (needs a KV store — Upstash/Vercel KV).
- Story-format share card endpoint (`/api/card`) like careerplayercomp's.
- Daily cap + $2 skip-the-line via Stripe payment link.
- Coordinator-tier corpus (career coordinators like Mike Hankwitz, 31 DC years) for
  "you're not the boss and that's the point" comps.
