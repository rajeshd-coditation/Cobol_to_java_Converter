# Project Context — COBOL to Java Converter

> Living document for picking up work between sessions. Update as state changes.
> Last updated: 2026-04-08

---

## What this project is

A **white-labeled, Coditation-branded web tool** that converts legacy COBOL repositories to modern Java. Built on top of the open-source **OpenSourceCobol4j** framework, with two conversion modes:

1. **Local cobj** — uses the GnuCOBOL `cobj` compiler (offline, deterministic). Currently the legacy path.
2. **AI-powered (Azure OpenAI Agent)** — sends each COBOL file to an Azure AI Foundry agent for intelligent conversion. This is the **primary demo path**.

The product is being prepared for a **customer / sales demo**, so the UX priority is "looks impressive and tells a clear story" — not feature completeness.

---

## Repo layout

```
cobol-to-java-converter/
├── README.md                # Overview, install, run
├── todo.md                  # All work items, including the active redesign
├── session-notes.md         # ← this file
├── opensource/              # Vendored OpenSourceCobol4j (currently shows as deleted in git status — needs restore)
└── opensourcecobol4j/       # Note: README references this name, but actual dir is `opensource/`. Naming is inconsistent (todo item).
    └── tools/
        ├── cobol_repo_scanner.sh
        └── web-ui/          # ← we live here for the demo work
            ├── server.js          # Express backend (1290+ lines)
            ├── aiAgent.js         # OpenAI helper (analysis / autofix)
            ├── azureAgent.js      # Azure AI Foundry conversion agent
            ├── package.json
            ├── .env.example
            ├── .env               # ← created by us (copied from example, not filled in)
            └── public/
                ├── index.html
                ├── app.js         # Frontend logic (~1715 lines)
                ├── graph.js       # ← NEW: live Cytoscape dependency graph
                ├── style.css      # ~3500 lines (full restyle pending in 9.6)
                ├── coditation-logo.svg
                └── favicon.png
```

---

## Tech stack

| Layer    | What                                              |
| -------- | ------------------------------------------------- |
| Backend  | Node.js + Express                                 |
| Frontend | Vanilla HTML/CSS/JS, Cytoscape.js + fcose layout  |
| AI       | Azure OpenAI / Azure AI Foundry agents            |
| COBOL    | GnuCOBOL `cobc` + OpenSourceCobol4j `cobj`        |
| Java     | Java 11+ (`javac`/`java` invoked at runtime)      |

**User branding rule:** the UI must NOT mention Azure, OpenAI, GnuCOBOL, or cobj. Everything is "Powered by Coditation AI".

---

## Local environment notes

- Node v22.4.1, npm 10.8.1 — installed ✅
- Java 11 (Homebrew OpenJDK) — installed ✅
- **GnuCOBOL `cobc`** — NOT installed. Needed for the legacy local conversion path. `brew install gnu-cobol` to add.
- **`cobj`** — NOT on PATH. Lives inside the (currently deleted from git status) `opensource/` tree. Would need restore + build.
- **`.env`** — copied from `.env.example` but NOT filled in. The Azure conversion path will fail until `AZURE_OPENAI_*` and `AZURE_AGENT_ID` are populated.
- Git status shows hundreds of `opensource/**` files as deleted. **DO NOT discard** — that's the vendored upstream the user may want to restore.

---

## Running the app

```bash
cd opensourcecobol4j/tools/web-ui
npm install
cp .env.example .env   # then edit .env with Azure credentials
npm start              # → http://localhost:3000
```

Currently runs cleanly. Server is started in the background by Claude during sessions.

---

## What we're actively doing — UI/UX redesign for demo

The user dislikes the current UI. We're rebuilding it as a **graph-centric demo workspace**. All decisions captured in `todo.md` Section 9.

### Decisions locked in (don't re-debate)

1. **Layout:** graph-centric workspace — slim top header (logo + repo input + Convert), left sidebar (live counts + status), main canvas dominated by the dependency graph, raw logs hidden in a `<details>` drawer.
2. **Graph style:** force-directed (Cytoscape.js + `cytoscape-fcose`), animated, glowing pulse on the active node, edges light up between active nodes and their dependencies.
3. **Logs:** hidden behind "Show details" toggle. Eventually filtered for white-labeling.
4. **Visual restyle:** full replacement of `style.css` planned (~3,400 lines → ~600). Coditation tokens: deep navy `#100c3b`, accent purple `#7c5cff`, Space Grotesk font, generous whitespace.
5. **White-labeling:** no Azure / OpenAI / cobj / cobc strings visible to the user.

### Architecture: how the graph works

**Backend (`server.js`)** — only wired into `/api/convert-azure` so far:

- After scanning the repo, builds a dependency graph from parsed `COPY` and `CALL` statements in the COBOL source. Stored on the conversion object as `conversion.graph = { nodes, edges }`.
- Each file gets a state in `conversion.fileStates`: `pending` | `active` | `done` | `failed` | `skipped`.
- `processFile()` flips state to `active` on entry; the post-batch result loop maps final outcomes back into the state map.
- New endpoint **`GET /api/graph/:id`**:
  - With `?full=1` → returns `{ ready, graph: { nodes, edges }, fileStates, currentFiles }`.
  - Without `full=1` → returns just `{ ready, fileStates, currentFiles, status }` for cheap polling.
  - Returns `{ ready: false }` while the scan is still building the graph.

**Frontend (`public/graph.js`)**:

- Exposes `window.cobolGraph = { load, destroy, applyStates }`.
- `load(conversionId)` polls `/api/graph/:id?full=1` until ready, then renders with Cytoscape + fcose force-directed layout.
- After initial render, polls `/api/graph/:id` every ~800ms and `applyStates()` diffs node classes.
- Visual states defined in the Cytoscape stylesheet (`graph.js` `styleSheet()` function). Active nodes use `#7c5cff` with shadow blur for the glow effect.
- Node click → fires `onNodeClick` callback (currently wired to existing `viewCodeComparison()` if present).

**Frontend (`public/app.js`)**:

- In `startConversion()`, after the `currentConversionId` is set, calls `window.cobolGraph.load(currentConversionId, { onNodeClick })`.
- Existing `pollStatus()` loop is unchanged — it still drives the logs and results section. The graph polls independently inside `graph.js`.

**Frontend (`public/index.html`)** — was just restructured into the new layout shell:

```
.app-shell
├── .app-header           (logo + input + Convert + AI badge/toggle)
└── .workspace
    ├── aside.sidebar     (hero copy + #liveCounts + #statusSection + progress)
    └── main.canvas-area  (graph + collapsible logs)
.results-section          (still below; full restyle in 9.6 will integrate it)
```

All existing element IDs were preserved (`repoInput`, `convertBtn`, `statusBadge`, `progressBar`, `progressStep`, `progressPercent`, `totalFiles`, `convertedFiles`, `errorFiles`, etc.) so `app.js` keeps working without changes.

### What's NOT done yet

These items are tracked in `todo.md` Section 9 but remain open:

- **9.3 layout — CSS for the new shell.** The HTML was just restructured but `style.css` still has the old `.container` / `.input-section` rules. The new `.app-shell`, `.app-header`, `.workspace`, `.sidebar`, `.canvas-area`, `.live-counts`, `.live-row`, `.live-dot`, `.compact` toggle classes have NO styling yet. **The page will look broken until this is added.** Next step.
- **9.3 wiring — live counts.** New sidebar elements `#liveTotal`, `#liveDone`, `#liveActive`, `#liveFailed`, `#liveSkipped` exist in the DOM but nothing populates them. Plan: extend `graph.js` `applyStates()` to also compute counts and call an `onStateUpdate` callback that `app.js` wires to update those elements.
- **9.1 white-labeling backend logs** — `server.js` has 68 mentions of Azure/OpenAI/cobj/cobc that will leak into the logs `<details>` drawer if a user expands it. Need a filter/rewrite step before pushing log strings.
- **9.2 graph wiring for the legacy `/api/convert` (local cobj) path** — only Azure path has the graph today. If demo uses only AI mode this is OK.
- **9.2 CICS `XCTL` / `LINK` parsing** — current edge parser only handles `COPY` and `CALL`. CardDemo has plenty of CALL/COPY edges so this is "nice to have".
- **9.4 polish** — hover tooltips, JCL/BMS-map node icons, mini-map / zoom controls.
- **9.5 polish** — completion toast, "review mode" transition.
- **9.6 full CSS restyle** — replace ~3,400 lines with ~600 once layout is settled.
- **9.8 demo polish** — sample CardDemo button, empty/loading/error states, projector test.

### Where to resume next session

If the user says "keep going" the order is:

1. **Add CSS for the new layout shell** (`style.css` — `.app-shell`, `.app-header`, `.workspace`, `.sidebar`, `.canvas-area`, `.live-counts`, `.live-row`, sidebar `.status-section` overrides, header AI badge compact styling).
2. **Wire live counts** — extend `graph.js` to compute and emit per-state counts; have `app.js` paint them into `#liveTotal` etc. Also unhide `#liveCounts` when a conversion starts.
3. **Hard-reload the page** and visually QA against an actual conversion. Iterate.
4. Then 9.6 full restyle, then 9.8 demo polish.

---

## Things to NOT do

- Don't restore or delete the `opensource/**` files from git status without asking — that's the user's vendored upstream.
- Don't `git add -A` / `git commit` anything unless the user explicitly says so.
- Don't add Azure / OpenAI / cobj / cobc strings to anything user-visible.
- Don't introduce new files outside `web-ui/public/` and `web-ui/server.js` for the redesign — keep the surface area small until the demo is done.
- Don't rename existing element IDs in `index.html` without grepping `app.js` first.
- Don't push to remote, force-push, or run any destructive git commands.

---

## Useful one-liners

```bash
# Restart the dev server (kill any existing first)
cd opensourcecobol4j/tools/web-ui && npm start

# Hit the new graph endpoint after a conversion has been kicked off
curl -s http://localhost:3000/api/graph/<conversionId>?full=1 | jq

# See server logs from the bg task (Claude session uses /private/tmp/claude-501/...)
```

---

## Open questions for the user

1. Will the demo use **only the AI conversion path**, or does the local cobj path also need the graph view?
2. Do we have a real `.env` with working Azure credentials for end-to-end testing, or should we mock the AI agent for visual QA?
3. Is there a target screen resolution / projector for the demo so we can size the graph canvas appropriately?
