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
- [ ] **Syntax highlighting** for COBOL + Java using Prism.js CDN. Code panels go from monochrome to colorful keywords.
- [ ] **Export report** — "Download JSON" button in KPI bar that dumps full conversion report (files, accuracy, tokens, risks, review history).
- [ ] **Smooth phase transitions** — fade in/out between workflow steps instead of instant show/hide. CSS `opacity` + `transition`.
- [ ] **Loading spinner** between clicking Convert and the pre-convert modal appearing (scan/clone can take 5-10s with no feedback).
- [ ] **Line numbers** in code panels — easier to reference specific lines during review.

## 12. UX improvements — bigger lifts
- [ ] **True interactive terminal** — replace `spawnSync` with `node-pty` + WebSocket for live stdin/stdout. Let users walk through a menu program during the demo.
- [ ] **Feedback loop to AI** — send rejection reasons + edits back to the agent as context for subsequent file conversions in the same run.
- [ ] **Export as Maven project** — generate `pom.xml` + directory structure, downloadable as `.zip`.
- [ ] **Side-by-side output comparison** — after running both COBOL and Java, highlight differences in their stdout.
- [ ] **Responsive / mobile layout** — proper hamburger menu + stacked layout for tablets/narrower screens.

## 8. Nice-to-haves (defer)
- [ ] CI workflow that lints JS + checks README links.
- [ ] Pre-commit hook to block `*.log`, `node_modules/`, `.env`.
- [ ] Architecture diagram in `docs/`.
