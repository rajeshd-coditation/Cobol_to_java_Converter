
---

# COBOL to Java Modernization Framework

## Overview

This project extends the **OpenSourceCobol4j** framework to provide a **modern Web UI** and an **AI-powered COBOL → Java conversion pipeline**. 

The framework supports:

* Local COBOL → Java conversion using `cobj` compiler
* Advanced conversion using **Azure AI Foundry Agents**
* Automated output validation between native COBOL execution and generated Java output

**Goal:** Deliver a **repeatable, auditable, production-ready modernization workflow**.

---

## Base Framework

**OpenSourceCobol4j** is the core engine:

* **Repository:** [OpenSourceCobol4j](https://github.com/opensourcecobol/opensourcecobol4j.git)
* **Purpose:** Converts COBOL programs to Java using `cobj`
* **Testing repo:**(https://github.com/aws-samples/aws-mainframe-modernization-carddemo.git)

> All enhancements in this project are built on top of this base framework.

---

## Features

* 🌐 **Web-based UI** to scan and convert COBOL repositories
* 🔄 **Two conversion modes**:

  1. Local compiler-based conversion
  2. AI agent–assisted conversion
* ✅ **Automated output comparison** (COBOL vs Java)
* 📊 Visibility of converted, skipped, and validated programs

---

## Key Capabilities

A walkthrough of what the product does — grouped by the user's journey.

### Discovery

**1. One-click repository exploration**
Paste any GitHub URL or local path. The scanner clones (if remote), walks the tree, and surfaces every source file. No manual install or CLI tooling required to get started.
*How:* shallow `git clone --depth 1` for speed, then a recursive directory walk that skips build/VCS noise (`node_modules`, `.git`, `dist`, `build`, `target`, etc.).

**2. Intelligent file classification**
The scanner distinguishes COBOL programs, copybooks, JCL jobs, data files, and unrelated assets. JCL is flagged as out-of-scope, copybooks are routed to be embedded as Java data classes, programs are queued for conversion.
*How:* extension-bucketing across five categories (`.cbl/.cob/.cobol` → programs, `.cpy/.copy` → copybooks, `.jcl/.proc` → JCL, `.dat/.csv/.txt` → data, everything else → other), plus downstream checks like *"has `PROGRAM-ID`"* to catch mis-extensioned files.

**3. Selective conversion**
You choose which files to convert — ideal for incremental modernization, scoped proofs-of-concept, or focused regression runs.
*How:* the UI posts a `selectedFiles[]` array to the conversion endpoint; the backend filters the discovered set to that allow-list before building the dependency graph.

### Understanding

**4. Dependency graph via static analysis**
Every file is parsed for `CALL` and `COPY` statements, and a dependency graph is built before any conversion runs. Because COBOL resolves `CALL` by **PROGRAM-ID at runtime** (not filename), the graph indexes both — so a `CALL 'FOO'` that targets a file with `PROGRAM-ID. FOO.` resolves correctly even if the file is named differently.
*How:* regex-based extraction of `CALL '…'` and `COPY …` targets + a second-pass regex that captures each file's `PROGRAM-ID` (including the multi-line form), merged into a single name-index so targets resolve against both filenames and declared program IDs.

**5. Live conversion visualization**
As conversion runs, nodes on the graph animate through states — *pending → converting → awaiting-review → done / failed*. The user watches progress instead of tailing logs.
*How:* the browser polls `/api/graph/:id` for per-file state deltas; Cytoscape.js re-styles nodes by CSS class, so only what changed re-renders.

**6. Dependency-aware wave processing**
Files are stratified into dependency levels: Level 0 has no COBOL dependencies, Level 1 depends only on Level 0, and so on. Each level runs in parallel; levels run sequentially. This guarantees `CALL` chains resolve correctly at Java runtime.
*How:* a topological sort over the CALL graph groups files into waves; within each wave, a `Promise.all`-with-concurrency-cap runs up to 5 AI conversions in parallel, while waves are awaited sequentially.

### AI conversion

**7. Azure AI agent translation**
An Azure AI Foundry agent preserves business logic, data structures, control flow, and arithmetic semantics. Output is idiomatic Java — not a line-for-line transliteration.
*How:* a dedicated agent (persistent `asst_…` ID) with a curated system prompt and dialect hints; the agent is invoked per-file over Azure's assistants API, with the COBOL source + any detected dependencies passed as context.

**8. Parallel batch execution**
Up to 5 files convert concurrently within each dependency wave, so a 30-program application doesn't serialize into 30 sequential API calls.
*How:* a bounded concurrency semaphore (`BATCH_SIZE = 5`) around the per-file AI call, giving roughly 5× throughput versus serial while respecting Azure rate limits.

### Quality — the differentiator

**9. Per-file accuracy score with a reason**
Every converted file receives a **0–100% confidence score** and a structured metric breakdown (COBOL lines vs Java lines, data items vs fields, procedures vs methods) — not a black-box number.
*How:* a weighted rubric combining *code-volume ratio* (35%), *data-structure coverage* (25%), *procedure coverage* (15%), *completeness checks* (10%), and *semantic checks* (15%), computed deterministically from regex-extracted metrics over both sources.

**10. Semantic penalty detection**
Patterns that need human verification are explicitly flagged: *File I/O simulated*, *Packed decimal simplified*, *CICS/IMS/DLI simplified*, *BMS adapted*, *Contains simulation markers*, *DEPENDING ON simplified*, and more. Users never wonder what the missing % represents.
*How:* each feature-specific rule looks for a COBOL trigger (e.g. `SELECT … ASSIGN`, `COMP-3`, `EXEC CICS`) and checks whether the Java uses a real counterpart (`BufferedReader`, `BigDecimal`, a CICS framework) — if not, a penalty is recorded with a named reason.

**11. Actionable guidance, not just labels**
Each flag comes with specific "what to check" guidance. *Packed decimal* → verify `BigDecimal` usage for rounding and scale. *CICS* → you'll need JCICS or an equivalent transaction framework. The reviewer gets the checklist automatically.
*How:* a curated `PENALTY_GUIDANCE` map in the frontend pairs each penalty label with reviewer-facing text; when accuracy < 100%, the guidance is rendered as a commented banner prepended to the generated Java.

**12. Human-in-the-loop (HITL) review, toggleable mid-run**
Optional pause-after-each-file workflow — reviewer can approve, reject, or edit the Java before it's written. The toggle works seamlessly mid-conversion: switch it off and the queue drains; switch it on and future files start pausing. No restart, no deadlock.
*How:* the worker `await`s a per-file `Promise` that's only resolved by a reviewer action (via `/api/review/:id/:fileId`); toggling HITL off hits `/api/review-mode/:id`, which auto-resolves every pending promise with "approve" so the worker continues.
*Glob filter:* the review-mode glob filters against **output paths** (the generated `.java` path's filename), not the source `.cbl` path. Works correctly for the common case (filename-based filtering) but is worth knowing if you're trying to target files by COBOL-side conventions (PROGRAM-ID, source subdirectory) — those won't match. Use `*Account*.java` or `*.java` rather than `*ACCT*.cbl`.

### Verification

**13. Side-by-side COBOL / Java comparison**
Click any file in the Results browser to see the original COBOL and generated Java together. The accuracy banner sits directly above the Java code, so reviewers see *"71% confidence — verify packed decimal"* before reading a line.
*How:* a single endpoint (`/api/code-comparison`) takes `conversionId + relativePath`, looks up the file's report entry, and returns the Java source plus the structured accuracy breakdown — the UI renders both in one pass.

**14. Run-and-compare output parity**
Both the original COBOL (via GnuCOBOL) and the generated Java can be executed with identical input, and outputs are diffed automatically. When `stdout` matches, the business logic survived the translation — the strongest possible verification short of a full test suite.
*How:* the backend compiles the original with `cobc` and runs both programs under the same `stdin`, captures `stdout` / exit codes, and returns a structured diff the UI renders side-by-side.

### Platform polish

**15. In-app dialogs and notifications**
Every prompt, confirm, and notification is a platform-native modal or toast — no browser "localhost:3000 says…" dialogs. Keyboard shortcuts (Esc, Enter), focus management, and hover tooltips throughout.
*How:* a small dialog/toast layer (`toast()`, `confirmDialog()`, `promptDialog()`) returns `Promise`-based results and fully replaces `window.alert/confirm/prompt`; the shared modal uses `role="dialog"`/`aria-modal` for screen reader support.

**16. Resilient: checkpointed and resumable**
Completed conversions persist across server restarts. Revisit a conversion hours later and see the same files, same Java, same accuracy breakdown. Nothing is lost.
*How:* every conversion's full state (report, file states, accuracy breakdowns, review history) is serialized to a JSON checkpoint in the OS temp dir; on server boot, completed checkpoints are rehydrated into memory (in-flight ones are skipped since their worker promises can't be restored).

---

## Technology Stack

| Layer          | Technology                 |
| -------------- | -------------------------- |
| COBOL          | GnuCOBOL (`cobc`)          |
| Converter      | OpenSourceCobol4j (`cobj`) |
| Backend        | Node.js                    |
| Frontend       | HTML, CSS, JavaScript      |
| AI Integration | Azure AI Foundry Agents    |
| Target Runtime | Java 8+                    |

---

## Prerequisites

Make sure the following are installed:

```bash
# Node.js and npm
node -v
npm -v

# Java JDK 8 or higher
java -version

# GnuCOBOL
cobc -V

# OpenSourceCobol4j (cobj compiler)
cobj -v
```

---

## Installation

### 1. Clone & enter the repo

```bash
git clone <this-repo-url> cobol-to-java-converter
cd cobol-to-java-converter/opensourcecobol4j/tools/web-ui
```

### 2. Configure environment

```bash
cp .env.example .env
# edit .env and fill in your Azure OpenAI credentials
```

### 3. Install dependencies

```bash
npm install
```

### 4. Run the application

```bash
npm start
```

Access the UI in your browser:

```
http://localhost:3000
```

---

## Conversion Modes

### 1️⃣ Standard Conversion (Local)

* Uses the local `cobj` compiler.

* **Workflow:**

  ```bash
  # Scan repository for COBOL files
  ./cobol_repo_scanner.sh /path/to/cobol/repo

  # Convert COBOL to Java
  cobj MyProgram.cbl

  # Compile Java
  javac MyProgram.java

  # Execute COBOL
  cobc -x MyProgram.cbl

  # Execute Java
  java MyProgram

  # Compare outputs
  ./compare_outputs.sh
  ```

* ✅ Fast, offline, deterministic

---

### 2️⃣ AI-Powered Conversion (Azure Agent)

* Uses **Azure AI Foundry Agents** for modern, production-ready Java.

* **Workflow:**

  ```bash
  # Clone repository
  git clone https://github.com/your/repo.git

  # Send COBOL files to Azure AI Agent
  node azureAgent.js /path/to/repo

  # Generated Java code with:
  # - Modern patterns
  # - Auto-fixed compilation issues
  # - Maven dependencies

  # Run validation
  ./compare_outputs.sh
  ```

---

## Contributor setup

After cloning, enable the repo's pre-commit hook (blocks `.env`, `*.log`,
`node_modules/`, `graphify-out/`, and files ≥ 5 MB from being committed
accidentally):

```bash
git config core.hooksPath .githooks
```

This writes only to `.git/config` in your clone — it's a per-repo setting
that other contributors configure separately. To bypass the guard on a
specific commit, use `git commit --no-verify`.

---

## Azure AI Agent Setup

### Step 1: Create Azure OpenAI Resource

* Portal → Create Azure OpenAI resource

### Step 2: Deploy Model

* Azure AI Studio → Deploy model (e.g., `gpt-4o`, `gpt-35-turbo`)
* Save deployment name

### Step 3: Create Agent

* AI Foundry → Build → Agents → Create new agent

#### Agent Instructions

* Expert COBOL → Java modernization
* Data mapping:

| COBOL Type          | Java Type  |
| ------------------- | ---------- |
| PIC X/A             | String     |
| PIC 9(1-9)          | int        |
| PIC 9(10+)          | long       |
| COMP / COMP-3 / 9V9 | BigDecimal |

* Structure mapping:

| COBOL           | Java              |
| --------------- | ----------------- |
| WORKING-STORAGE | Class fields      |
| LINKAGE         | Method parameters |
| OCCURS          | Arrays / Lists    |
| PERFORM         | Methods / Loops   |
| IF / EVALUATE   | if / switch       |

* Conversion Rules:

  * Convert all COBOL programs
  * Convert copybooks to Java models
  * One Java class per COBOL program
  * Preserve business logic
  * Java 8+ compatible
  * Generate Maven `pom.xml` with resolved imports

### Step 4: Configure Environment

Copy `.env.example` to `.env` in `opensourcecobol4j/tools/web-ui/` and fill in:

```env
AZURE_OPENAI_ENDPOINT=https://your-resource.openai.azure.com
AZURE_OPENAI_API_KEY=your-api-key
AZURE_OPENAI_API_VERSION=2024-05-01-preview
AZURE_OPENAI_DEPLOYMENT_NAME=your-deployment-name
```

> `AZURE_AGENT_ID` is no longer used — the Assistants/Agent API path was
> removed. Chat Completions works for both Azure OpenAI and AI Foundry and
> is the only code path now. If your `.env` still has `AZURE_AGENT_ID=...`,
> it's safely ignored.

---

## Project Structure

```text
cobol-to-java-converter/
├── README.md
├── LICENSE                          # GPL v3 (inherits from vendored upstream)
├── todo.md                          # Priority-ordered open work + decisions log
├── session-notes.md                 # Living cross-session scratchpad
├── run.sh                           # build / serve / stop / status / logs
├── .gitignore
├── .githooks/pre-commit             # Blocks .env, *.log, large files
└── opensourcecobol4j/               # Vendored OpenSourceCobol4j base framework
    ├── libcobj/                     # Java runtime library (upstream, LGPL)
    ├── carddemo-app/                # AWS CardDemo COBOL fixture
    ├── COPYING / COPYING.LIB        # GPL / LGPL license texts
    ├── VENDORED.md                  # Upstream commit + vendoring notes
    └── tools/
        ├── cobol_repo_scanner.sh
        └── web-ui/                  # Node.js + Express web UI
            ├── server.js            # Boot + 2 big inline routes (convert-azure + run)
            ├── azureAgent.js        # ~50-line facade re-exporting src/
            ├── aiAgent.js           # OpenAI-direct fallback (narrow, fallback only)
            ├── package.json         # engines >=18
            ├── .env.example
            ├── docs/                # Project guides, setup, reports (md)
            ├── tests/               # node --test suites (unit + live)
            ├── public/              # Static frontend
            │   ├── index.html
            │   ├── app.js           # SPA (progressively modularized)
            │   ├── graph.js         # Cytoscape dependency graph
            │   ├── style.css
            │   └── js/              # Extracted modules: helpers,
            │                        #   dialogs, accuracy-panel, review-chat
            └── src/                 # Server-side module tree
                ├── ai/              # Prompts + transport
                │   ├── azure-client.js        # HTTP + retries + DEBUG_PROMPTS
                │   ├── convert-cobol.js       # Primary conversion prompt
                │   ├── fix-java.js            # Repair prompt
                │   ├── analyze-failure.js     # /api/ai/analyze
                │   └── compare-runs.js        # /api/compare-runs verdict
                ├── core/            # Deterministic pipeline helpers
                │   ├── auto-fix-java.js       # Regex patches (A/B-tested net +ve)
                │   ├── accuracy-scorer.js     # Semantic penalty scorer
                │   ├── conversion-graph.js    # CALL/COPY/SELECT/CICS/SQL/IMS
                │   ├── compile-gate-local.js  # cobj-path javac gate
                │   ├── normalize-class.js     # Java class-name fixup
                │   ├── parse-scanner-output.js
                │   ├── manual-review.js       # MANUAL_REVIEW.md builder
                │   ├── source-integrity.js    # Truncated-source detector
                │   └── run/                   # /api/run helpers
                │       ├── cobol-preprocess.js
                │       ├── data-file-staging.js
                │       └── list-output-files.js
                ├── routes/          # HTTP surface (one module per endpoint family)
                │   ├── scan-repo.js   convert-local.js   status.js
                │   ├── graph.js       jcl.js             download.js
                │   ├── review.js      post-review.js     compare.js
                │   ├── ai-analyze.js  fix-java.js        unfix-java.js
                │   ├── misc.js        cancel.js          health.js
                │   └── stats.js
                ├── scan/            # cobol-scanner, jcl-parser
                ├── persistence/     # checkpoint (disk), active-conversions-ttl
                └── util/            # pascal-case, edit-distance, glob-regex,
                                     #   strip-ansi, logger, rate-limit,
                                     #   validate-repo-url, analysis-context,
                                     #   pascal-case
```

**Onboarding map:** read `server.js` (boot + the two inline routes) → read
`src/routes/*` for HTTP surface → read `src/core/*` and `src/ai/*` for the
conversion pipeline. Each module is 30–250 lines with an explicit contract
at the top.

---

## Quick Reminder

* Base engine: **OpenSourceCobol4j**
* Enhancements: **Web UI + automation + Azure AI conversion**
* Supports **two conversion paths**: Local & AI
* **Output validation** included

---

