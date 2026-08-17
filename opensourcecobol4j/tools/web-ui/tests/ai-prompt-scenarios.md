# AI prompt — edge-case scenarios

Source of truth for the semantic behaviors our three AI prompts must handle. **Documentation, not executable tests.** Prompts live in:

- `src/ai/convert-cobol.js` — primary COBOL → Java conversion
- `src/ai/fix-java.js` — post-compile repair pass
- `src/ai/compare-runs.js` — runtime output comparator

The scenarios catalog for `compare-runs.js` is separate at `tests/compare-runs-scenarios.md` (mostly for its own reference — kept apart so one prompt's rules don't drift into another by copy-paste).

Why this file instead of scattered `assert.match(PROMPT, /literal string/)` tests:

- Prompt-string regexes lock wording, not behavior. Legitimate prompt tweaks broke the test without changing what the AI did.
- The semantic decision (what to generate) is the AI's job. Our job is plumbing — make sure the data it needs reaches the prompt.
- One catalog beats N ad-hoc asserts: easy to scan the whole contract, one place to add new cases.

Executable tests that remain (in `fidelity.test.js`):

1. **Plumbing / behavior tests** — stub the transport, verify caller-provided data reaches the model. Prompt wording doesn't matter.
2. **Code contracts** — `context.copybookBodies` / `context.siblingSignatures` / `context.reviewerFeedback` are read by the right code; SKIPPED_TOO_LARGE / SKIPPED_BUDGET surface in the UI; `idOf` / `graphEdges` are defined at the wave-loop site (regression guard). These check CODE, not prompt text.
3. **Pure-function unit tests** — `preflightCheck`, `buildContext`, `extractReviewerFeedback`, `extractEntrySignature`, `buildReportEntry`, `runCompileAndRepair`, `preprocessCobolSource` (typo / END-IF / header-period passes).

---

## Primary conversion prompt (`src/ai/convert-cobol.js`)

### Fidelity: no silent fallbacks in generated Java

| Trigger | Expected AI behavior |
| --- | --- |
| COBOL opens a file via SELECT-ASSIGN | Generated Java must read from that file; on missing file, print error + System.exit(1) (matches libcob status 35). |
| Java would otherwise substitute sample data when input is missing | Must not — "Input file not found, using sample data for demonstration…" is banned. |
| COBOL uses ACCEPT FROM SYSIN with expected input types | Generated Java's Scanner reads MUST NOT throw NumberFormatException on non-numeric input, MUST null-check `nextLine()` (EOF returns null, not throw), MUST default to 0 on parse failure. |

### Fidelity: do not silently repair defective COBOL

| Trigger | Expected AI behavior |
| --- | --- |
| COBOL a compiler would reject — e.g. `77 GROSS-PAY PIC X(5).` used as a `COMPUTE` target (PAYROL0X in the Open Mainframe Project course) | Convert it literally, still emitting compilable Java, and mark the line `// TODO[SOURCE-DEFECT]: <what is wrong>`. |
| AI can infer the "intended" type of a defective field | Must NOT quietly substitute it. A silent repair yields Java that runs when the original cannot even build, which hides the defect and makes the COBOL-vs-Java comparison meaningless. |
| Reference to an identifier never defined; MOVE between incompatible types | Same rule — convert literally + `TODO[SOURCE-DEFECT]` marker. |

Behavior lock: `analyzeConversionAccuracy` penalizes the marker with the
`Source defect flagged` badge (§24 in `fidelity.test.js`), and
`PENALTY_GUIDANCE` explains it to the reviewer. The Java must stay
compilable — the compile-gate still applies, so the marker is a flag for a
human, not a licence to emit broken Java.

### Context surfaces that the prompt relies on

| Context key | Where it appears in the prompt | Rationale |
| --- | --- | --- |
| `copybookBodies` | `=== COPYBOOK X ===` section for each entry | Without inlined bodies, AI guesses field names → wrong Java data classes. |
| `siblingSignatures` | `entry signature: public void run(…)` under CALL targets | Without it, caller guesses the callee's param list. |
| `jclInvocations` | `JCL invocations` section with DD-name → file-path mapping | Without it, AI invents file paths instead of using real DD names. |
| `reviewerFeedback` | `REVIEWER FEEDBACK FROM EARLIER IN THIS BATCH` with up to 5 notes framed as hard constraints | Without it, the same flagged mistake repeats across the batch. |
| `programIdToJavaClass` | Under CALL targets as "→ Java class Foo exists in this conversion" | AI emits real `new Foo().run(...)` instead of TODO stubs. |
| `partialSkeleton` (divisional split) | Synthetic copybook entry with Part A's Java | Part B prompt sees the class skeleton + field defs from Part A. |

### Code-correctness rules the prompt reinforces (complements `autoFixJavaCode` patches)

| Pattern | Why banned | Post-processor fallback |
| --- | --- | --- |
| `final` on a field reassigned anywhere | COBOL WORKING-STORAGE is mutable — `final` makes the generated Java uncompilable. | Fix 2f / 9-10 |
| `final` on method parameters | Legal but over-constraining; blocks in-place updates the converter often needs. | Fix 26 |
| `abstract` on a class with no abstract methods | Prevents callers from instantiating it. | Fix 24 |
| `throws IOException` on pure-string helper methods | Only I/O-calling methods need it. | Fix 2d |
| Missing `public static void main(String[] args)` when COBOL has a PROCEDURE DIVISION | The class is unusable without an entry point. | Fix 6 |
| Primitive field declared without an initializer | NPE at runtime when used before assignment. | Fix 8 |
| Illegal `throws` on control-flow statements (`for (...) throws`, `if (...) throws`, etc.) | Compile error. | Fix 2c (locked test #14) |

### Presentation rules

| COBOL input | Expected Java output |
| --- | --- |
| `PIC 9(N) ... VALUE <n>` DISPLAYed | `String.format("%0Nd", value)` — zero-padded to N digits. `System.out.println(n)` printing bare int is wrong. |

---

## Repair prompt (`src/ai/fix-java.js`)

Fired by the compile-gate + accuracy-scorer when initial Java fails `javac` OR gets the "Fabricated input fallback" penalty. One repair call per file.

### Must preserve the primary-prompt fidelity rules

- No fabricated input — strip sample-data fallbacks if present.
- No ACCEPT-throwing — wrap `Integer.parseInt` in try/catch-default-zero, null-check `Scanner.nextLine()`.
- Preserve PIC 9(N) zero-padding via `String.format("%0Nd", value)`.
- Mirror every code-correctness rule from the primary prompt (final-on-mutable, final-on-params, abstract-on-concrete, throws-on-pure-string, require-main, init-primitives).

### Repair-specific inputs

| Input available | Why the repair needs it |
| --- | --- |
| `compileErrors` (javac stderr) | Direct targeting — "cannot find symbol: class Foo" tells the model exactly what to fix. |
| `runOutput` (prior Java stderr/stdout) | Runtime errors (NPE, NumberFormatException, class-not-found) that `javac` passed but exec caught. |
| `cobolOutput` (prior `/api/run` capture, optional) | Target behavior to match — "match THIS output, don't just make it compile". |
| `dependencies` (PROGRAM-ID → Java class map) | Lets the repair call real sibling classes instead of re-stubbing. |

---

## Comparator prompt

See `tests/compare-runs-scenarios.md`.

---

## When to add a row here

A scenario deserves a row if **all three** are true:

1. A real user-report shows the AI getting this case wrong.
2. The AI *could* make the right call given the right data — not a capability gap.
3. Either (a) the prompt already tells the model the rule and we're documenting it, or (b) we're about to add new context plumbing in which case we also add a plumbing test.

A scenario does NOT deserve a row if the fix is pure prompt rephrasing — that's prompt-engineering, not a contract. Edit the prompt, eyeball a few output files, move on.
