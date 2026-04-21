# COBOL → Java Converter — TODO

Priority-ordered working list. Items are grouped by effort × value; pick from
the top. Completed work lives in git history (`git log --oneline`), not here —
this file tracks **what's left**.

When a decision is interesting enough that a future contributor would want the
reasoning (A/B test results, why X was deleted, why a particular split was
chosen), it lives in **[Decisions log](#decisions-log)** at the bottom.

---

## Now — small, high-value (≤2 hrs each)

Tractable wins. Pick any one and ship.

- [ ] **Fullscreen-single-pane.** Per-pane "Expand this pane" icon in the Results Browser so users can focus on just COBOL or just Java. Mirror of the existing repo-wide max button.
- [ ] **Per-run cost readout.** We already track tokens per conversion; convert to USD via a hardcoded price table and show "This run cost ~$0.42" alongside the token count.
- [ ] **Bookmark URL.** Pretty URL `/c/<conversionId>` that deep-links into the Results browser (rehydrate from checkpoint if the in-memory entry was evicted by §17.3 TTL).
- [ ] **AI toggle → settings cog.** Currently a compact pill in the header; move into a real settings menu where it belongs alongside future knobs (concurrency, budget cap, theme).
- [ ] **Graph hover tooltip fields.** Currently just filename; add type + conversion duration + error text when present. Backend already has all three in `fileTimeline` / `fileStates`.
- [ ] **Dictionary of known COBOL typo fixes.** Expand the `editDistance` hinter with a curated list (`PRINT-REX → PRINT-REC`, etc.) seen in real repos. Small data file + lookup before the edit-distance fuzzy match fires.
- [ ] **`compareRunOutputs` fileName disambiguation.** Currently accepts `p.fileName` but doesn't use it — two similar outputs in the same session can't be told apart by the agent. Pass into the prompt header. Low risk today; needed when we add per-file verdict caching.
- [ ] **Document review-mode glob semantics.** The glob matches output paths, not source paths — works correctly but is counter-intuitive. A one-line README note prevents future head-scratching.

## Next — medium, clear value (2–5 hrs each)

Good single-session work. Each delivers a coherent feature.

- [ ] **JCL orchestration tab in Results browser.** We already parse JCL (`/api/jcl-analysis`) but the output is only surfaced if a user hits the endpoint directly. Add a tab listing parsed steps (EXEC PGM=…, DD names, DSNs) with cross-references to converted Java classes ("This JCL invokes PAYROL00 → see `Payrol00.java`").
- [ ] **Orchestration scaffolding in the zip download.** Emit `jobs/<JOB>.spring-batch.xml` or `jobs/<JOB>.yaml` (Airflow DAG) templates from parsed JCL into `/api/download/:id`. First pass can be a single opinionated template (Spring Batch); additional orchestrators are copy-paste.
- [ ] **Partial re-run — "Convert only FAILED files".** Button on the Results view that takes the previous conversion's `errorFiles` and reruns just those. Ships with a fresh conversionId but reuses `inputPath`.
- [ ] **Concurrency knob in UI.** Currently `BATCH_SIZE = 5` hardcoded. Expose as a slider (1–10) in the new settings cog. Lets users with larger Azure rate-limit tiers go faster, and users with tighter budgets throttle down.
- [ ] **Fix-with-AI for COBOL.** Mirror of the Java repair loop. When `cobc` reports `'X' is not defined` with a typo-hint match, offer a one-click "apply suggested fix" that rewrites the source file (with `.cbl.before-fix` backup like the Java side does).
- [ ] **Export as Maven project.** Extend `/api/download/:id` to emit `pom.xml` + `src/main/java/` layout. Current zip flatten-drops `.java` into `java/`; this is a strict superset.
- [ ] **Prompt regression tests.** Golden outputs for `compareRunOutputs` across the N scenarios we've seen (match / partial / diverge / compile-fail / missing-data). Re-run on prompt changes to catch regressions. Uses the existing test infrastructure.
- [ ] **Integration test.** Converts + compiles + runs a CardDemo fixture end-to-end. `tests/e2e.test.js` exists but runs only the server; extend with an actual AI conversion against a small fixture so prompt + compile-gate + auto-repair all exercise.
- [ ] **Activity page group-by-file.** Current drawer is a flat stream that goes noisy on 30+ file conversions. Group by `relPath`, show latest phase in collapsed row, expand for full timeline. Filter chips: errors / in-flight / all.
- [ ] **Audit + retire unnecessary `autoFixJavaCode` patches.** For each of the ~32 regex fixes, document the AI mistake it patches + whether the mistake has recurred recently. Retire patches whose tests pass without them after prompt improvements. **A/B data from §decisions below says patches are net positive — don't delete on aesthetics alone.**
- [ ] **Compare two conversions side-by-side.** Same repo, different AI / prompt versions. Useful for A/B-testing prompt changes (we've done this ad-hoc via `DISABLE_AUTOFIX=1` already). UI: pick two conversion IDs from a dropdown, render per-file accuracy diff + token diff.
- [ ] **DB2 DBRMLIB / PLAN references from JCL STEPLIB.** Cross-reference the JCL parser output (we see STEPLIB DSNs) against the conversion graph so DB2-bound programs show their plan dependencies.

## Later — bigger lifts, need design first

Each of these is multi-hour and benefits from its own planning pass.

- [ ] **Phase 3 refactor: extract `/api/convert-azure` worker and `/api/run` control flow.** Both are still inline in `server.js` (the ~1,800 remaining lines are almost entirely these two). The worker has shared closure state through a 30-step pipeline; not a mechanical extraction. Write an integration test first (we have `e2e.test.js` scaffolding), then extract `processFile` → `src/core/conversion-worker.js` one stage at a time.
- [ ] **Phase 5 refactor: finish `public/app.js` split.** Four modules extracted (`helpers`, `dialogs`, `accuracy-panel`, `review-chat`); remaining candidates in rough priority order: browser-tree (~400 lines), run-modal (~240), review-modal (~200), AI-analyzer + baselines (~300), export (~40), session restore (~120). Each needs care with load order and monkey-patched globals.
- [ ] **Phase 6: CSS cleanup.** `public/style.css` has ~3,400 lines of pre-v2 rules. Walk a real conversion, grep for selectors not hit, drop. Target: 4,927 → ~1,500.
- [ ] **Retire `preprocessSource` EXEC SQL/CICS/DLI stripping.** Currently strips these blocks so gnucobol can compile DB2-flavored COBOL — losing battle (stripped blocks declare variables the rest of the code references). Plan: detect at SCAN time and surface as `SKIPPED_MAINFRAME_PRECOMPILE` with guidance; optionally probe for a DB2 precompiler on `$PATH`.
- [ ] **True interactive terminal.** Replace `spawnSync` in `/api/run` with `node-pty` + WebSocket so users can walk through a menu program live instead of pre-padding stdin.
- [ ] **Feedback loop to AI.** Send rejection reasons + human edits from HITL review back to the agent as context for subsequent file conversions in the same run. Needs a prompt-side way to say "avoid repeating mistake X shown in reviewer note Y".
- [ ] **Divisional splitting for oversized programs.** When truncation detector fires repeatedly, split DATA DIVISION + PROCEDURE DIVISION into separate AI calls and stitch the resulting class. Only build when real data shows a single file blows the context window.
- [ ] **Resumable conversion.** Worker-state checkpoint (not just the final-report snapshot we have today) so a server crash mid-run picks up from last-completed wave. Non-trivial because of in-flight Promises.
- [ ] **Responsive / mobile layout.** Current UI breaks below ~900px. Hamburger menu, stacked panes, tap targets sized for touch.
- [ ] **Playwright UI smoke test.** Scan a sample repo, start conversion, wait for Results, click a file, hit Run, verify the banner renders. Heaviest because it needs the full Playwright install + CI wiring.
- [ ] **Post-compile AI repair loop consolidation.** Decide: do we keep `autoFixJavaCode` regexes + Fix-with-AI as separate layers, or fold all deterministic Java corrections into the repair agent prompt? A/B data says regexes earn their keep today; revisit after prompt reinforcement work (see "Now" items on conversion prompt tuning).
- [ ] **LangGraph.js port.** If the agent grows specialized stages (parser → translator → validator → optimizer) with branching. Replaces only the per-file conversion function inside `src/ai/convert-cobol.js`; Express server stays as-is.

## Deferred / won't-do (explicitly parked)

Recorded so they don't keep coming back.

- **`.env` history check** — manual only; needs the user to run `git log -p -- .env*` and decide on rotation. Can't be automated from this side.
- **Multi-reviewer HITL auth** — would need real authentication (cookies + user accounts), not a session cookie. Out of scope until the product has actual users.
- **Replace `activeConversions` with SQLite.** We have disk checkpoints + in-memory TTL (§17.3/17.4); the remaining gap is "pending review survives restart", which requires rehydrating Promises. Low value for the demo shape.
- **Projector resolution test (1920×1080)** — needs a physical device.
- **Graphify weakly-connected API endpoints cosmetic** — SPA calls routes by string; the extractor can't tie them to handlers. Not a bug.

---

## Decisions log

Non-obvious choices worth preserving. Read this before reversing any of them.

### Two-agent AI architecture — conversion + repair

Primary conversion (`src/ai/convert-cobol.js`) is a single Chat Completions call with five fidelity rules pinned in the system prompt. If the output fails `javac` or hits the `Fabricated input fallback` penalty, the **compile-gate in `processFile`** auto-invokes `src/ai/fix-java.js` once with the compile errors + run outputs + dependency signatures as repair context. Both prompts carry the same ACCEPT-FROM-SYSIN + zero-padding + faithful-conversion rules; prompt-regression tests (`tests/fidelity.test.js`) lock every rule so an edit can't silently drop one.

### `autoFixJavaCode` regex patches stay (A/B-tested net positive)

A 10-file A/B on the COBOL Programming Course repo (same deployment, same prompts, same context, differing only in `DISABLE_AUTOFIX=1`):

| Arm | Result | Tokens |
|---|---|---|
| **A** (patches ON) | **9 / 10 SUCCESS** (5 rescued by auto-repair) | 96,839 |
| **B** (patches OFF) | **0 / 10 SUCCESS** | 61,836 |

Raw AI output compiles on **0/10** files every time — always some flavor of illegal `throws` on control-flow, reassigned `final`, or callee-throws-not-caller. Cost is ~$0.006 per rescued file. Don't delete patches on aesthetics; retire them only when their tests pass without them.

### Agent API / Assistants path deleted

`convertWithAgent` + the thread helpers were removed. Reasons: no retry logic, no context (copybook bodies / sibling signatures / JCL invocations never reached it), prompt rules lived in Azure Portal which meant fidelity-rule changes drifted. Chat Completions works for both Azure OpenAI AND AI Foundry, so the dual path was earning nothing. If Assistants becomes useful again, route it through the same retry+context plumbing, or wait for the Responses API.

### Dead code deleted during the split

- `predictProgramOutput` (~110 lines, zero callers)
- `convertDirectory` (~63 lines, zero callers)
- `autoFixCobolCode` from `aiAgent.js` (only caller was the deleted `/api/ai/fix` endpoint)
- `/api/azure/status`, `/api/azure/convert`, `/api/azure/scan`, `/api/azure/convert-directory`, `/api/azure/analyze` — all had zero frontend callers and duplicated `/api/convert-azure` / `/api/ai/analyze` with inferior context

### Module layout (2026-04-21 state)

```
server.js            ~1,820 lines (two inline routes remaining: convert-azure + run)
azureAgent.js        53 lines (pure facade)
src/
  ai/                azure-client, convert-cobol, fix-java, analyze-failure, compare-runs
  core/              auto-fix-java, accuracy-scorer, conversion-graph, compile-gate-local,
                     normalize-class, parse-scanner-output, manual-review, source-integrity
  core/run/          cobol-preprocess, data-file-staging, list-output-files
  routes/            13 modules (ai-analyze, cancel, compare, convert-local, download,
                     fix-java, graph, health, jcl, misc, post-review, review, scan-repo,
                     stats, status, unfix-java)
  scan/              cobol-scanner, jcl-parser
  persistence/       checkpoint, active-conversions-ttl
  util/              analysis-context, edit-distance, glob-regex, logger, pascal-case,
                     rate-limit, strip-ansi, validate-repo-url
public/js/           helpers, dialogs, accuracy-panel, review-chat
```

### Context completeness guarantees (post §23 audit)

Every AI-call site receives the structural context that's in scope:
- Primary conversion: full COBOL source, copybook BODIES (inlined), sibling Java method signatures, JCL DD-name mappings, CALL/COPY targets with PROGRAM-ID resolution.
- Repair (`fixJavaCode`): all of the above + compile errors + prior-run outputs (`conversion._lastRun[path]`).
- Failure analyst (`analyzeConversionFailure`): CALL/COPY names + PROGRAM-ID→Java-class map + copybook bodies.
- Comparator (`compareRunOutputs`): both outputs + both sources (via `conversionId + relativePath`).

No more "AI got a partial view" bugs from this class.

### Safety guarantees

- `/api/file-content` is scoped to active-conversion inputPath/outputDir + sample roots (realpath-checked so symlinks can't escape).
- Repo URLs run through `validateRepoUrl` — rejects shell metachars and non-http/non-git@ schemes.
- AI endpoints are per-IP rate-limited (10/min for convert, 30/min for fix/compare/analyze). Rate limiter is single-process; put a real WAF in front for public exposure.
- `activeConversions` has a 2-hour TTL sweep + disk checkpoint GC at 7 days + log rotation at 10 MB × 5 archives.
- Pre-commit hook at `.githooks/pre-commit` blocks `.env`, `*.log`, `node_modules/`, `graphify-out/`, and files ≥ 5 MB.

### Vendored `opensourcecobol4j/`

Vendored snapshot, not a submodule. `VENDORED.md` documents the upstream commit + license. Don't rename anything inside `libcobj/` — the `jp/osscons/…` package layout is idiomatic upstream Java.
