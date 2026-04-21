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
        ├── server.js           Express app; ~50 API routes (see "API map" below)
        ├── azureAgent.js       Azure AI conversion + repair + run-compare
        ├── aiAgent.js          Legacy OpenAI helper (error-analysis autofix)
        ├── public/
        │   ├── index.html      SPA shell
        │   ├── app.js          Main frontend (5k+ lines; tabs, results browser, review modal)
        │   ├── graph.js        Cytoscape-based dependency graph
        │   └── style.css
        ├── docs/               Markdown guides (moved here from web-ui root)
        └── .env.example        Azure OpenAI creds template
```

## Entry points
- **Server:** `cd opensourcecobol4j/tools/web-ui && npm install && npm start` → http://localhost:3000
- **CLI (rare):** `node azureAgent.js <path>` — direct agent invocation
- **Scanner only:** `opensourcecobol4j/tools/cobol_repo_scanner.sh <path>`

## Conversion pipeline (high level)
1. Scan: `POST /api/scan-repo` → classifies files (cbl/cpy/jcl/dat/other).
2. Graph: parse `CALL`/`COPY`/`PROGRAM-ID` → topological wave ordering.
3. Convert per wave (up to 5 parallel per wave, waves serial):
   - **Local:** `cobj` → Java
   - **Azure:** `convertCobolToJava()` in `azureAgent.js` (chat completions or agent API).
4. `autoFixJavaCode()` post-processing (imports, IOException declarations, etc.).
5. `analyzeConversionAccuracy()` computes 0–100% with semantic penalties.
6. Optional HITL review → approve / reject / edit before writing to disk.
7. `compareRunOutputs()`: runs both COBOL (`cobc`) and Java with same stdin, diffs outputs, AI verdict.

## Non-obvious rules — read before editing

### 🚨 No silent fallbacks in generated Java
The converter MUST produce Java that fails identically to COBOL when an input file is missing (print error + `System.exit(1)`, matching `libcob status 35`). **Never** emit "Input file not found, using sample data for demonstration…" or hardcoded sample records — that hides real I/O bugs behind a green run.

Enforcement lives in three spots in `azureAgent.js`:
- Primary system prompt in `convertCobolToJava` — the "CRITICAL: FAITHFUL CONVERSION" block.
- Both retry prompts in the same function (simpler + minimal variants).
- Comparator prompt (`compareRunOutputs`) — treats `status 35` vs `sample data` as **divergent**, not partial.

Scoring: `analyzeConversionAccuracy()` (section 6b) penalizes the banned phrases; `PENALTY_GUIDANCE['Fabricated input fallback']` in `public/app.js` gives reviewer text. Auto-repair triggered by both compile-fail AND fabricated-fallback penalty via `fixJavaCode()`, whose system prompt also enforces the rule.

If you're adding a new conversion path, replicate all three prompt guards.

### Vendored upstream
Everything under `opensourcecobol4j/` except `tools/web-ui/` is vendored from https://github.com/opensourcecobol/opensourcecobol4j. Don't reformat, don't rename packages (`jp/osscons/opensourcecobol/libcobj/…` is correct), and don't "fix" upstream style. See `opensourcecobol4j/VENDORED.md`.

### Conversion state lives in memory + checkpoints
Active conversions are in `activeConversions` (Map). On success they serialize to `$TMPDIR/cobol_converter_checkpoints/<id>.json`; on boot the server rehydrates completed ones. In-flight runs do NOT survive a restart (per-file review Promises can't rehydrate).

### HITL pause is a Promise the worker awaits
Each file the worker picks up `await`s a Promise resolved only by `POST /api/review/:id/:fileId` (approve/reject/edit). Toggling HITL off (`POST /api/review-mode/:id`) auto-resolves every pending Promise. Don't rewrite this with setTimeout polling.

## API map (most-touched routes in `server.js`)
- `POST /api/scan-repo` (253) — clone/walk + classify
- `POST /api/convert` (142) — local `cobj` path
- `POST /api/convert-azure` (306) — AI path; builds graph, runs waves
- `GET  /api/graph/:id` (1403) — polled by frontend for live node states
- `POST /api/review/:id/:fileId` (1305) — HITL decision
- `POST /api/run/:id/:fileId` (1427) — runs COBOL + Java with same stdin, AI-verdicts the diff
- `POST /api/fix-java` (2409) — invokes `fixJavaCode()` repair agent
- `POST /api/compare-runs` (2523) — standalone comparator

## Conventions
- **Keep terse.** Don't add comments explaining *what*; only *why* when non-obvious.
- **Don't invent future features.** Three similar lines beats a premature abstraction — the codebase prefers copy/paste with intent over frameworks.
- **Prompt changes = prompt regression tests.** If you change any of the five prompts in `azureAgent.js`, eyeball a few converted files before declaring done; the model is sensitive to phrasing.
- **Never commit `.env`, `*.log`, `node_modules/`.** `webui.log` is gitignored.

## Known rough edges (tracked in `todo.md`)
- Local `cobj` path (`/api/convert`) doesn't yet build a graph — only the Azure path does.
- No automated test suite. Validate changes by running a real conversion on a CardDemo subset.
- `activeConversions` has no TTL; long-running servers leak memory.
- `public/app.js` has two generations of CSS; ~3k lines of pre-v2 rules can be deleted once a real conversion verifies which detail-view rules are still referenced.

## When in doubt
- Structure & dead code: see `todo.md` §1–§3.
- Conversion quality concerns: `todo.md` §13.
- UI polish: `todo.md` §9, §11, §19.
