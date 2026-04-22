# CLAUDE.md

Context for agents working in this repo. Reading this first saves ~5 grep round-trips.

## What this is
A COBOL→Java modernization workbench built on top of the **OpenSourceCobol4j** base framework (vendored under `opensourcecobol4j/`). The enhancements we own are entirely under `opensourcecobol4j/tools/web-ui/` — a Node.js + Express app that scans a repo, builds a dependency graph, and runs one of two conversion pipelines (local `cobj` compiler, or Azure AI Foundry agent), then compiles + runs + diffs the results.

## Directory layout (the parts that matter)
```
opensourcecobol4j/              vendored upstream (do NOT reformat)
├── libcobj/                    upstream Java runtime
├── carddemo-app/               AWS CardDemo fixture (vendored)
├── cobj, configure, Makefile*  upstream build
└── tools/
    ├── cobol_repo_scanner.sh
    └── web-ui/                 ← everything we own lives here
        ├── server.js           Express app; ~1.8k lines, two inline routes remain
        │                       (convert-azure worker + /api/run); rest are mounted
        │                       from src/routes/.
        ├── azureAgent.js       Pure FACADE (53 lines). Real implementations live
        │                       under src/ai/.
        ├── aiAgent.js          Legacy OpenAI helper (failure-analysis fallback)
        ├── src/
        │   ├── ai/             azure-client, convert-cobol, fix-java,
        │   │                   analyze-failure, compare-runs
        │   ├── core/           auto-fix-java, accuracy-scorer, conversion-graph,
        │   │                   compile-gate-local, normalize-class,
        │   │                   parse-scanner-output, manual-review,
        │   │                   source-integrity, divisional-split,
        │   │                   cobol-typo-dictionary
        │   ├── core/run/       cobol-preprocess, data-file-staging,
        │   │                   list-output-files
        │   ├── routes/         17 modules: ai-analyze, cancel, compare,
        │   │                   convert-local, download, fix-java, fix-cobol,
        │   │                   graph, health, jcl, misc, post-review, resume,
        │   │                   review, run-ws, scan-repo, stats, status,
        │   │                   unfix-java
        │   ├── scan/           cobol-scanner, jcl-parser
        │   ├── persistence/    checkpoint, active-conversions-ttl
        │   └── util/           analysis-context, edit-distance, glob-regex,
        │                       logger, pascal-case, rate-limit, strip-ansi,
        │                       validate-repo-url
        ├── public/
        │   ├── index.html      SPA shell
        │   ├── app.js          Main frontend (~6k lines; browser tree, results,
        │   │                   review modal, run panel, activity drawer)
        │   ├── graph.js        Cytoscape-based dependency graph
        │   ├── style.css       ~5k lines; CSS cleanup tracked in todo.md §Phase 6
        │   └── js/             helpers, dialogs, accuracy-panel, review-chat
        │                       (modules extracted from app.js — more pending)
        ├── tests/
        │   ├── fidelity.test.js   53 prompt + behavior regression tests
        │   └── e2e.test.js        live Azure end-to-end test (skipped w/o creds)
        └── .env.example        Azure OpenAI creds template
```

## Entry points
- **Server:** `cd opensourcecobol4j/tools/web-ui && npm install && npm start` → http://localhost:3000
- **CLI (rare):** `node azureAgent.js <path>` — direct agent invocation
- **Scanner only:** `opensourcecobol4j/tools/cobol_repo_scanner.sh <path>`
- **Tests:** `node --test tests/fidelity.test.js`

## Conversion pipeline (high level)
1. Scan: `POST /api/scan-repo` → classifies files (cbl/cpy/jcl/dat/other).
2. Graph: parse `CALL`/`COPY`/`PROGRAM-ID` → topological wave ordering.
3. Convert per wave (up to 5 parallel per wave, waves serial; `BATCH_SIZE` user-adjustable 1-10):
   - **Local:** `cobj` → Java
   - **Azure:** `convertCobolToJava()` in `src/ai/convert-cobol.js` (Chat Completions).
4. Compile-gate: `javac` the result. Fail → invoke `fixJavaCode()` with errors + run outputs + dep signatures.
5. `autoFixJavaCode()` regex patches — A/B-proven net positive (see Decisions log in todo.md).
6. `analyzeConversionAccuracy()` computes 0–100% with semantic penalties.
7. Optional HITL review → approve / reject / edit before writing to disk.
8. `compareRunOutputs()`: runs both COBOL (`cobc`) and Java with same stdin, diffs outputs, AI verdict.

## Non-obvious rules — read before editing

### 🚨 No silent fallbacks in generated Java
The converter MUST produce Java that fails identically to COBOL when an input file is missing (print error + `System.exit(1)`, matching `libcob status 35`). **Never** emit "Input file not found, using sample data for demonstration…" or hardcoded sample records — that hides real I/O bugs behind a green run.

Enforcement lives in three prompt-regression-tested spots:
- Primary system prompt in `src/ai/convert-cobol.js` — the "CRITICAL: FAITHFUL CONVERSION" block.
- Retry prompts in the same file (simpler + minimal variants).
- `src/ai/compare-runs.js` — treats `status 35` vs `sample data` as **divergent**, not partial.
- Repair prompt in `src/ai/fix-java.js` — strips fabricated fallbacks if found.

Scoring: `analyzeConversionAccuracy()` penalizes banned phrases; `PENALTY_GUIDANCE['Fabricated input fallback']` in `public/app.js` gives reviewer text. Auto-repair fires on compile-fail AND fabricated-fallback penalty.

If you're adding a new conversion path, replicate all four prompt guards.

### 🚨 Prompt-reinforcement for `[ai-specific]` autoFixJavaCode patches
The primary + repair prompts explicitly ban the patterns that `autoFixJavaCode` patches (final-on-mutable-field, final-on-param, abstract-on-concrete, throws-on-pure-string-helper, missing-main, unset-primitives). Rules are locked via §23 tests in `tests/fidelity.test.js`. Retirement criterion: A/B with `DISABLE_AUTOFIX=1` over ≥20 files showing a specific patch stops firing. Don't delete patches on aesthetics.

### Vendored upstream
Everything under `opensourcecobol4j/` except `tools/web-ui/` is vendored from https://github.com/opensourcecobol/opensourcecobol4j. Don't reformat, don't rename packages (`jp/osscons/opensourcecobol/libcobj/…` is correct), and don't "fix" upstream style. See `opensourcecobol4j/VENDORED.md`.

### Conversion state lives in memory + checkpoints
Active conversions are in `activeConversions` (Map). Saved to `$TMPDIR/cobol_converter_checkpoints/<id>.json` **at every wave boundary** (not just completion), so a server crash leaves partial state. On boot `loadCheckpoints()` rehydrates completed runs, and promotes `status === 'running'` records to `status === 'interrupted'` with `resumable: true`.

**Resumable conversions**: `POST /api/resume/:id` reuses the original `inputPath` + `outputDir` and seeds `fileStates` from the interrupted record so the wave loop skips terminal files (done / skipped / failed). In-flight HITL reviews can't be rehydrated — those files re-queue. See todo.md Decisions log.

### HITL pause is a Promise the worker awaits
Each file the worker picks up `await`s a Promise resolved only by `POST /api/review/:id/:fileId` (approve/reject/edit). Toggling HITL off (`POST /api/review-mode/:id`) auto-resolves every pending Promise. Don't rewrite this with setTimeout polling.

### Per-file state flips the moment a file resolves
The wave loop's `Promise.all(batchPromises)` map wraps each promise in a `.then()` that flips `conversion.fileStates[relPath]` immediately on resolve. Do NOT move state updates into a post-`Promise.all` loop — that makes every file in a batch appear to finish simultaneously.

### COBOL run preprocessor
`src/core/run/cobol-preprocess.js` runs before `cobc` compile in `/api/run`. Two rewrites:
1. Header-period fixes (AUTHOR/DATE-WRITTEN/…/PROGRAM-ID trailing periods that real-world COBOL omits).
2. `AUTO_APPLY` typo dictionary (PRINT-REX→PRINT-REC, TLIMIT→TLIMITED, CURRENT-DATA→CURRENT-DATE, etc). `HINT_ONLY` entries (ACCTREC) only surface as suggestions on compile failure — never auto-rewritten (would break ASSIGN TO file linkage).

### Interactive run via WebSocket
`/ws/run/:id/:fileId` is additive to `POST /api/run` — it spawns `java` with piped stdin/stdout and streams JSON frames for live menu-program walkthroughs. Not a real PTY (pipes, not TTY). See `src/routes/run-ws.js` and `openInteractiveRun()` in `public/app.js`.

### Divisional split for oversized COBOL
When a source exceeds `MAX_COBOL_CHARS` (default 80k), `src/core/divisional-split.js` splits at PROCEDURE DIVISION, converts Part A (DATA) and Part B (PROCEDURE) separately, then stitches deterministically. Gated by `ENABLE_DIVISIONAL_SPLIT=1` (doubles token cost).

## API map (selected routes)

### Inline in server.js
- `POST /api/convert-azure` — AI conversion worker (wave orchestration, HITL, compile-gate)
- `POST /api/run/:id/:fileId` — runs COBOL (`cobc`) + Java side-by-side with same stdin

### Mounted from src/routes/
- `POST /api/scan-repo` — walk/classify repo files
- `POST /api/convert` — local `cobj` path
- `POST /api/resume/:id` — resume interrupted conversion
- `GET  /api/graph/:id` — polled every 800ms; returns fileStates + fileMeta
- `POST /api/review/:id/:fileId` — HITL approve/reject/edit
- `POST /api/fix-java` — repair agent (SSE-streamed)
- `POST /api/fix-cobol/:id/:fileId` — apply one-click typo fix to COBOL source
- `POST /api/compare-runs` — standalone comparator
- `GET  /api/download/:id?format=maven|flat&orchestration=spring-batch` — zip export
- `GET  /api/stats`, `/api/conversions` — aggregate telemetry / history picker
- WebSocket `/ws/run/:id/:fileId` — interactive terminal (run-ws.js)

## Safety guarantees
- `/api/file-content` is realpath-scoped to conversion inputPath/outputDir + sample roots.
- Repo URLs run through `validateRepoUrl` — rejects shell metachars, non-http/non-git@ schemes.
- AI endpoints per-IP rate-limited (10/min for convert, 30/min for fix/compare/analyze).
- `activeConversions` has 2-hour TTL sweep + disk checkpoint GC at 7 days + log rotation 10MB × 5.
- Pre-commit hook at `.githooks/pre-commit` blocks `.env`, `*.log`, `node_modules/`, `graphify-out/`, files ≥ 5 MB.

## Conventions
- **Keep terse.** Don't add comments explaining *what*; only *why* when non-obvious.
- **Don't invent future features.** Three similar lines beats a premature abstraction.
- **Prompt changes = prompt regression tests.** Every fidelity rule is locked in `tests/fidelity.test.js`. If a test fails, investigate — don't edit the test to pass.
- **Never commit `.env`, `*.log`, `node_modules/`.** Covered by the pre-commit hook.
- **Don't break the compile-gate + auto-repair contract.** AI output must pass `javac` before being written to disk (compile-gate in `processFile`); if it doesn't, `fixJavaCode()` is invoked once. This is load-bearing — many failure modes the A/B showed are recoverable by the repair pass.

## Tests
`tests/fidelity.test.js` has 53 tests covering prompt-regression rules, autoFixJavaCode behavior, validateRepoUrl, checkpoint persistence/load, rate-limiter, JCL parser, divisional split, reviewer-feedback threading, resume route, interactive WS, typo preprocessor. Run: `node --test tests/fidelity.test.js`. `e2e.test.js` runs a live conversion through the real Azure API — skipped without `.env` creds.

## Known rough edges (tracked in `todo.md`)
See **todo.md** for the priority-ordered working list. Decisions log at the bottom preserves non-obvious choices (autoFixJavaCode A/B data, two-agent architecture, resume contract, etc) — read before reversing any of them.

## When in doubt
- Structure & module layout: `todo.md` § "Module layout" in Decisions log.
- Prompt fidelity: `tests/fidelity.test.js` is authoritative.
- Context completeness: `todo.md` § "Context completeness guarantees".
- Why a patch exists: `src/core/auto-fix-java.js` audit matrix at the top.
