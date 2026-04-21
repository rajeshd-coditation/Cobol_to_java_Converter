# Repo Cleanup & Structure TODO

Audit of `Cobol_to_java_Converter/` focused on file layout, naming, and hygiene. Goal: an ideal, navigable structure before any code changes.

## 1. Top-level structure
- [ ] README.md references `opensourcecobol4j/` but the actual directory is `opensource/`. Either rename the folder to `opensourcecobol4j/` or fix the README. Pick one canonical name and use it everywhere.
- [ ] README "Project Structure" section is out of date (no mention of `carddemo-app/`, `libcobj/`, etc.). Rewrite to reflect reality.
- [ ] Add a root `.gitignore` (node_modules, *.log, *.class, build/, .env, OS files).
- [ ] Add a root `LICENSE` file (or note that licensing lives under `opensource/COPYING`).

## 2. `opensource/tools/` — heavy cleanup needed
This directory mixes source, scripts, and a large pile of test/output artifacts.
- [ ] Move generated/output artifacts out of version control:
  - `merge-output.txt`, `report.log`, `report.txt`, `sorted-contract-id.txt`, `structure.txt`
  - `test-file-1.txt`, `test-file-2.txt`, `test.txt`
  - `test_out_check/`, `test_output/`, `test_proj/`, `test_src/`
  - Stray data files: `DA-S-BADRFP`, `DA-S-INSRPT`, `DA-S-PROPOSAL`, `DA-S-PROPRPT`, `DA-S-PRTLINE`, `DA-S-SALERPT`, `XXXXX001`…`XXXXX060`
- [ ] Decide: delete, or relocate to `tools/fixtures/` (if they are real test inputs) or `tools/.gitignored-output/`.
- [ ] Keep only intentional sources here: `cobol_repo_scanner.sh`, `web-ui/`.
- [ ] `cobol_repo_scanner.sh` — confirm it has a shebang and is `chmod +x`.

## 3. `opensource/tools/web-ui/` — naming & doc sprawl
- [ ] Too many top-level docs in a code dir. Move to a `docs/` subfolder:
  - `AI_AGENT_INSTRUCTIONS_SHORT.txt`
  - `AZURE_SETUP_GUIDE.txt`
  - `AZURE_VS_LOCAL_COMPARISON.txt`
  - `COBOL_TO_JAVA_PROJECT_REPORT.txt`
  - `COMPARISON_REPORT.txt`
  - `ENHANCED_AI_AGENT_INSTRUCTIONS.txt`
  - `PROJECT_GUIDE.md`
  - `UI_CHANGES_SUMMARY.md`
- [ ] Convert `.txt` docs to `.md` for consistent rendering.
- [ ] Standardize doc filenames to `kebab-case.md` (e.g. `azure-setup-guide.md`).
- [ ] Delete committed runtime junk: `server.log`, `test.txt`, `screenshot.png` (or move screenshot to `docs/images/`).
- [ ] JS files: pick one casing — currently mixed (`aiAgent.js`, `azureAgent.js`, `server.js`). camelCase is fine; just be consistent.
- [ ] Verify only one of `aiAgent.js` / `azureAgent.js` is actually used; delete the dead one or document the split.
- [ ] Add `web-ui/.gitignore` for `node_modules/`, `*.log`, `.env`.
- [ ] Add `.env.example` matching the variables in README (AZURE_OPENAI_*).
- [ ] Confirm `package.json` has `name`, `version`, `scripts.start`, and an `engines` field.

## 4. `opensource/` — base framework
- [ ] This is a vendored copy of opensourcecobol4j. Decide: keep as a vendored snapshot, or use a git submodule pointing at the upstream. Document the choice in README.
- [ ] If kept vendored, add a `VENDORED.md` noting upstream commit + license.
- [ ] Don't rename anything inside `opensource/libcobj/...` — that's upstream Java with its own package layout (`jp/osscons/opensourcecobol/libcobj/...`), which is already idiomatic.

## 5. `opensource/carddemo-app/`
- [ ] This is the AWS carddemo sample. Same call as #4: vendor vs submodule. Add a `README.md` inside it noting source + purpose (test fixture for the converter).

## 6. Naming conventions to enforce repo-wide
- [ ] Directories: `kebab-case` (current mix: `web-ui` ✓, `carddemo-app` ✓, `user_util` ✗ — but that's upstream Java, leave it).
- [ ] Markdown docs: `kebab-case.md`.
- [ ] Shell scripts: `kebab-case.sh` (rename `cobol_repo_scanner.sh` → `cobol-repo-scanner.sh` if touching it).
- [ ] JS: `camelCase.js` (already mostly the case).
- [ ] Java: leave alone — upstream conventions.

## 7. Validation steps after cleanup
- [ ] `npm install && npm start` in `web-ui/` still works.
- [ ] README install paths match real directories.
- [ ] `git status` is clean after a fresh `npm start` (i.e., logs/outputs are gitignored).
- [ ] No files >1 MB committed unless intentional fixtures.

## 9. UI/UX redesign — graph-centric demo view
Goal: replace the current log-heavy UI with a Coditation-branded, graph-first experience that visualizes COBOL → Java conversion in real time. Decisions captured: graph-centric workspace layout, force-directed animated graph with glowing active node, full CSS restyle, raw logs hidden behind a "Show details" toggle.

### 9.1 White-labeling (done)
- [ ] Audit `public/app.js` console.log calls for stack mentions (lower priority — devtools only).

### 9.2 Backend: dependency graph + per-node progress
- [ ] Wire graph + fileStates into the legacy `/api/convert` (local cobj) path — currently only `/api/convert-azure` builds the graph.
- [ ] Parse CICS `XCTL` / `LINK` in addition to `CALL` / `COPY` for richer edges.
- [ ] (Optional) Switch from polling to SSE (`/api/events/:id`) for lower-latency node updates — keep polling fallback.

### 9.3 Frontend: graph-centric layout (mostly done)
- [ ] Move the AI toggle into a real settings cog menu (currently a compact pill in the header).
- [ ] Restyle existing modal headers to match new theme.

### 9.4 Frontend: dependency graph component (mostly done)
- [ ] Hover tooltip: filename, type, conversion duration, error (if any).
- [ ] Type-based icons/colors for JCL and BMS map nodes (currently only program vs copybook).
- [ ] Mini-map or zoom controls for large repos.

### 9.5 Frontend: live progress wiring (done)

### 9.6 Visual restyle (v2 overrides done)
- [ ] **Post-demo cleanup:** delete legacy CSS rules now overridden by the v2 block (drop ~3,400 → ~600 lines). Only safe to do after a real conversion run verifies which detail-view rules are still needed.
- [ ] Verify accessibility basics: focus rings, contrast on dark bg, keyboard nav for sidebar.
- [ ] Tighten / restyle obscure detail views (accuracy circles, code mapping panels, dep chips, diff views) once we've seen them in a real conversion.

### 9.7 Logs drawer (done)

### 9.8 Demo polish (mostly done)
- [ ] Test on a projector resolution (1920×1080) before the demo.

### 9.9 Validation (mostly done)
- [ ] Graph stays usable with 100+ nodes (perf check) — verified at 180 nodes; could still tune for 500+.

---

## 10. Human-in-the-Loop (HITL) review
Goal: let a human reviewer pause the conversion at each (or selected) file, inspect the COBOL → Java translation, and Approve / Reject / Edit before the result is written to disk. No LangGraph required — we use a simple per-file `Promise` that the worker `await`s until the review endpoint resolves it.

### Phase 1 — minimum viable HITL (done & verified)

### Phase 2 — durability + UX polish (done & verified)
- [ ] Replace in-memory `activeConversions` with a checkpoint store (SQLite or JSON file) so a server restart doesn't lose pending reviews. **Deferred:** low demo value, high risk; tackle post-demo.
- [ ] Diff view between AI output and human-edited Java in the review modal. **Deferred:** worth a dedicated session — needs a decent line-diff implementation or library to do well.

### Phase 3 — only if scope grows
- [ ] If the agent grows multiple specialized stages (parser → translator → validator → optimizer) with branching, port the agent loop to **LangGraph.js**. Keep the Express server unchanged — LangGraph would replace only the per-file conversion function inside `azureAgent.js`.
- [ ] Multi-reviewer support: route different file types to different reviewers. Would need real auth, not just a session cookie.

---

## 11. UX improvements — medium effort
- [x] **Syntax highlighting** for COBOL + Java using Prism.js CDN. _Already loaded in `index.html`._
- [x] **Export report** — done as the "Download" button (zips Java + MANIFEST.md + MANUAL_REVIEW.md + report.json).
- [ ] **Smooth phase transitions** — fade in/out between workflow steps instead of instant show/hide. CSS `opacity` + `transition`.
- [ ] **Loading spinner** between clicking Convert and the pre-convert modal appearing (scan/clone can take 5-10s with no feedback).
- [ ] **Line numbers** in code panels — easier to reference specific lines during review.

## 12. UX improvements — bigger lifts
- [ ] **True interactive terminal** — replace `spawnSync` with `node-pty` + WebSocket for live stdin/stdout. Let users walk through a menu program during the demo.
- [ ] **Feedback loop to AI** — send rejection reasons + edits back to the agent as context for subsequent file conversions in the same run.
- [ ] **Export as Maven project** — generate `pom.xml` + directory structure, downloadable as `.zip`. _Partly covered by the current zip — needs `pom.xml` + src/main/java layout._
- [x] **Side-by-side output comparison** — done. Run panel runs both + AI verdict banner.
- [ ] **Responsive / mobile layout** — proper hamburger menu + stacked layout for tablets/narrower screens.

## 8. Nice-to-haves (defer)
- [ ] CI workflow that lints JS + checks README links.
- [ ] Pre-commit hook to block `*.log`, `node_modules/`, `.env`.
- [ ] Architecture diagram in `docs/`.

---

## 13. Conversion quality gates (new — noticed during demo runs)
The converter currently marks a file `SUCCESS` as soon as the AI returns what looks like Java. Several files ship as SUCCESS but fail `javac` or hit runtime errors the user hits later. Close the loop.

- [ ] **Post-generation compile validation.** After `convertCobolToJava()` returns, immediately run `javac` against the output (with staged siblings). If it fails → retry the AI once with the compile errors fed back into the prompt. If still fails → mark `COMPILE_FAIL` with the real error, not SUCCESS.
- [ ] **Stronger `autoFixJavaCode` rules.** IOException auto-fix is in; add:
  - Remove `final` on fields assigned after declaration
  - Delete calls to methods that aren't defined in the same class (replace with `// TODO: call X not implemented`)
  - Cast `String` → right type when added to a typed `List<T>` (or change the list to `List<String>`)
  - Remove stray `package …;` lines
- [x] **Source integrity pre-check.** _Done 2026-04-21. `src/core/source-integrity.js` runs in processFile before the AI call. Flags `SKIPPED_INCOMPLETE_SOURCE` when (a) the tail 400 bytes contain NONE of END PROGRAM / STOP RUN / GOBACK / EXIT PROGRAM, AND (b) the last non-blank, non-comment content line doesn't end with a period. Both conditions must fire — conservative to avoid false positives. Frontend SKIPPED_STATUSES set + status switch + getDetailedReason + REASON_MAP updated. Tested on truncated + 3 complete-source variants (STOP RUN / GOBACK / END PROGRAM endings + trailing comment)._
- [x] **"Before / after" diff view** for the Fix-with-AI flow. _Done 2026-04-21. New `GET /api/fix-diff/:id/:fileId` (src/routes/unfix-java.js) returns `{before, after, hasBackup}`. UI button "View fix diff" opens a side-by-side modal using the existing code-comparison pane styles + Prism highlighting. Shows only when a .java.before-fix backup exists (probed on file selection)._
- [x] **Undo Fix-with-AI.** _Done 2026-04-21. `POST /api/unfix-java/:id/:fileId` restores .before-fix → .java, deletes the backup (so fix-then-unfix-then-fix cycles work), recompiles (flips status back based on the restored code), re-scores accuracy (stripping the "Auto-repaired" penalty). UI "Undo fix" button pairs with "View fix diff" — both appear together when the backup exists, hidden otherwise._
- [ ] **Fix-with-AI for COBOL** — parallel to the Java repair. When `cobc` reports `'X' is not defined` with a typo-hint match, offer a one-click "apply suggested fix" that rewrites the source file (with backup).

## 14. Dependency types we still don't detect
Widen the graph so real enterprise repos light up correctly.

- [ ] **`EXEC SQL INCLUDE <name>`** — SQL copybook references (very common with DB2). Parse and treat like `COPY`.
- [ ] **`EXEC CICS LINK PROGRAM('X')` / `XCTL`** — CICS program-call equivalents. Edge kind `cics-link` / `cics-xctl`.
- [ ] **`EXEC CICS SEND MAP('X') MAPSET('Y')`** — BMS map dependencies. Node type `bms-map`.
- [ ] **IMS: `CALL 'CBLTDLI' USING …, PCB-FOO`** — IMS database pointer references.
- [ ] **DB2 DBRMLIB / PLAN references** read from JCL STEPLIB — needs the JCL analyzer to cross-reference.
- [ ] Also: surface unresolved CALL targets (those that don't map to a sibling file) as `missing-external` nodes so the graph shows the "outside the repo" boundary explicitly.

## 15. JCL as context (not just `SKIPPED_JCL`)
We already have `/api/jcl-analysis`; wire it into the product.

- [ ] **Orchestration tab in Results browser.** For each JCL file, render the parsed steps (EXEC PGM=…, DD statements, DSNs) with cross-references to converted Java classes. "This JCL invokes PAYROL00 → see `Payrol00.java`".
- [ ] **Feed JCL context into the AI converter.** When converting a program, if JCL referencing it is in the repo, pass the expected dataset names + DD-to-DSN mapping so the AI generates proper file paths (not guessed).
- [ ] **Generate orchestration scaffolding** as part of the zip download — `jobs/PAYROLL.spring-batch.xml` (Spring Batch) or `jobs/PAYROLL.yaml` (Airflow DAG) templates from parsed JCL.

## 16. Scaling / very large repos
- [ ] **Divisional splitting for oversized programs.** The truncation detector fires today; implement a real split when it fires repeatedly: convert DATA DIVISION + PROCEDURE DIVISION in separate AI calls, stitch the resulting class, consistency-check field names. Only build after real data shows this is needed.
- [ ] **Partial re-run.** "Convert only FAILED files" button that takes the previous conversion's errorFiles and reruns just those.
- [ ] **Resumable conversion.** If server crashes or user closes tab, resume from last-completed wave instead of restarting.
- [ ] **Token budget cap.** Per-conversion tokens ceiling with graceful stop + partial report. Protects against runaway cost on massive repos.
- [ ] **Concurrency knob in UI.** Let the user dial `BATCH_SIZE` (currently hardcoded to 5) based on their Azure rate-limit tier.

## 17. Observability / ops
- [x] **File-backed logger + `/api/logs` endpoint.** _Done — writes to `webui.log`, JSON-per-line._
- [x] **Log rotation.** _Done 2026-04-21. `src/util/logger.js` rotates at 10 MB, keeps webui.log.1 .. .5. Checked on every append (cheap stat)._
- [x] **Memory hygiene for `activeConversions`.** _Done 2026-04-21. `src/persistence/active-conversions-ttl.js` sweeps every 5 min, evicts completed entries older than 2h. Running conversions never evicted. Disk checkpoint survives; deep-linked users rehydrate on request._
- [x] **Checkpoint GC.** _Done 2026-04-21. `cleanupOldCheckpoints()` runs once at boot, prunes entries older than 7 days based on the checkpoint's own completedAt/startedAt (not filesystem mtime)._
- [ ] **`run.sh logs`** command — tail the webui.log.
- [x] **Token/accuracy telemetry endpoint.** _Done 2026-04-21. `/api/stats` (src/routes/stats.js) rolls up every in-memory conversion: conversions count, files by status, avg/median accuracy, fail rate (successes / real attempts — skipped statuses excluded from denominator), tokens per conversion + per file + total calls, avg/median duration._
- [x] **Health endpoint.** _Done 2026-04-21. `/api/health` returns uptime, activeConversions breakdown, AI availability, tmpdir. Safe to expose for k8s liveness probes._

## 18. Security / input hygiene
- [x] **`/api/file-content` path scoping.** _Done 2026-04-21. `src/routes/misc.js` now gates on allowed roots (each active conversion's inputPath + outputDir, plus bundled sample paths). Both sides resolved through `fs.realpathSync` so `..` and symlink tricks can't escape. Absolute paths only; relative → 400; outside roots → 403._
- [x] **Command-injection review** for `execSync` calls. _Done 2026-04-21 audit. All user-controlled input into shell-quoted `execSync`/`spawnSync` either passes through `validateRepoUrl` (rejects shell metachars + non-http schemes) or comes from regex captures restricted to `[A-Za-z0-9_-]+` (COBOL PROGRAM-ID); all other paths are server-built tempdir paths (`os.tmpdir() + Date.now().toString()`). No unquoted interpolations remain._
- [x] **Sanitize repo URLs** before `git clone`. _Done 2026-04-21. `src/util/validate-repo-url.js` gates both `/api/scan-repo` and `/api/convert-azure`. Rejects shell metachars (\`$;|&<>\\!*?(){}[]"'\n\r\` and control chars), non-http/non-git@ schemes (file://, ftp://, javascript:, data:). Returns structured `{ok, kind, value}`. 3 test cases cover injection + scheme + happy path._
- [ ] **Rate-limit AI endpoints** (`/api/fix-java`, `/api/compare-runs`, `/api/convert-azure`) per-IP to prevent token-spend abuse if exposed publicly.
- [ ] **`.env` history check** — confirm no accidental commit of real API keys in git history. If found, rotate keys and rewrite history.

## 19. UX polish (noticed during demo)
- [ ] **Copy-to-clipboard** button on code panes (COBOL and Java). Tree/pane titles have a "Copy" indicator but the button isn't always wired.
- [ ] **Diff highlighting** between the original AI output and a Fix-with-AI result. Re-uses #13's diff view.
- [ ] **Keyboard shortcut cheatsheet.** `?` opens a modal listing Esc/Enter/M (maximize)/D (download)/F (fix)/etc.
- [ ] **Accuracy histogram** in the KPI bar — a tiny distribution of per-file scores to spot bimodal repos (mostly 100% + a few <50%).
- [ ] **Graph edge legend.** A small key showing what each edge kind means (`call` solid purple, `copy` dashed blue, `data` dashed amber, `cics-link` TBD, etc.).
- [ ] **Fullscreen-single-pane.** Max button is repo-wide; add a per-pane "Expand this pane" icon so the user can focus on just COBOL or just Java.
- [ ] **Stdin display in Run panel.** Show exactly what got fed to each program (including our padding) so the user understands why a program looped.
- [ ] **Empty state improvements.** "Select a file to view COBOL and Java side by side" is clear; similar treatment for empty graph / empty tree / no AI configured.

## 20. Testing (none exist today)
- [ ] **Unit tests** for the helpers that have real logic: `detectTruncation`, `editDistance`, `parseJcl`, `preprocessSource`, `autoFixJavaCode`, `classifyArtifact`. Use `node --test` or `vitest` — no heavy framework.
- [ ] **Integration test** that converts + compiles + runs a fixture (CBL0033.cobol → Cbl0033.java → java) end-to-end.
- [ ] **UI smoke test.** Playwright script that scans a sample repo, starts conversion, waits for Results, clicks a file, hits Run, and verifies the banner renders.
- [ ] **Prompt regression tests.** Golden outputs for `compareRunOutputs` across the N scenarios we've seen (match / partial / diverge / compile-fail / missing-data) — re-run on prompt changes to catch regressions.

## 21. Nice ideas, not urgent
- [ ] **Dark-mode toggle remembers preference** in localStorage.
- [ ] **Per-run cost readout.** We already track tokens; convert to USD via a hardcoded price table and show "This run cost ~$0.42".
- [ ] **Bookmark a conversion.** Pretty URL `/c/<conversionId>` that deep-links into the Results browser.
- [ ] **Compare two conversions** side-by-side (same repo, different AI / prompt versions) to A/B-test prompt changes.
- [ ] **Dictionary of known typo fixes** — expand the edit-distance hinter with a curated list (e.g., `PRINT-REX → PRINT-REC`) that we've seen real repos ship.

---

## 22. Graphify-derived recommendations (2026-04-21)
Surfaced by running `/graphify` over `opensourcecobol4j/tools/web-ui/` + repo-root docs. The graph (297 nodes / 468 edges, 23 communities) made structural holes visible that code-reading alone wouldn't surface. Ordered by functional impact.

### 22.1 Compile-gate before SUCCESS — DONE
No node in community 0 ("Conversion Pipeline Core", 52 nodes) links to any `javac` / compile-validation step. Files currently ship as `SUCCESS` the moment the AI returns Java-shaped text, and reviewers discover compile failures later in the Run panel.
- [x] `processFile` now runs `javac` on the generated Java via a `compileAndRun()` helper immediately after `convertCobolToJava()`.
- [x] On compile fail (or on `Fabricated input fallback` penalty), auto-invoke `fixJavaCode()` once with compile errors + cobolSource + runOutput + dependencies. Re-compile + re-run + re-score on the repaired code.
- [x] If still failing → `COMPILE_FAIL` status with the real `javac` error (entry flipped, `error` field populated).
- [x] Local `cobj` path gated too (§23.3.3: `runCompileGateOnReport`). Azure path has an in-line gate; both flip to COMPILE_FAIL if needed.
- (Deferred) Skip-gate toggle for demo-speed runs — not wired; current cost is ~1s of javac per file, not worth a knob.

### 22.2 Auto-repair when `Fabricated input fallback` fires — DONE
This session added a penalty for the banned sample-data fallback, but the penalty only *flags* in the accuracy banner — a reviewer still has to click "Fix with AI" manually. That defeats automatic detection.
- [x] `processFile` checks `penalties.includes('Fabricated input fallback')` AND `compilationError`. Either condition triggers `fixJavaCode()` once (combined trigger tag `compile | fallback | compile+fallback`) and the system prompt for `fixJavaCode` already covers both ("COMPILES cleanly" + "REMOVE FABRICATED INPUT DATA").
- [x] Re-scored + persisted on success. On failure, the penalty stays visible in the accuracy banner for the reviewer to act on.

### 22.3 Decide the fate of the Agent API path — DONE (deleted)
`convertWithAgent()` is a god node (7 edges) but has **no retry logic** — the Chat Completions path does (up to `MAX_RETRIES` with progressively simpler prompts). Dual paths also double the prompt surface we keep in sync (we already had to inject the fidelity rule in both this session).
- [x] Traced: Agent API path only activated when `agentId && !isAIFoundry`, which is the classic-Azure-OpenAI-with-agent config — rarely used, never benefited from any context work.
- [x] Deleted `convertWithAgent`, the parallel `agentId && isAIFoundry` branch in `analyzeConversionFailure`, and the shared thread helpers (`createThread`, `addMessage`, `runAgent`, `waitForRun`, `getRunStatus`, `getMessages`). `AZURE_AGENT_ID` env var removed from reads, config, and getConfig's return shape.
- [x] Updated `.env.example`, README, CLAUDE.md, azure-setup-guide.md, project-guide.md with migration notes (the old env var is safely ignored if still present in users' `.env`).
- [x] Single Chat-Completions path now handles both Azure OpenAI and AI Foundry, carries all context improvements (copybook bodies, sibling signatures, JCL invocations), and has retry + truncation detection.

### 22.4 Kill or document `aiAgent.js` — DONE (narrowed)
Community 10 has its own `analyzeConversionFailure()` / `autoFixCobolCode()` that overlap (via `semantically_similar_to` edges) with same-named functions in `azureAgent.js`. A maintainer doesn't know which actually runs at a given callsite.
- [x] Traced every caller. `/api/ai/status` and `/api/ai/fix` had zero frontend callers → deleted. `autoFixCobolCode` was only used by the dead `/api/ai/fix` → deleted from the module.
- [x] `/api/ai/analyze` now prefers `azureAgent.analyzeConversionFailure` when Azure is configured, falls back to `aiAgent.analyzeConversionFailure` only when Azure isn't available. Response includes `analyzer: 'azure' | 'openai'` so the UI can disclose which ran. No more silent divergence between the two implementations.
- [x] Top-of-file docstring on `aiAgent.js` now explicitly marks it as the OpenAI-direct fallback with a "keep this narrow" directive for future maintainers.
- Exposed surface dropped from 5 to 4 exports (removed `autoFixCobolCode`).

### 22.5 Split `azureAgent.js` (~2020 lines) — DONE 2026-04-21
azureAgent.js dropped from 2255 → 53 lines (a pure re-export facade). Full layout now:
- [x] `src/ai/azure-client.js` — initializeAzure + makeOpenAIRequest (retry + DEBUG_PROMPTS) + isAvailable + getConfig.
- [x] `src/ai/convert-cobol.js` — convertCobolToJava (primary + retry prompts, fidelity rules).
- [x] `src/ai/fix-java.js` — repair prompt.
- [x] `src/ai/analyze-failure.js` — failure analyst (was analyzeConversionFailure).
- [x] `src/ai/compare-runs.js` — run-verdict comparator.
- [x] `src/core/auto-fix-java.js` — autoFixJavaCode + detectTruncation.
- [x] `src/core/accuracy-scorer.js` — analyzeConversionAccuracy + penalty rules.
- [x] `src/scan/cobol-scanner.js` — scanForCobolFiles + scanForAllMainframeFiles.
- [x] `src/util/pascal-case.js` — toPascalCase (was triplicated across server.js + azureAgent.js).
- [x] azureAgent.js is now a 53-line facade that re-imports the surface server.js expects.
- Dead code deleted in the process: predictProgramOutput (~110 lines, zero callers), convertDirectory (~63 lines, zero callers).
- Latent bug fixed: 8 `azureConfig` references survived the azure-client extraction and would have thrown ReferenceError on first call; replaced with `isAvailable()` / `getConfig()`.
- Tests scan azureAgent.js + every file under src/ai/ via `readAllPromptSources()` so prompt-regression assertions stay stable across future splits.

### 22.6 Move or rename `context.md`
Two INFERRED `rationale_for` edges cite `context.md` as design rationale for real product decisions (Coditation white-labeling, dialog replacement). If `context.md` is living session notes, that's a stability mismatch — specs shouldn't cite scratchpads.
- [ ] Decide: durable doc → move to `docs/context.md` with a clear "design rationale" header.
- [ ] Ephemeral → rename to `session-notes.md` and optionally gitignore.

### Not worth acting on (recorded for completeness)
- 22 weakly-connected API endpoints (routes have ≤1 graph edge). Not a bug; SPA calls them via `fetch('/api/…')` strings the extractor can't tie to route handlers. Cosmetic; defer unless we add many more endpoints.
- Community 15 reports 0 nodes in the report body despite clustering them — rendering quirk in graphify's report generator, nodes exist in `graph.json`.

---

## 23. Data-fidelity audit: truncation + context gaps (2026-04-21)
Two classes of problem the user flagged: (a) we were silently **truncating COBOL/Java input** on several AI-call paths, dropping mid-file content the model never saw; (b) we were passing **incomplete context** at several callsites even though the right data was available elsewhere in the system.

### 23.1 Input truncation caps — FIXED
All four source-carrying paths were silently slicing content before sending to the model. Now send full content everywhere, matching `convertCobolToJava`'s policy.
- [x] `fixJavaCode` — was `snippet(cobolSource, 4000)` + `snippet(javaCode, 5000)` + `snippet(compileErrors, 2000)` → now full. Mid-file bugs were invisible to auto-repair.
- [x] `analyzeConversionFailure` (azureAgent + agent branches) — was `cobolSource.substring(0, 6000)` → now full.
- [x] `predictProgramOutput` — was COBOL + Java both capped at 3500 → now full.
- [x] `aiAgent.js` legacy `analyzeConversionFailure` — was 8000-char hard cut-off with "(truncated)" marker → now full.
- Kept: runtime stdout head+tail at 1500 chars in repair prompt (stuck-in-loop programs emit megabytes of repetitive output — head+tail tells the story).
- Kept: runtime capture cap of 8000 bytes in `/api/run` (server-side, prevents OOM on stuck programs).

### 23.2 Context gaps — NOT YET FIXED
Every AI-call site should receive the structural context that's already in scope. Several currently don't.

#### 23.2.1 `compareRunOutputs` sees runtime outputs but not source — FIXED
The AI comparator currently judges "is Java behavior equivalent to COBOL behavior?" with only `cobolOutput` and `javaOutput` in hand — no COBOL source, no Java source. When outputs differ numerically, the comparator can't distinguish "Java got a different answer (divergence)" from "Java applies a known semantic transformation (expected)".
- [x] `compareRunOutputs` now accepts optional `cobolSource` + `javaCode` and prepends them to the user prompt. `/api/compare-runs` additionally accepts `conversionId + relativePath` and reads the files off disk server-side, so the frontend doesn't have to re-POST bytes it already fetched. Frontend wired to send the identifier.

#### 23.2.2 `analyzeConversionFailure` gets no dependency / copybook / JCL context — FIXED
Failure analysis sees only `cobolSource + errorLog + errorType`. If the failure is "COPY MISSING-BOOK" or "CALL 'UNKNOWN-PROG'", the agent can't tell the user "…but in your repo `MISSING-BOOK.cpy` exists at `/copy/`" — that info was in the scan but never forwarded.
- [x] Both `aiAgent.analyzeConversionFailure()` and `azureAgent.analyzeConversionFailure()` now accept an optional `context = { calledPrograms, copybooks, programIdToJavaClass, copybookBodies }` and emit a `REPO CONTEXT` block in their user prompts.
- [x] `/api/ai/analyze` accepts `conversionId + relativePath` and calls `buildAnalysisContext()` which pulls the real CALL/COPY graph state + copybook bodies off the active conversion. Falls back gracefully to source-only parsing when no conversion is given.

#### 23.2.3 Copybook CONTENT is never inlined — FIXED
The conversion context block lists copybook NAMES (`COPY targets: FOO, BAR`) but not their BODIES. So when the AI sees `COPY CVACT01Y` in a program, it knows "a copybook named CVACT01Y was referenced" but has to GUESS the field names and PIC clauses inside it. This produces wrong data structures in Java.
- [x] For each `COPY X` in the current source, `processFile` now reads `X`'s actual `.cpy` from the scan and forwards the body in `context.copybookBodies`. `convertCobolToJava` emits the contents inline under a `=== COPYBOOK X ===` header so the AI sees real PIC clauses.
- [x] Per-conversion `copybookBodyCache` dedupes reads; 200 programs referencing the same 10 copybooks don't cause 2000 filesystem reads.
- [x] Size-gated at 40k chars of total copybook payload per conversion — beyond that, the largest are omitted with a note (current heuristic: first-come wins, largest skipped; refine if a real repo hits the cap).

#### 23.2.4 Sibling Java method signatures are never surfaced — FIXED
The current dependency block says "`FOO` → class `Foo` (exists — use `new Foo().run(...)`)" but never tells the AI what `run(...)` takes as parameters. When `PROG-A` calls `PROG-B USING WS-CUST-ID`, we want the generated Java to emit `new ProgB().run(wsCustId)` — but without knowing `ProgB.run()` signature, the AI guesses. This causes compile errors that trigger our new auto-repair (expensive).
- [x] `processFile` extracts the primary public method signature from `fixedJavaCode` (after any repair pass) via regex, picking the first non-`main`/non-constructor method as the entry, falling back to `main`. Cached on `conversion.siblingSignatures` keyed by UPPERCASE basename AND PROGRAM-ID so both resolution paths hit.
- [x] Wave ordering guarantees callees convert before callers, so the signature is present when the caller assembles its context. `convertCobolToJava` emits the signature under each CALL line as `entry signature: <full Java signature>`.
- Known limitation: picks ONE signature per class. If a COBOL CALL targets a specific entry (CICS-style), we currently don't model which one. Revisit if real-world COBOL with multi-entry patterns shows up.

#### 23.2.5 JCL parsed but not fed to conversion — FIXED
`/api/jcl-analysis` extracts DD names, DSNs, and PGM steps — but that data is shown to the user only. When converting `PAYROL00` that JCL invokes with `DD PAYFILE DSN=PROD.PAYROLL.DAT`, we want the generated Java to use `"PAYFILE"` (or a resolvable constant) as the file path, not whatever the AI guesses. Currently: pure guess. (Todo.md §15.2 already asks for this; restated here because the audit confirms it's part of the context-fidelity problem, not just an orchestration feature.)
- [x] Scan loop now populates `conversion.jclContext[PROGRAM_ID] = [{ jclFile, stepName, dds: [...] }]` alongside the existing `dataFileLookup` — same JCL parse pass, no extra I/O.
- [x] `processFile` looks up JCL invocations by basename AND by declared PROGRAM-ID (handles `file CBL0033.cbl → PROGRAM-ID PAYROL00` mismatch), passes as `context.jclInvocations`.
- [x] `convertCobolToJava` emits a `JCL invocations` section in the context block with explicit instruction: "use the DD NAME as the Java file path". This aligns with the existing `/api/run` staging code, which also uses DD name as the on-disk filename when materializing data files into the work dir — so the generated Java now matches the runtime convention.
- Also addresses todo.md §15.2 which asked for the same wiring.

#### 23.2.6 `cobolOutput` is null in auto-repair — PARTIALLY FIXED
Our new compile-gate + fabricated-fallback repair pass calls `fixJavaCode` with `cobolOutput: null` because we haven't run COBOL yet in that phase. The repair prompt says "WHAT COBOL OUTPUTS WHEN RUN" — if that's empty, the agent has no target behavior to match.
- [x] Auto-repair now reads `conversion._lastRun[relPath].cobolOutput` if a prior `/api/run` captured it — real target behavior flows into the repair prompt. No extra cost when it exists.
- [ ] Optional enhancement: on a fresh conversion where no prior run exists, attempt a one-shot `cobc -x && run` before auto-repair to capture COBOL output on the fly. Bounded cost (only runs on files that actually needed repair). Lower priority — only useful when auto-repair fires before any user Run click.

#### 23.2.7 `/api/azure/convert` passes ZERO context — FIXED (deleted)
Direct endpoint at `server.js:3115` calls `azureAgent.convertCobolToJava(source)` with no second or third argument — so `context` is `{}` and the dependency resolver emits "no siblings available" for everything. Either this endpoint is dead code (delete it) or it's live and producing inferior conversions.
- [x] Trace confirmed dead: grep across frontend + docs found zero callers. Removed (along with sibling dead endpoints `/api/azure/status`, `/api/azure/scan`, `/api/azure/convert-directory`, `/api/azure/analyze` — none referenced). `/api/ai/provider` already covers the availability query the frontend makes.
- Result: one conversion path instead of two, half the prompt surface to keep in sync.

#### 23.2.8 Duplicate failure-analysis endpoints
`/api/ai/analyze` (legacy `aiAgent.js`) and `/api/azure/analyze` (`azureAgent.js`) both call `analyzeConversionFailure` on their respective helpers with different context completeness. Same UX surface, different quality.
- [ ] Consolidate on one. Related to §22.4 (kill or document `aiAgent.js`).

### 23.3 Consistency / correctness issues found while auditing
Miscellaneous problems surfaced during this audit that aren't purely about context or truncation.

#### 23.3.1 `/api/fix-java` does NOT recompile after applying — FIXED
The manual Fix-with-AI endpoint (`server.js:2522`) applies the repaired code to disk, re-runs the accuracy scorer, and returns success — but never tries to compile the new code. If the "fix" still doesn't compile, the user only finds out on the next Run panel click. Our auto-repair path DOES recompile (the new compile-gate). Inconsistency.
- [x] After writing `fix.javaCode`, the endpoint now runs `javac` against the result. The response includes `compileStatus` ('ok' | 'fail' | 'unknown'), `compileError` (when failed), and `newJavaStatus` (flips entry back to `SUCCESS` on successful repair, or to `COMPILE_FAIL` if the fix still doesn't compile). UI can now surface whether the fix actually worked.

#### 23.3.2 `classNameMatch` block runs only on first pass; not on repair output — FIXED
The "fix the AI's class name to match the COBOL basename" block (server.js:833-917) runs only on the FIRST `convertCobolToJava` output. When auto-repair rewrites the file, we trust the repair AI to preserve the class name. If it doesn't (rare but possible), the file on disk has a mismatched class name and compile fails on the `java -cp workDir <javaClassName>` step of the post-repair run — even though the file compiles.
- [x] Extracted the ~90-line renaming block into a top-level `normalizeClassName(code, targetClass, baseName)` helper. Called in both the initial path and the post-repair write path. Collapses 90 lines of inline regex into one call site per invocation.

#### 23.3.3 No compile-gate on the local `cobj` path (`/api/convert`) — FIXED
Our new compile-gate lives only in the Azure conversion flow (`/api/convert-azure`). The local path (`server.js:142`, invokes `cobj` compiler) produces Java via the compiler — usually it compiles because cobj emits syntactically correct Java, but there's no assertion. Worth adding for symmetry.
- [x] After the scanner script finishes, `runCompileGateOnReport(result)` iterates every `SUCCESS` entry, runs `javac`, and flips the status to `COMPILE_FAIL` (with real error text) if compilation fails. Summary totals are adjusted so KPIs are accurate. Local path has no repair agent — a failed file stays failed until the user hits Fix-with-AI manually.

#### 23.3.4 `express.json()` default 100KB body cap — FIXED
`server.js:69` uses the Express default body limit. Normal `POST /api/convert-azure` bodies are just path lists → safe for small repos, but a 2000-file selection with long paths could blow past 100KB. Fails silently with a 413.
- [x] Now `app.use(express.json({ limit: '2mb' }))`.

#### 23.3.5 No total-file-count / total-size warning before conversion — FIXED
User can select-all on a repo with 500 COBOL files and kick off 500 AI conversions with no confirmation. Each conversion = 1-3 API calls × possible repair × full source in the prompt. Easy to accidentally spend $20+ of tokens.
- [x] `preConvertStart()` now computes total selected source bytes (from the scan's `sizeBytes` metadata already on each entry) and gates on `selected.length >= 50 OR totalBytes >= 500KB`. Confirm dialog displays file count, KB, and a rough token estimate (`bytes × 0.3 × 2 + files × 4k` to cover conversion + likely repair).

#### 23.3.6 No per-file input-size skip (very large files) — FIXED
Primary `convertCobolToJava` sends the entire COBOL source. A 200KB file ≈ 65k input tokens, likely past the deployment's context window, which produces a silent API failure, three retries, then `CONVERT_FAIL` with a cryptic "AI response truncated" message.
- [x] `processFile` now short-circuits with `SKIPPED_TOO_LARGE` when `cobolSource.length > MAX_COBOL_CHARS` (80k). UI: new entry in `getDetailedReason()` + skip-list icon map + SKIPPED_STATUSES filter covers the new status.

#### 23.3.7 No per-conversion token-budget ceiling — FIXED
Todo.md §16 already asks for this. Restated here: the audit confirms we have no ceiling — we just keep calling until the conversion completes or user cancels.
- [x] `MAX_TOKENS_PER_CONVERSION` env var (default 0 = no cap) now drives `conversion.tokenBudget`. `processFile` short-circuits with `SKIPPED_BUDGET` when total tokens exceed the ceiling. UI status icon/label added. `.env.example` documents the knob + provides a ballpark $1-USD example value.

---

## 24. Strategic: regex-patch sprawl → AI-first repair (2026-04-21)
Tracking concerns raised while fixing the COBOL Programming Course repo run-time issues. We kept adding regex to `autoFixJavaCode` (Java-side) and `preprocessSource` (COBOL-side). Individually each patch is narrow and tested — but the pattern is *unsustainable*.

### 24.1 Retire `preprocessSource` EXEC SQL/CICS/DLI stripping — HIGH
Currently we strip `EXEC SQL ... END-EXEC` blocks so gnucobol can compile DB2-flavored COBOL. This is a losing battle: stripped blocks declare variables (`SQLCODE`, `SQLCA`, `DFHCOMMAREA`, `PCB-*`) that other code references, producing cascading "not defined" errors. Every fix adds another regex.
- Status: partly addressed — we now surface a clean "requires DB2/CICS/IMS preprocessor" message when the cascade is detected.
- [ ] Phase 2: **completely remove** the EXEC-stripping and detect the unsupported constructs at SCAN time. Surface the file as `SKIPPED_MAINFRAME_PRECOMPILE` (new status) with guidance. Keeps regex surface small.
- [ ] Phase 3: optionally try to locate a DB2 precompiler on `$PATH` (`db2 prep`, `dsnhpc`) and use it when available. Most users won't have one, but the detection gives us the right shape if some do.

### 24.2 Replace brittle `autoFixJavaCode` patches with a post-compile AI repair loop — MEDIUM
Current `autoFixJavaCode` has 6+ surgical regexes (illegal `throws`, reassigned `final`, throws propagation, etc.) that exist *because the AI kept making specific mistakes*. Better long-term: teach the AI not to make them once (prompt), and fall back to the Fix-with-AI repair loop for anything that still slips.
- [ ] Audit each regex in `autoFixJavaCode`. For each: document the AI mistake it patches, the test that locks it, and whether the mistake has recurred recently. Retire patches whose tests pass without them after prompt improvements.
- [ ] Strengthen primary conversion + repair prompts with explicit Java-syntax rules (no `throws` on control-flow blocks, no `static final` with later reassignment, etc.).
- [ ] Keep only patches that cover *universal* Java correctness issues (e.g. reordering imports), not patches chasing a specific AI failure mode.

#### 24.2.1 A/B test (2026-04-21) — patches are empirically NET POSITIVE
Ran 10 representative COBOL Programming Course files through two servers simultaneously — same Azure deployment, same prompts, same context — controlled solely by a `DISABLE_AUTOFIX=1` env flag that turns off `autoFixJavaCode`, `normalizeClassName`, and the auto-repair loop.

| Arm | Result | Tokens |
|---|---|---|
| **A** (patches ON — current default) | **9 / 10 SUCCESS** (5 needed auto-repair) | 96,839 |
| **B** (patches OFF) | **0 / 10 SUCCESS** | 61,836 |

Raw AI output compiles on **0 / 10** files. Every single one fails `javac` with some flavor of illegal `throws`, reassigned `final`, or callee-throws-not-caller. The patches + auto-repair lift that to **9 / 10**.

Cost: +35k tokens per 10 files for auto-repair passes (~$0.03 at gpt-4.1-mini), rescuing ~5 files. ~$0.006 per rescued file. Very worth it.

#### 24.2.2 Trade-off surfaced by the A/B test
Fix 2d's helper-name whitelist strips `throws IOException` from methods like `repeatChar` / `padRight` / `fixedLengthSpaces` whose body is pure string manipulation. This triggers a cascade on files where the AI wrapped callsites in `try { helper(...) } catch (IOException e)` — the catch becomes unreachable, compile fails, auto-repair fires.
- Net: the cascade still ends in SUCCESS via auto-repair (cost: +3k tokens / affected file).
- Known remaining fail: **CBL0004** — now passes via Fix 2d's expanded whitelist (`fixedLength\w*` etc.). Previously needed auto-repair which didn't fix it.
- Expanded whitelist (2026-04-21): `repeat*|pad*|format*|to*|trunc*|fill*|spaces*|stringOf*|left/rightJustify|center*|blank*|normalize*|fixedLength*|fixedWidth*|rightPad*|leftPad*|align*|zeroFill*|zeroPad*`. Modifier is optional (catches package-private helpers inside nested static classes).
- [ ] Long-term: replace the whitelist with a body-signal-only check PLUS a second-pass cleanup that removes unreachable `catch (IOException)` blocks. Attempted once, caused a different cascade — needs scope-walking of try/catch blocks similar to what `findBodyEnd` does for methods.

### 24.3 Java runtime bugs observed on the course repo
Two repeatable AI bugs that regex can't catch (and shouldn't) — these need prompt reinforcement + Fix-with-AI.

#### 24.3.1 `NullPointerException` on Scanner EOF
ADDAMT.cobol repro: Java throws `Cannot invoke "String.length()" because "this.custNoIn" is null` when stdin is exhausted. COBOL keeps accepting blank lines and loops forever; Java's `Scanner.nextLine()` returns `null` which the AI doesn't guard.
- [ ] Add to conversion prompt: "Any call to `Scanner.nextLine()` / similar MUST check for null and gracefully terminate the input loop (mimic COBOL's 'keep reading blanks on EOF' by reading until null)."
- [ ] Add to `fixJavaCode` repair prompt: "If the runtime output shows `NullPointerException` from input reads, wrap the read in a null check."

#### 24.3.2 Missing zero-padding on numeric output
ADDAMT shows `Total Amount = 8` (Java) vs `Total Amount = 000008` (COBOL). COBOL `PIC 9(6)` zero-pads; Java uses `%d` without format width.
- [ ] Prompt reinforcement: "When COBOL declares a display field with `PIC 9(N)`, the Java output MUST zero-pad using `String.format("%0Nd", value)` to match mainframe output formatting."

### 24.4 Run panel UX: output files not surfaced (tracked as §30)
For programs that write to FILE (not stdout) like the CBL000X series using PRTLINE, the Run panel shows COBOL stdout as `[no output]` — misleading. Need to also surface the staged output files from `work_dir/`.

### 24.5 UI theme audit: dark-on-dark issues — LOW
Fix-with-AI button was under-contrast against the light-themed Java pane header (fixed by solid-fill #7c5cff). Audit the rest of the UI for similar contrast gaps under both themes.
- [ ] Progress panel on dark mode: verify text-on-dark contrast (I used `var(--c-muted, #888)` which may be too dim on `#141230`).
- [ ] Graph tooltip dark-mode readability.
- [ ] Details panel on COMPILE_FAIL entries.

### 24.6 Per-file live progress (replace polling with SSE) — MEDIUM
Right now the frontend polls `/api/graph/:id` for per-file state updates. Each node has a coarse state (pending/active/awaiting_review/done/failed/skipped). The user asked for finer-grained per-file phase info like "converting → compiling → repairing → scoring", shown **when clicking a node**, using the same visual pattern we built for Fix-with-AI.
- [ ] Server: capture `conversion.fileTimeline[relPath] = [{ step, at, label, ms?, tokens?, meta? }]` as each phase runs in `processFile`.
- [ ] Expose via `/api/graph/:id` (add `timelines` payload) or a new per-file endpoint.
- [ ] Frontend: clicking a node opens a slide-out panel (reuse `.fix-progress-panel` CSS) showing that file's timeline — updates live while conversion is running.
- [ ] Optionally switch polling → SSE for the whole conversion once this is stable, so updates don't lag.

### 24.7 Code structure — god-files are unreadable — MOSTLY DONE 2026-04-21
Line counts after the refactor (2026-04-21):
- `server.js` — **1,820 lines** (was 3,764; −52%). Only two inline routes remain: `/api/convert-azure` worker + `/api/run`. Everything else now lives in `src/routes/`.
- `public/app.js` — **5,116 lines** (was 5,632; −9%). Four modules extracted to `public/js/` (helpers, dialogs, accuracy-panel, review-chat). Remaining candidates: browser-tree, run-modal, review-modal, AI-analyzer, export, session restore.
- `public/style.css` — 4,927 lines (untouched; Phase 6 §9.6 still pending).
- `azureAgent.js` — **53 lines** (was 2,231; −98%). Pure facade over src/ai/ + src/core/ + src/scan/ + src/util/. See §22.5 for the full module layout.

Server-side module tree now has 30+ focused modules under `src/`. Each is 30–250 lines with a clear contract. Onboarding map: read server.js (boot + two inline routes) → read `src/routes/*` for HTTP surface → read `src/core/*` and `src/ai/*` for the conversion pipeline.

**Target split — server-side** (`opensourcecobol4j/tools/web-ui/src/` subtree):
```
src/
  app.js                  # Express app + middleware + crash handlers + startup
  routes/
    scan.js               # /api/scan-repo
    convert-azure.js      # /api/convert-azure + processFile orchestration
    convert-local.js      # /api/convert (cobj compiler path)
    status.js             # /api/status/:id, /api/files/:id, /api/browser/:id
    run.js                # /api/run/:id/:file  (COBOL + Java runner)
    fix-java.js           # /api/fix-java (streaming SSE)
    graph.js              # /api/graph/:id, /api/file-timeline/:id
    review.js             # HITL endpoints (approve/reject/bulk/history)
    jcl.js                # /api/jcl-analysis
    download.js           # /api/download/:id (zip bundle)
    logs.js               # /api/logs
    ai.js                 # /api/ai/analyze, /api/ai/provider
    compare.js            # /api/compare-runs
    code-comparison.js    # /api/code-comparison + /api/file-content
  core/
    conversion-worker.js  # processFile + per-file pipeline stages
    compile-gate.js       # compileAndRun + auto-repair trigger
    preprocess-source.js  # COBOL source preprocessor (periods, EXEC strip)
    cobol-runner.js       # cobc compile + libcob run + output capture
    java-runner.js        # javac + java run + output capture
    normalize-class.js    # normalizeClassName (moved from server.js)
    compile-gate-local.js # runCompileGateOnReport for cobj path
  scan/
    classify.js           # file type detection (cobol/copybook/jcl/data/other)
    graph-builder.js      # CALL / COPY / SELECT analysis → graph + name-index
    jcl-parser.js         # parseJcl (moved from server.js)
  persistence/
    checkpoint.js         # saveCheckpoint / loadCheckpoints
    activeConversions.js  # in-memory conversion map + TTL
  util/
    logger.js             # file-backed JSON logger + /api/logs
    edit-distance.js      # typo-hint helper
    glob-regex.js         # globToRegex helper
    analysis-context.js   # buildAnalysisContext
```
Expected: `src/app.js` drops to ~150-200 lines (boot + route mounting). Each route file 50-300 lines.

**Target split — azureAgent**:
```
src/azure/
  config.js               # initializeAzure + isAvailable + getConfig
  openai-request.js       # makeOpenAIRequest (retries + SSE + prompt dump)
  convert-cobol.js        # convertCobolToJava (primary + retry prompts)
  fix-java.js             # fixJavaCode repair agent
  auto-fix.js             # autoFixJavaCode (split by fix # into separate
                          #   files eventually — Fix 2c/2d/2e/2f)
  compare-runs.js         # compareRunOutputs
  predict-output.js       # predictProgramOutput
  analyze-accuracy.js     # analyzeConversionAccuracy + penalty rules
  analyze-failure.js      # analyzeConversionFailure (Azure path)
  scan-files.js           # scanForCobolFiles + scanForAllMainframeFiles
```
`azureAgent.js` becomes a re-export facade (5 lines) to keep `require('./azureAgent')` working during the split.

**Target split — public/app.js**:
```
public/modules/
  bootstrap.js            # initial load, phase management, conversion start
  scan-ui.js              # input form, repo URL handling
  pre-convert-modal.js    # file-selection modal
  graph-integration.js    # Cytoscape wiring, node-click handlers
  results-browser.js      # tree, file selection, COBOL/Java panes
  run-panel.js            # run button, output display, diff banner
  fix-with-ai.js          # streaming SSE consumer + progress panel
  file-timeline-panel.js  # slide-out per-file phase timeline
  review-modal.js         # HITL approve/reject/edit
  accuracy-panel.js       # inline confidence banner
  chat-drawer.js          # review assistant chat
  timeline-drawer.js      # activity log drawer
  dialogs.js              # toast, confirmDialog, promptDialog
  state.js                # global state (currentConversionId, currentBrowserFile)
```
Each module uses plain ES modules (`<script type="module">`) — no bundler required; Express serves them statically.

### 24.7.1 Phasing the refactor — priority order
Don't do this in one sitting. Go route-by-route so the app is always runnable.

1. **Phase 1 (2-3 hours)** — Extract non-invasive helpers from `server.js`:
   - `util/edit-distance.js`, `util/glob-regex.js`, `util/logger.js`
   - `persistence/checkpoint.js`, `persistence/activeConversions.js`
   - `scan/jcl-parser.js`, `scan/classify.js`
   - `core/preprocess-source.js`, `core/normalize-class.js`
   These are pure utilities with zero external state — easy wins. `server.js` drops by ~800-1000 lines.

2. **Phase 2 (3-4 hours)** — Split routes one at a time:
   - Start with `/api/logs`, `/api/ai/provider`, `/api/file-content`, `/api/code-comparison` — small, self-contained.
   - Then `/api/jcl-analysis`, `/api/download/:id`.
   - Then the review endpoints (5 of them — batch together).
   - Each extraction: move handler into its own file, import in `src/app.js`, run tests.

3. **Phase 3 (4-5 hours)** — Extract `processFile` + compile-gate + scan pipeline from `/api/convert-azure`. Biggest win (~1000 lines out of `server.js`) but highest risk — the conversion state flows through many hands. Write integration test first (we have one — `e2e.test.js`), then extract.

4. **Phase 4 (2-3 hours)** — `azureAgent.js` split. Each function is already its own unit; move each to a file, keep `azureAgent.js` as a re-export facade. No behavior change.

5. **Phase 5 (4-6 hours)** — `public/app.js` modules. Use plain ES modules; each handler/UI-component becomes its own file. This is the most work because the current code uses implicit globals and monkey-patched functions (e.g. `const _origSelectBrowserFile = selectBrowserFile; selectBrowserFile = async function (...)`). Need to unwind those before splitting cleanly.

6. **Phase 6 (2 hours)** — CSS cleanup per §9.6. Drop ~4000 lines of pre-v2 rules that are no longer used.

### 24.7.2 Non-negotiables during the refactor
- `node --test tests/` must pass after every phase commit. No "big-bang" refactors.
- `e2e.test.js` (spawns server + runs real conversion) must remain green.
- No behavior change per phase — purely structural.
- Each phase gets its own commit with a clear message of what moved where.
- `package.json` gets an `"imports"` or relative-path convention so moved modules are still discoverable.

### 24.8 Activity page reorg — LOW
Current activity drawer is a flat stream that gets noisy fast on a 30-file conversion. Group by file: one collapsible row per file showing its latest phase + duration, expand for full timeline.
- [ ] Group events by `relPath`. Show latest phase in collapsed view.
- [ ] Filter controls: show only errors / only in-flight / show all.

---

### 23.4 Secondary finds (lower priority but worth capturing)
- [ ] **`compareRunOutputs` has no `fileName` disambiguation** — it receives `p.fileName` but doesn't use it for anything structural; two files compared in the same session can't be told apart by the agent if they have similar outputs. Low risk today; will matter if we add per-file verdict caching.
- [x] **No way to see WHICH context was sent to the AI** — `DEBUG_PROMPTS=<dir>` env var now makes `makeOpenAIRequest` dump every outbound prompt as JSON (url, maxTokens, messages). Off by default; documented in .env.example. Filename tags by timestamp + system-prompt hash so concurrent workers don't collide.
- [ ] **`detectTruncation()` heuristic vs. `finish_reason==='length'`** — the brace-balance heuristic can false-positive on commented-out code with unbalanced braces inside a string. Rare but observed once during testing.
- [ ] **Review-mode glob is applied to output paths, not source paths** — works fine but is counter-intuitive; documenting this would save confusion.
