import { toBlob } from 'html-to-image';
import { ReactNode, Ref, useEffect, useRef, useState } from 'react';
import type { CoachCompRequest, CoachCompResponse, CoachCompResult } from './coachComp/types';
import { trackEvent } from './functions/analytics';
import { findCoachName } from './functions/coachData';
import { getTeamLogo } from './functions/teamLogos';

const API_URL = import.meta.env.VITE_COACH_COMP_API ?? '/api/coach-comp';
const MAX_CAREER_CHARS = 15000;
const MIN_PDF_CHARS = 200;
const MIN_PASTE_CHARS = 40;
const TOTAL_STEPS = 10;

const THIN_PDF_MESSAGE =
  'That PDF came through thin — it might be a scanned image. Paste your work history instead.';
const DAILY_CAP_MESSAGE = 'The free scouts are out for the day — try again tomorrow.';

type QuizQuestion = {
  id: string;
  dimension: string;
  prompt: string;
  options: string[];
};

type FreeTextQuestion = {
  id: string;
  dimension: string;
  prompt: string;
};

const QUIZ_QUESTIONS: QuizQuestion[] = [
  {
    id: 'q1',
    dimension: 'Altitude',
    prompt: "Think about the work you're proudest of. Which is closest?",
    options: [
      'I built something from nothing',
      'I took over a mess and fixed it',
      'I kept a good thing running when everyone expected it to fall apart',
      'I outperformed with less than everyone else had',
    ],
  },
  {
    id: 'q2',
    dimension: 'Loyalty',
    prompt: 'Your honest relationship with job-hopping:',
    options: [
      "I've been at my place forever and I'm proud of it",
      'I stay until the work is done, then I get restless',
      'Every move was a step up — no apologies',
      'I left once and part of me never got over it',
    ],
  },
  {
    id: 'q3',
    dimension: 'Scheme',
    prompt: 'Your working style is closest to:',
    options: [
      "Innovator — I'd rather try something weird than run the same play twice",
      'Fundamentals — do the boring things perfectly',
      'Aggressive — fourth-and-two is a go, every time',
      'Adaptable — I run whatever this roster can win with',
    ],
  },
  {
    id: 'q4',
    dimension: 'Temperament',
    prompt: "Crunch time, everyone's watching. You're the one who:",
    options: [
      'Delivers the fiery speech',
      'Gets quieter and more precise',
      'Cracks a joke to loosen the room',
      'Already prepared for this exact scenario weeks ago',
    ],
  },
  {
    id: 'q5',
    dimension: 'Conflict',
    prompt: "Someone on your team isn't pulling their weight. The honest version of what you do:",
    options: [
      'Direct conversation, today',
      'I quietly work around them',
      'I let the film do the talking',
      'I give them one more chance than I should',
    ],
  },
  {
    id: 'q6',
    dimension: 'Ambition',
    prompt: 'The bigger job calls. You:',
    options: [
      "Take it — that's the whole point",
      'Use it as leverage and stay put',
      'Turn it down — my people are here',
      "Depends entirely on who's asking",
    ],
  },
  {
    id: 'q7',
    dimension: 'Self-Image Gap',
    prompt: 'What do people get wrong about you at work?',
    options: [
      "They think I'm intense — I'm actually loose",
      "They think I'm chill — I'm keeping score",
      'They think I got lucky',
      "They think I'm the genius — my staff does the work",
    ],
  },
  {
    id: 'q8',
    dimension: 'Endgame',
    prompt: "The version of you that 'made it' in ten years:",
    options: [
      'Running the biggest program in the sport',
      'The respected lifer with the building named after them',
      'Reinvented — new field, same energy',
      'Out entirely — boat, lake, flip phone',
    ],
  },
];

const FREE_TEXT_QUESTIONS: FreeTextQuestion[] = [
  {
    id: 'q9',
    dimension: 'The Quiet Part',
    prompt: 'One thing about how you work that everyone around you knows but nobody says out loud.',
  },
  {
    id: 'q10',
    dimension: 'Off the Resume',
    prompt: 'Anything the resume misses? Years in the game, a pivot that mattered, a win that doesn’t show on paper.',
  },
];

const LOADING_LINES = [
  'Pulling your film from the archive...',
  'Cross-referencing a century of coaching stops...',
  'The war room is arguing about your ceiling...',
  'Running the buyout math a second time...',
];

type Stage = 'intake' | 'quiz' | 'loading' | 'result' | 'error';

type CoachCompProps = {
  onOpenCoachTree: (coachName: string) => void;
};

const slugify = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

const extractPdfText = async (file: File) => {
  // pdfjs-dist is ~400KB minified — load it on demand so visitors who never
  // upload a PDF don't pay for it in the main bundle.
  const [pdfjs, { default: workerUrl }] = await Promise.all([
    import('pdfjs-dist'),
    import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
  ]);
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

  const loadingTask = pdfjs.getDocument({ data: await file.arrayBuffer() });

  try {
    const doc = await loadingTask.promise;
    const pageTexts: string[] = [];

    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent();
      pageTexts.push(content.items.map((item) => ('str' in item ? item.str : '')).join(' '));
    }

    return pageTexts.join('\n').replace(/\s+/g, ' ').trim();
  } finally {
    await loadingTask.destroy();
  }
};

const readErrorPayload = (payload: unknown): { error?: string; reason?: string } => {
  if (!payload || typeof payload !== 'object') {
    return {};
  }

  const record = payload as Record<string, unknown>;

  return {
    error: typeof record.error === 'string' ? record.error : undefined,
    reason: typeof record.reason === 'string' ? record.reason : undefined,
  };
};

const CoachComp = ({ onOpenCoachTree }: CoachCompProps) => {
  const [stage, setStage] = useState<Stage>('intake');
  const [careerText, setCareerText] = useState('');
  const [pasteText, setPasteText] = useState('');
  const [showPaste, setShowPaste] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [isParsingPdf, setIsParsingPdf] = useState(false);
  const [intakeError, setIntakeError] = useState('');
  const [quizIndex, setQuizIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [freeTextDraft, setFreeTextDraft] = useState('');
  const [loadingLineIndex, setLoadingLineIndex] = useState(0);
  const [result, setResult] = useState<CoachCompResult | null>(null);
  const [fileNumber, setFileNumber] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [errorReason, setErrorReason] = useState<string | null>(null);
  const [isExporting, setIsExporting] = useState(false);
  const [exportStatus, setExportStatus] = useState('');
  const [copyStatus, setCopyStatus] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dossierRef = useRef<HTMLDivElement>(null);
  const advanceTimerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (advanceTimerRef.current !== null) {
        window.clearTimeout(advanceTimerRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    if (stage !== 'loading') {
      return;
    }

    setLoadingLineIndex(0);
    const timer = window.setInterval(
      () => setLoadingLineIndex((index) => (index + 1) % LOADING_LINES.length),
      2600,
    );

    return () => window.clearInterval(timer);
  }, [stage]);

  const goToStep = (index: number, currentAnswers: Record<string, string> = answers) => {
    setQuizIndex(index);

    const freeTextQuestion = FREE_TEXT_QUESTIONS[index - QUIZ_QUESTIONS.length];
    setFreeTextDraft(freeTextQuestion ? currentAnswers[freeTextQuestion.id] ?? '' : '');
  };

  const handleFile = async (file: File) => {
    setIntakeError('');

    if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
      setIntakeError('That does not look like a PDF. Upload a PDF export, or paste your work history instead.');
      setShowPaste(true);
      return;
    }

    setIsParsingPdf(true);

    try {
      const text = await extractPdfText(file);

      if (text.length < MIN_PDF_CHARS) {
        trackEvent('coach_comp_error', { stage: 'pdf_parse' });
        setIntakeError(THIN_PDF_MESSAGE);
        setShowPaste(true);
        return;
      }

      setCareerText(text.slice(0, MAX_CAREER_CHARS));
      trackEvent('coach_comp_intake', { method: 'pdf' });
      goToStep(0);
      setStage('quiz');
    } catch (error) {
      console.error(error);
      trackEvent('coach_comp_error', { stage: 'pdf_parse' });
      setIntakeError('The scout could not open that PDF. Try another export, or paste your work history instead.');
      setShowPaste(true);
    } finally {
      setIsParsingPdf(false);
    }
  };

  const handlePasteSubmit = () => {
    const text = pasteText.trim();

    if (text.length < MIN_PASTE_CHARS) {
      setIntakeError('Give the scout a little more to work with — job titles, employers, and years all help.');
      return;
    }

    setIntakeError('');
    setCareerText(text.slice(0, MAX_CAREER_CHARS));
    trackEvent('coach_comp_intake', { method: 'paste' });
    goToStep(0);
    setStage('quiz');
  };

  const submit = async (finalAnswers: Record<string, string>) => {
    setStage('loading');
    setErrorMessage('');
    setErrorReason(null);

    try {
      const body: CoachCompRequest = {
        careerText: careerText.slice(0, MAX_CAREER_CHARS),
        answers: finalAnswers,
      };
      const response = await fetch(API_URL, {
        body: JSON.stringify(body),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      });
      const payload: unknown = await response.json().catch(() => null);

      if (!response.ok) {
        const { error, reason } = readErrorPayload(payload);
        trackEvent('coach_comp_error', { stage: 'request' });
        setErrorReason(reason ?? null);
        setErrorMessage(error ?? `The committee could not finish the report (HTTP ${response.status}).`);
        setStage('error');
        return;
      }

      const comp = (payload as CoachCompResponse | null)?.comp;

      if (!comp || typeof comp.coach_name !== 'string') {
        throw new Error('The scout returned an unreadable report.');
      }

      setResult(comp);
      setFileNumber(
        `${new Date().getFullYear()}-${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`,
      );
      setExportStatus('');
      setCopyStatus('');
      setStage('result');
      trackEvent('coach_comp_result', { coach_name: comp.coach_name });
    } catch (error) {
      console.error(error);
      trackEvent('coach_comp_error', { stage: 'request' });
      setErrorReason(null);
      setErrorMessage('The scout dropped the call mid-report. Check your connection and run it back.');
      setStage('error');
    }
  };

  const chooseOption = (questionId: string, option: string) => {
    const nextAnswers = { ...answers, [questionId]: option };
    setAnswers(nextAnswers);

    if (advanceTimerRef.current !== null) {
      window.clearTimeout(advanceTimerRef.current);
    }

    advanceTimerRef.current = window.setTimeout(() => {
      advanceTimerRef.current = null;
      goToStep(Math.min(quizIndex + 1, TOTAL_STEPS - 1), nextAnswers);
    }, 180);
  };

  const handleFreeTextStep = (skip: boolean) => {
    const question = FREE_TEXT_QUESTIONS[quizIndex - QUIZ_QUESTIONS.length];
    const text = freeTextDraft.trim();
    const nextAnswers = { ...answers };

    if (!skip && text) {
      nextAnswers[question.id] = text;
    } else {
      delete nextAnswers[question.id];
    }

    setAnswers(nextAnswers);

    if (quizIndex >= TOTAL_STEPS - 1) {
      void submit(nextAnswers);
      return;
    }

    goToStep(quizIndex + 1, nextAnswers);
  };

  const restart = () => {
    setStage('intake');
    setCareerText('');
    setPasteText('');
    setShowPaste(false);
    setIntakeError('');
    setQuizIndex(0);
    setAnswers({});
    setFreeTextDraft('');
    setResult(null);
    setFileNumber('');
    setErrorMessage('');
    setErrorReason(null);
    setExportStatus('');
    setCopyStatus('');
  };

  const exportDossier = async () => {
    const target = dossierRef.current;

    if (!target || !result) {
      return;
    }

    setIsExporting(true);
    setExportStatus('Rendering PNG...');

    try {
      await document.fonts?.ready;

      const blob = await toBlob(target, {
        backgroundColor: '#ffffff',
        cacheBust: true,
        pixelRatio: 2,
      });

      if (!blob) {
        throw new Error('The browser did not return image data.');
      }

      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.download = `coach-comp-${slugify(result.coach_name)}.png`;
      link.href = url;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      trackEvent('coach_comp_export', { coach_name: result.coach_name });
      setExportStatus('PNG downloaded.');
    } catch (error) {
      console.error(error);
      setExportStatus('Export failed. Try again.');
    } finally {
      setIsExporting(false);
    }
  };

  const copyScreenshotLine = async () => {
    if (!result) {
      return;
    }

    try {
      await navigator.clipboard.writeText(
        `"${result.screenshot_line}" ${window.location.origin}/?page=coach-comp`,
      );
      setCopyStatus('Copied. Go start something.');
    } catch (error) {
      console.error(error);
      setCopyStatus('Could not reach the clipboard.');
    }
  };

  return (
    <div className="comp-shell">
      {stage === 'intake' && (
        <div className="rounded-lg border border-[var(--theme-border)] bg-white p-5 shadow-sm">
          <p className="text-xs font-black uppercase tracking-[0.2em] text-[var(--theme-line)]">
            Step 1 of 2 · The film
          </p>
          <h2 className="mt-2 text-2xl font-black text-[var(--theme-primary)]">Hand over your career.</h2>
          <p className="mt-2 text-sm leading-6 text-[var(--theme-muted)]">
            Export your LinkedIn profile as a PDF (or use any resume PDF) and drop it here. The search committee
            reads the whole thing, then asks ten quick questions before filing its report.
          </p>

          <div
            className={`comp-dropzone mt-4 ${isDragging ? 'comp-dropzone-active' : ''}`}
            onClick={() => fileInputRef.current?.click()}
            onDragLeave={() => setIsDragging(false)}
            onDragOver={(event) => {
              event.preventDefault();
              setIsDragging(true);
            }}
            onDrop={(event) => {
              event.preventDefault();
              setIsDragging(false);
              const file = event.dataTransfer.files?.[0];

              if (file) {
                void handleFile(file);
              }
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                fileInputRef.current?.click();
              }
            }}
            role="button"
            tabIndex={0}
          >
            <span className="text-3xl" aria-hidden>
              🗂️
            </span>
            <span className="text-sm font-black uppercase tracking-wide text-[var(--theme-primary)]">
              {isParsingPdf ? 'Reading your film...' : 'Drop your LinkedIn or resume PDF'}
            </span>
            <span className="text-xs font-bold text-[var(--theme-muted)]">
              {isParsingPdf ? 'Extracting text in your browser.' : 'or click to browse for a file'}
            </span>
          </div>
          <input
            accept="application/pdf,.pdf"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';

              if (file) {
                void handleFile(file);
              }
            }}
            ref={fileInputRef}
            type="file"
          />
          <p className="mt-3 text-xs leading-5 text-[var(--theme-muted)]">
            Your file is read in your browser. Only the extracted text is sent to the scout, and we don't store it.
          </p>

          {intakeError && (
            <p className="mt-3 rounded-md border border-[var(--theme-accent)] bg-[var(--theme-accent-soft)] px-3 py-2 text-sm font-bold text-[var(--theme-line)]">
              {intakeError}
            </p>
          )}

          <div className="mt-5 border-t border-[var(--theme-border)] pt-4">
            {showPaste ? (
              <div>
                <label
                  className="mb-2 block text-xs font-black uppercase tracking-wide text-[var(--theme-primary)]"
                  htmlFor="coach-comp-paste"
                >
                  Paste your work history
                </label>
                <textarea
                  className="comp-textarea"
                  id="coach-comp-paste"
                  onChange={(event) => setPasteText(event.target.value)}
                  placeholder="Job titles, employers, years. Rough is fine — the scout reads between the lines."
                  value={pasteText}
                />
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <button
                    className="primary-button rounded-md px-4 py-2 text-sm font-black uppercase tracking-wide transition"
                    onClick={handlePasteSubmit}
                    type="button"
                  >
                    Send it to the scout
                  </button>
                  <button
                    className="comp-ghost-button rounded-md px-3 py-2 text-xs font-black uppercase tracking-wide"
                    onClick={() => setShowPaste(false)}
                    type="button"
                  >
                    Back to upload
                  </button>
                </div>
              </div>
            ) : (
              <button
                className="comp-ghost-button rounded-md px-3 py-2 text-xs font-black uppercase tracking-wide"
                onClick={() => setShowPaste(true)}
                type="button"
              >
                No PDF? Paste your work history
              </button>
            )}
          </div>
        </div>
      )}

      {stage === 'quiz' && (
        <div className="rounded-lg border border-[var(--theme-border)] bg-white p-5 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs font-black uppercase tracking-[0.2em] text-[var(--theme-line)]">
              Step 2 of 2 · The interview
            </p>
            <p className="text-xs font-black uppercase tracking-wide text-[var(--theme-muted)]">
              Question {quizIndex + 1} of {TOTAL_STEPS}
            </p>
          </div>
          <div className="comp-progress mt-3" aria-hidden>
            <span style={{ width: `${((quizIndex + 1) / TOTAL_STEPS) * 100}%` }} />
          </div>

          {quizIndex < QUIZ_QUESTIONS.length ? (
            <div className="mt-4">
              <span className="comp-dimension-chip">{QUIZ_QUESTIONS[quizIndex].dimension}</span>
              <h2 className="mt-3 text-xl font-black leading-snug text-[var(--theme-primary)] sm:text-2xl">
                {QUIZ_QUESTIONS[quizIndex].prompt}
              </h2>
              <div className="mt-4 grid gap-2">
                {QUIZ_QUESTIONS[quizIndex].options.map((option) => (
                  <button
                    className={`comp-option ${
                      answers[QUIZ_QUESTIONS[quizIndex].id] === option ? 'comp-option-selected' : ''
                    }`}
                    key={option}
                    onClick={() => chooseOption(QUIZ_QUESTIONS[quizIndex].id, option)}
                    type="button"
                  >
                    {option}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="mt-4">
              <span className="comp-dimension-chip">
                {FREE_TEXT_QUESTIONS[quizIndex - QUIZ_QUESTIONS.length].dimension}
              </span>
              <h2 className="mt-3 text-xl font-black leading-snug text-[var(--theme-primary)] sm:text-2xl">
                {FREE_TEXT_QUESTIONS[quizIndex - QUIZ_QUESTIONS.length].prompt}
              </h2>
              <p className="mt-2 text-xs font-bold uppercase tracking-wide text-[var(--theme-muted)]">
                Optional — the committee reads everything you give it.
              </p>
              <textarea
                className="comp-textarea mt-4"
                onChange={(event) => setFreeTextDraft(event.target.value)}
                placeholder="Off the record."
                value={freeTextDraft}
              />
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <button
                  className="primary-button rounded-md px-4 py-2 text-sm font-black uppercase tracking-wide transition"
                  onClick={() => handleFreeTextStep(false)}
                  type="button"
                >
                  {quizIndex === TOTAL_STEPS - 1 ? 'File my report' : 'Next'}
                </button>
                <button
                  className="comp-ghost-button rounded-md px-3 py-2 text-xs font-black uppercase tracking-wide"
                  onClick={() => handleFreeTextStep(true)}
                  type="button"
                >
                  Skip
                </button>
              </div>
            </div>
          )}

          <div className="mt-5 border-t border-[var(--theme-border)] pt-3">
            <button
              className="comp-ghost-button rounded-md px-3 py-2 text-xs font-black uppercase tracking-wide"
              onClick={() => {
                if (quizIndex === 0) {
                  setStage('intake');
                  return;
                }

                goToStep(quizIndex - 1);
              }}
              type="button"
            >
              Back
            </button>
          </div>
        </div>
      )}

      {stage === 'loading' && (
        <div className="rounded-lg border border-[var(--theme-border)] bg-white p-8 text-center shadow-sm">
          <h2 className="text-2xl font-black text-[var(--theme-primary)]">
            The search committee is reviewing your film.
          </h2>
          <p className="comp-do-not-close mt-3 text-sm font-black uppercase">[ DO NOT CLOSE THIS TAB ]</p>
          <p className="mx-auto mt-3 max-w-md text-sm leading-6 text-[var(--theme-muted)]">
            A real scout is reading your whole career, not filling in a template. Good reads take a minute — hang
            tight.
          </p>
          <p className="comp-loading-status mt-6 text-xs font-black uppercase tracking-[0.18em] text-[var(--theme-line)]">
            {LOADING_LINES[loadingLineIndex]}
          </p>
        </div>
      )}

      {stage === 'error' && (
        <div className="rounded-lg border border-[var(--theme-border)] bg-white p-8 text-center shadow-sm">
          <p className="text-xs font-black uppercase tracking-[0.2em] text-[var(--theme-line)]">
            Report interrupted
          </p>
          <h2 className="mt-3 text-2xl font-black text-[var(--theme-primary)]">
            {errorReason === 'daily_cap' ? DAILY_CAP_MESSAGE : errorMessage || 'The scout hit a snag.'}
          </h2>
          <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
            {errorReason !== 'daily_cap' && (
              <button
                className="primary-button rounded-md px-4 py-2 text-sm font-black uppercase tracking-wide transition"
                onClick={() => void submit(answers)}
                type="button"
              >
                Run it back
              </button>
            )}
            <button
              className="comp-ghost-button rounded-md px-3 py-2 text-xs font-black uppercase tracking-wide"
              onClick={restart}
              type="button"
            >
              Start over
            </button>
          </div>
        </div>
      )}

      {stage === 'result' && result && (
        <>
          <Dossier exportRef={dossierRef} fileNumber={fileNumber} onOpenCoachTree={onOpenCoachTree} result={result} />

          <div className="flex flex-wrap items-center gap-2">
            <button
              className="primary-button rounded-md px-4 py-2 text-sm font-black uppercase tracking-wide transition disabled:cursor-wait disabled:opacity-60"
              disabled={isExporting}
              onClick={exportDossier}
              type="button"
            >
              {isExporting ? 'Exporting...' : 'Download PNG'}
            </button>
            <button
              className="accent-button rounded-md px-4 py-2 text-sm font-black uppercase tracking-wide transition"
              onClick={() => void copyScreenshotLine()}
              type="button"
            >
              Copy the line
            </button>
            {findCoachName(result.coach_name) && (
              <button
                className="accent-button rounded-md px-4 py-2 text-sm font-black uppercase tracking-wide transition"
                onClick={() => onOpenCoachTree(result.coach_name)}
                type="button"
              >
                Explore {result.coach_name}'s coaching tree
              </button>
            )}
            <button
              className="comp-ghost-button rounded-md px-3 py-2 text-xs font-black uppercase tracking-wide"
              onClick={restart}
              type="button"
            >
              [ APPEAL THIS REPORT ]
            </button>
          </div>
          {(exportStatus || copyStatus) && (
            <p className="text-xs font-bold text-[var(--theme-muted)]">{[exportStatus, copyStatus].filter(Boolean).join(' ')}</p>
          )}
        </>
      )}
    </div>
  );
};

type DossierProps = {
  exportRef: Ref<HTMLDivElement>;
  fileNumber: string;
  onOpenCoachTree: (coachName: string) => void;
  result: CoachCompResult;
};

function Dossier({ exportRef, fileNumber, onOpenCoachTree, result }: DossierProps) {
  const logo = getTeamLogo(result.school);
  const bestFitLogo = getTeamLogo(result.best_fit_program);

  return (
    <div className="comp-dossier" ref={exportRef}>
      <div className="comp-dossier-topbar">
        <span>Coaching Search Dossier</span>
        <span>File No. {fileNumber}</span>
      </div>
      <p className="comp-confidential">Confidential · Internal to the Athletic Department</p>

      <div className="comp-dossier-body">
        <header className="comp-header">
          {logo && <img alt="" className="comp-header-logo" src={logo} />}
          <div className="min-w-0">
            <p className="comp-file-label">The comp</p>
            <h2 className="comp-coach-name">{result.coach_name}</h2>
            <p className="comp-era">
              {result.school} · {result.era}
            </p>
            <p className="comp-archetype">"{result.archetype_title}"</p>
          </div>
        </header>

        <section>
          <h3 className="section-title">The rating</h3>
          <div className="comp-ratings">
            <div className="comp-rating">
              <span>{result.ovr}</span>
              <em>OVR</em>
            </div>
            <div className="comp-rating">
              <span>{result.pot}</span>
              <em>POT</em>
            </div>
            <p className="comp-rating-rationale">{result.ovr_rationale}</p>
          </div>
        </section>

        <div className="comp-chip-row">
          <StatChip label="Seasons" value={result.stat_line.seasons} />
          <StatChip label="Programs" value={result.stat_line.programs} />
          <StatChip label="Pivots" value={result.stat_line.pivots} />
          <StatChip label="Status" value={result.stat_line.status} />
          <span className="comp-chip comp-chip-buyout">
            <em>Buyout</em> {result.buyout.value} · {result.buyout.descriptor}
          </span>
        </div>

        <blockquote className="comp-pullquote">"{result.screenshot_line}"</blockquote>

        <section>
          <h3 className="section-title">Why this coach</h3>
          <p className="text-sm leading-6 text-[var(--theme-ink)]">{result.why_this_coach}</p>
        </section>

        <section>
          <h3 className="section-title">Grades</h3>
          <div className="comp-grades">
            <GradeTile grade={result.grades.recruiting} label="Recruiting" />
            <GradeTile grade={result.grades.scheme} label="Scheme" />
            <GradeTile grade={result.grades.culture} label="Culture" />
            <GradeTile grade={result.grades.game_management} label="Game Management" />
          </div>
        </section>

        {result.badges.length > 0 && (
          <section>
            <h3 className="section-title">Badges</h3>
            <div className="comp-badges">
              {result.badges.map((badge) => (
                <div
                  className={`comp-badge comp-badge-${slugify(badge.tier)}`}
                  key={badge.label}
                  title={badge.earned_by}
                >
                  <strong>
                    {badge.label} · {badge.tier}
                  </strong>
                  <span>{badge.earned_by}</span>
                </div>
              ))}
            </div>
          </section>
        )}

        <div className="comp-two-col">
          <section>
            <h3 className="section-title">Strengths</h3>
            <ul className="comp-list comp-list-strengths">
              {result.strengths.map((strength) => (
                <li key={strength}>{strength}</li>
              ))}
            </ul>
          </section>
          <section>
            <h3 className="section-title">Weaknesses</h3>
            <ul className="comp-list comp-list-weaknesses">
              {result.weaknesses.map((weakness) => (
                <li key={weakness}>{weakness}</li>
              ))}
            </ul>
          </section>
        </div>

        <section>
          <h3 className="section-title">Career film</h3>
          <div className="comp-film-wrap">
            <table className="comp-film-table">
              <thead>
                <tr>
                  <th scope="col">Years</th>
                  <th scope="col">Program</th>
                  <th scope="col">The line</th>
                </tr>
              </thead>
              <tbody>
                {result.career_stops.map((stop) => (
                  <tr key={`${stop.years}-${stop.team}`}>
                    <td>{stop.years}</td>
                    <td>{stop.team}</td>
                    <td>{stop.line}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section>
          <h3 className="section-title">Full scouting report</h3>
          <div className="space-y-3">
            {result.scouting_report.map((paragraph) => (
              <p className="text-sm leading-6 text-[var(--theme-ink)]" key={paragraph.slice(0, 48)}>
                {paragraph}
              </p>
            ))}
          </div>
        </section>

        <section>
          <h3 className="section-title">Best fit program</h3>
          <div className="flex items-center gap-3 rounded-lg border border-[var(--theme-border)] bg-[var(--theme-primary-soft)] p-3">
            {bestFitLogo && <img alt="" className="team-logo team-logo-signal" src={bestFitLogo} />}
            <p className="text-sm font-black text-[var(--theme-primary)]">{result.best_fit_program}</p>
          </div>
        </section>

        {result.runner_ups.length > 0 && (
          <section>
            <h3 className="section-title">Also in the film</h3>
            <div className="space-y-2">
              {result.runner_ups.map((runnerUp) => {
                const runnerUpLogo = getTeamLogo(runnerUp.school);
                const treeName = findCoachName(runnerUp.coach_name);

                return (
                  <div className="comp-runner-up" key={runnerUp.coach_name}>
                    <div className="flex min-w-0 items-center gap-3">
                      {runnerUpLogo && <img alt="" className="team-logo team-logo-job" src={runnerUpLogo} />}
                      <div className="min-w-0">
                        <p className="text-sm font-black text-[var(--theme-primary)]">
                          {runnerUp.coach_name} — {runnerUp.school}
                        </p>
                        <p className="text-xs leading-5 text-[var(--theme-muted)]">{runnerUp.note}</p>
                      </div>
                    </div>
                    {treeName && (
                      <button
                        className="accent-button rounded-md px-3 py-2 text-xs font-black uppercase tracking-wide transition"
                        onClick={() => onOpenCoachTree(runnerUp.coach_name)}
                        type="button"
                      >
                        See tree
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        )}
      </div>

      <p className="comp-dossier-footer">
        footballfamilytrees · scouted by the Search Committee (AI) · For entertainment. Not affiliated with the NCAA
        or any school.
      </p>
    </div>
  );
}

function StatChip({ label, value }: { label: string; value: ReactNode }) {
  return (
    <span className="comp-chip">
      <em>{label}</em> {value}
    </span>
  );
}

function GradeTile({ grade, label }: { grade: string; label: string }) {
  return (
    <div className="comp-grade-tile">
      <strong>{grade}</strong>
      <span>{label}</span>
    </div>
  );
}

export default CoachComp;
