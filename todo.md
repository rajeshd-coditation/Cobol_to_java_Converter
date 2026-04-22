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

- [ ] **Version history for Java files after Fix-with-AI.** Today the fix path keeps a single `.java.before-fix` backup — subsequent fixes overwrite each other, so the user can only roll back ONE step. For real trust we need a full per-file version log: every successful fix appends a new entry with `{ timestamp, trigger (fix-with-ai / typo / manual-edit), verdictTitle, prompt (sha256 for dedup), javaBytes, accuracyBefore/After, commit-style note }`, and the UI surfaces a "History" affordance next to Copy / View fix diff. Undo becomes a picker, not a single toggle. Storage: one `<javaFileName>.history.jsonl` per file alongside `.before-fix` (append-only, cheap). Out of scope: cross-file correlated history (would need a proper transaction log).


## Next — medium, clear value (2–5 hrs each)

Good single-session work. Each delivers a coherent feature.


## Later — bigger lifts, need design first

Each of these is multi-hour and benefits from its own planning pass.

- [ ] **Phase 5 refactor: finish `public/app.js` split.** Four modules extracted (`helpers`, `dialogs`, `accuracy-panel`, `review-chat`); remaining candidates in rough priority order: browser-tree (~400 lines), run-modal (~240), review-modal (~200), AI-analyzer + baselines (~300), export (~40), session restore (~120). Each needs care with load order and monkey-patched globals.
- [ ] **Phase 6: CSS cleanup.** `public/style.css` has ~3,400 lines of pre-v2 rules. Audit (2026-04-21) identified **26 safely-dead classes** with zero references across HTML + all JS (the full bundle: `coming-soon`, `review-chat-panel`, `chat-title/messages/actions/tabs`, `post-review-*`, `run-diverge-*`, `logs-details`, `details-tabs/tab/panel/files-list`, `run-output-panel/header`, `drawer-handle`, `run-input-field`, `hero-engine-img`, `theme-dark`, `accent`, `browser-actions`, `history-list-panel`, `toast-body`) spanning ~60 rules across the file. Risk of compound-selector regression means this deserves its own session with visual verification — NOT a mass `sed` delete. Target: 4,927 → ~1,500.
- [ ] **True PTY for interactive terminal.** Current WS flow (`/ws/run/:id/:fileId`, see `src/routes/run-ws.js`) streams stdin/stdout over `child_process.spawn` pipes — works for COBOL menu programs that just ACCEPT from SYSIN. Programs that check `isatty()` or need ANSI cursor control still see non-interactive pipes. Swap in `node-pty` when there's a real use case (same message protocol, just replace the spawn call).
- [ ] **LangGraph.js port.** If the agent grows specialized stages (parser → translator → validator → optimizer) with branching. Replaces only the per-file conversion function inside `src/ai/convert-cobol.js`; Express server stays as-is.

### Even later — low priority

User-flagged as lowest priority (2026-04-21):

- [ ] **Responsive / mobile layout.** Current UI breaks below ~900px. Hamburger menu, stacked panes, tap targets sized for touch. Demo workflow runs on desktop; mobile is a nice-to-have, not a blocker.
- [ ] **Playwright UI smoke test.** Scan a sample repo, start conversion, wait for Results, click a file, hit Run, verify the banner renders. Heaviest because it needs the full Playwright install + CI wiring; existing `e2e.test.js` already covers the backend pipeline which is where regressions usually land.
- [ ] **Retire `[ai-specific]` patches once prompt reinforcement empties them.** First pass landed: the primary + repair prompts now explicitly ban the patterns Fix 2d/2f/6/8/9-10/11/24/26 correct (no-final-on-mutable-fields, no-final-on-params, no-abstract-on-concrete, no-throws-on-pure-string-helpers, require-main-for-procedure-division, initialize-primitive-fields). Rules are locked via fidelity tests §23. **Next step:** A/B ≥ 20 files with DISABLE_AUTOFIX=1 to measure which of those patches still fire on the newer prompts — any that don't can be retired one at a time. Keep `[universal]` / `[safety]` / `[locked]` patches indefinitely regardless.

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

### Module layout (2026-04-22 state)

```
server.js            ~360 lines — bootstrap + route mounts only after Phase 3a/3d
azureAgent.js        53 lines (pure facade)
src/
  ai/                azure-client, convert-cobol, fix-java, analyze-failure, compare-runs
  core/              auto-fix-java, accuracy-scorer, conversion-graph, compile-gate-local,
                     normalize-class, parse-scanner-output, manual-review, source-integrity
  core/run/          cobol-preprocess, data-file-staging, list-output-files
  routes/            19 modules (ai-analyze, cancel, compare, convert-azure,
                     convert-local, download, fix-cobol, fix-java, graph, health, jcl,
                     misc, post-review, resume, review, run, run-ws, scan-repo,
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

### Resumable conversions — new-run-from-interrupted, not in-process revival

When a server crash leaves a `status: 'running'` checkpoint on disk, boot promotes it to `'interrupted'` (see `src/persistence/checkpoint.js`). `POST /api/resume/:id` kicks off a **new** conversion that reuses the old `inputPath` + `outputDir` and seeds `fileStates` from the interrupted record so the wave loop skips every file that already reached a terminal state. We deliberately did NOT try to rehydrate the old worker's closures or in-flight Promises — pending HITL reviews are gone at crash time and there's no clean way to restart them. The contract is "we don't re-convert anything that already finished"; files that were mid-conversion or awaiting review at crash time get re-queued in the new run. Checkpoints now save after every wave (not just on completion) so the resume surface is at most one-wave-stale. The old record keeps `resumedAs: <newId>` so the UI can chain them.

### Vendored `opensourcecobol4j/`

Vendored snapshot, not a submodule. `VENDORED.md` documents the upstream commit + license. Don't rename anything inside `libcobj/` — the `jp/osscons/…` package layout is idiomatic upstream Java.
