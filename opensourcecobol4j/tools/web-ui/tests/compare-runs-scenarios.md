# compareRunOutputs — edge-case scenarios

Source of truth for the semantic behaviors the AI comparator (`src/ai/compare-runs.js`) is expected to handle. **This file is documentation, not executable tests.** Add new rows as real failure cases come in from user reports; graduate to a fidelity test only if we can prove the pipeline isn't passing the right data to the model.

Why this file instead of scattered `assert.match(PROMPT, /.../)` tests:

- Prompt-string regexes lock wording, not behavior. Every legitimate prompt tweak (rephrasing, consolidating sections, tightening clarity) broke the test without changing what the AI actually did.
- The semantic verdict (`match` / `partial` / `diverge`) is the AI's job. Our job is plumbing — making sure the data it needs reaches the model.
- A single catalog beats N ad-hoc regex tests: one place to scan the full contract, one place to add new cases, no duplication risk.

The one executable test we keep is the **plumbing test** — `tests/fidelity.test.js` → `compareRunOutputs: empty-stdout-with-output-file plumbs file content through to the AI` — which stubs the transport and asserts the caller-provided data reaches the model. That test is behavior-free (doesn't assert the verdict) so prompt tweaks don't break it.

---

## Scenario catalog

Format per row:
- **Trigger** — the input shape that should fire this rule
- **Expected verdict** — what the AI should return
- **Why** — one line reminding us why we cared enough to write this down

### Source / toolchain failures are not divergence

| Trigger | Expected verdict | Why |
| --- | --- | --- |
| COBOL compile failed (`is not defined`, `unexpected`, `syntax error`) | `partial` / `warning` / title "COBOL source will not compile" | Source bug, not a behavioral difference between the two programs. |
| Java failed to compile while COBOL ran | `partial` / `warning` | Symmetric case — generated Java has the bug, the pair isn't comparable. |
| COBOL output says "requires DB2/CICS/IMS preprocessor" + Java exits 0 on missing input | `partial` / `info` / title "COBOL unrunnable locally" | Local environment can't preprocess DB2/CICS. Java behavior is acceptable if it fails-fast on missing input. |

### Fabricated-input-fallback (the #1 fidelity rule)

| Trigger | Expected verdict | Why |
| --- | --- | --- |
| COBOL hit `libcob: status 35` (file missing); Java printed "using sample data for demonstration" or similar fake rows | `diverge` / `error` | Java must fail-fast on missing input, not substitute data. Reviewer must see this. |
| COBOL hit status 35; Java hit `FileNotFoundException` and exited non-zero | `match` (or `partial` if formatting differs) | MATCHED failure mode — both correctly refused to run. Hint: stage the data file and re-run. |

### Matched non-success outcomes

| Trigger | Expected verdict | Why |
| --- | --- | --- |
| Both programs truncated by a timeout on the same input-waiting loop | `match` / `partial` | Both programs stuck in the same way — not a bug. |
| Both programs produced different padded whitespace but the numeric/record outcome is identical | `match` | Formatting delta ≠ behavioral delta. |
| One side has extra debug prints but the business result matches | `match` | Debug noise isn't divergence. |

### WRITE-to-file programs (the CBL0009 case)

| Trigger | Expected verdict | Why |
| --- | --- | --- |
| COBOL stdout is `(empty)` / `[no output]`, COBOL exits 0, and `cobolOutputFiles` contains a non-empty file (PRTLINE, REPORT, REPOUT, etc.) | `match` if file content ≈ Java stdout; `diverge` if materially different | Mainframe programs commonly only `WRITE` to files, never `DISPLAY`. File content is the canonical output. |
| COBOL wrote PRTLINE; Java also wrote an output file (recognizable by `javaOutputFiles`) | `match` if file-to-file content is equivalent | Prefer file-to-file comparison when both sides have one. |

### True divergence

| Trigger | Expected verdict | Why |
| --- | --- | --- |
| Different numeric result in the business logic (totals don't match, record count differs) | `diverge` / `error` | Real business-logic bug. |
| One side simulates (mock / sample / stub) while the other runs the real logic | `diverge` / `error` | Hidden fabrication. |
| Java invented behavior not present in COBOL (HTTP calls, JSON, auth, network) | `diverge` / `error` | Model hallucinated scope. |
| One side loads an external module the other doesn't | `diverge` / `warning` | Dependency drift. |

### Contract — UI depends on this response shape

```ts
{
  verdict:  "match" | "partial" | "diverge" | "unknown",
  severity: "ok" | "info" | "warning" | "error",
  title:    string,      // 5-10 words, shown in the banner
  reasons:  string[]     // ≤ 5, each ≤ 300 chars, actionable
}
```

Anchor: `fileName` is passed in every call so the model can't collapse judgments across files in the same session. If a future scenario depends on the anchor working, lock it in the plumbing test — not here.

---

## When to add a row

A failure shape deserves a row if **all three** are true:

1. A user reported that the comparator's verdict was wrong for a specific input shape.
2. The AI *could* make the right call given the right data — this isn't a model-capability problem.
3. We either (a) already pass the needed data to the model and just need to document the expected verdict, or (b) discovered the pipeline *isn't* passing the data, in which case we also add a plumbing test.

A failure shape does **not** deserve a row if the prompt just needs rephrasing — that's a model-engineering task, not a contract.
