# Design Notes — Static bug-discovery skill (final name TBD at project end)

> Working folder: `cline-skill/`. The skill's final name is decided at project end;
> the `SKILL.md` draft uses `pipeline-desk-check` as a provisional name.

## 1. Goal and positioning

Discover bugs and inconsistencies **invisible to compilation** by testing the software *theoretically*:
the agent role-plays through the software pipeline (UI → input → transformation → output),
with cause-effect chains anchored to reading the real code, without running the app.

- **When it activates**: the code compiles, no known bugs, before runtime tests.
- **Output**: falsifiable triggers ready to become tests + questions for the user about
  unspecified behaviors + verified DoD matrix.
- **Explicit positioning** (to avoid overlap): it's *pre-emptive static discovery*.
  - vs `diagnosing-bugs` (Pocock) / `systematic-debugging` (local): those start from an
    observed symptom and require a feedback loop; this one generates the candidates AND the
    feedback loops, without a symptom.
  - vs `bug-hunt-swarm`: that one is diagnosis-first (bug already known); this one hunts latent defects.
  - vs `code-audit-reviewer` (local): that one reviews along 5 dimensions; this one walks the usage flow.
- **Placement in the sprint flow** (producer/consumer to record in README.md):
  after `code-audit-reviewer`, before `qa-git`.

## 2. Six-phase workflow

### Phase 0 — DoD briefing (non-blocking)
- With the user, define the pipeline DoDs: expected inputs, transformations, outputs, error handling.
- Pick **2–3 scenarios**: happy path + one edge case + one "hostile" input. Each scenario gets its own trace table.
- Format: investigation brief (from bug-hunt-swarm) — what must happen / what is not yet proven /
  what would count as confirmation.
- If the user is unavailable: proceed with assumptions marked `~` (non-blocking, Pocock pattern).

### Phase 1 — Breadboard UI
- Places / affordances / wiring model (from `breadboarding`, rjs/shaping-skills — Shape Up):
  what is visible, what is blocking, where control passes to the code.

### Phase 2 — Pipeline walk
- **Central rule (from trace-the-code)**: at each step read the real code, never your memory of
  what it "should" do.
- Fixed questions repeated at each step (from cognitive-walkthrough, adapted):
  how does the input get here? / what does the code assume about it? / what happens if the
  assumption is violated? / where does the output end up and who validates it?
- **Tabular output**: for each step → `step | expected input | how the code receives it | output produced | destination`.
- **Per-scenario trace table** (classic desk-checking, from examprep-ai): `Iter | VarA | VarB | ... | Output`,
  evolving step by step.
- **Markers**: `?` = unspecified behavior → question for the user; `~` = unverified
  assumption, keep going.
- **Naive pass ("child" behavior)**: at each step, explain the step as to a 6-year-old;
  every "obviously / naturally / simply" is an implicit assumption → a Premise to verify.

#### Naive pass rules (re-arming and destinations)
- The naive pass **is not a phase, it's a context**: it re-arms at every structural boundary
  (dominant module/file change, paradigm change: UI→backend, sync→async, process→process, app→DB, external I/O),
  **after every accepted finding** (peak-confidence moment = peak bias risk),
  and at the mid-walkthrough checkpoint (safety net).
- Two kinds of "why", two destinations:
  - *Mechanical-why* ("how do you know? where in the code?") → the agent answers ONLY by re-reading the code.
  - *Intent-why* ("why is empty input rejected instead of auto-corrected?") → if the briefing
    doesn't cover it, it goes in the `?` queue for the user. Never answer it yourself.
- **Golden rule**: an answer is not accepted until it cites file+line.

### Phase 3 — Causal chain check
- **Mismatch-axes checklist** (from code-review-and-quality, addyosmani):
  type, unit/measure, order, state, null/empty, encoding.
- **5-field finding format** (from Logic-Lens logic-review):
  `Premises: / Trace: / Divergence: / Trigger: / Remedy:` — mandatory fields, not paraphrasable.
  A finding without a concrete Trigger (specific input → chain → wrong output) is "a vibe": discard or refine it.
- **Design-intent gate** (Logic-Lens): before flagging a problem at a boundary, check whether the code
  explicitly handles the case (throw, 429, reject). If yes, it is NOT a bug.
- **Adversarial rebuttal** (Logic-Lens 5.5 + uglybug): for each finding, 3 refutation questions
  (premise / path / consequence rebuttal). Asymmetric penalty in the Skeptic: rejecting a real bug
  costs 2x vs accepting a false one (anti-sycophancy, SycEval arXiv 2502.08177).
- **Citation-fidelity check** (uglybug's Reproducer role): a separate pass re-reading ONLY
  the findings' code citations. Critical: the agent is testing its own code.
- Multi-wave with dedup and auto-stop (2 consecutive clean waves) if the project is large.

### Phase 4 — Report
- **DoD matrix as single source of truth**: one row per briefing DoD,
  verdict `verified / mismatch / unspecified → question`.
- **Ranked findings** with confidence (high/medium/low) + "smallest proof step" (from bug-hunt-swarm).
- **3-speed triage**: `prove now / fix next / follow up later`.
- **Question queue**: priority questions (on the happy path) first; then **overflow**
  (indicative cap ~3 questions/step to protect the user's attention — overflow goes in the report,
  NEVER into silence; dedup before overflow).
- **Incomplete-briefing sensor**: if more than 2–3 consecutive steps overflow the cap,
  reopen the briefing instead of accumulating questions.
- **Optional Execution Gate** (Logic-Lens step 8): if a runtime is available, generate a minimal
  reproducer for the critical findings and run it; verified ones get the ✅ tag.
- Artifact: `qa/desk-check_XX.md` with a `STATUS ==` block parseable by the planner
  (local `code-audit-reviewer` convention).

### Phase 5 — Handoff
- Mismatches become **tasks** (via the local `kstack-tasks` skill), not forgotten report rows.
- Every critical finding becomes a **feedback loop / test** for `diagnosing-bugs` or real QA.
  The skill does NOT execute anything itself (except the optional Execution Gate).

## 3. Failure signs (how to spot degeneration)

- The agent describes what it *meant* to write, not what it wrote (from trace-the-code).
- The agent answers "why" questions without opening files → back to the naive pass.
- The `?` questions exceed the cap or are variants of the same one → incomplete briefing, reopen it.
- The agent stops asking "how do you know?" after the first steps → expert bias has returned,
  re-arm the naive pass.

## 4. Execution architecture

Single-agent with separate phases (walkthrough → skeptic → reproducer), with optional sub-agents
for large projects (bug-hunt-swarm pattern: "for a tiny and obvious issue, investigate locally").

## 5. Sources (verified during research)

| Source | Status | Takes |
|---|---|---|
| Logic-Lens / logic-review (hyhmrright, via sickn33) | ✅ verified | 5 fields, rebuttal, design-intent gate, exec gate |
| uglybug / bug-hunt (mathifonseca / danpeg) | ✅ verified | asymmetric Skeptic, Reproducer, multi-wave |
| cognitive-walkthrough (mastepanoski) | ✅ verified | novice roleplay, per-step fixed questions |
| grill-me / grilling / to-questionnaire / diagnosing-bugs (mattpocock) | ✅ verified | briefing-interview, non-blocking checkpoint, falsifiability |
| bug-hunt-swarm (dimillian) | ✅ verified | investigation brief, ranking+confidence, triage |
| trace-the-code (alinafe82/cognitive-deadlift) | ✅ verified (1 install) | "real code never memory" rule, failure signs |
| breadboarding (rjs/shaping-skills) | ✅ verified | Places/affordances/wiring, tables as truth |
| examprep-ai (sickn33) | ✅ verified | trace table Iter/Vars/Output |
| double-check (meain/dotfiles) | ⚠️ plausible unconfirmed | per-claim verification (state→file, behavior→trace) |
| code-review-and-quality (addyosmani) | ⚠️ plausible unverified | mismatch axes |
| TRACE (2389-research), Virtual-Lab | ❓ unverified | verification matrix, multi-scenario (accepted on merit) |

## 6. Open decisions

- **Skill name**: ✅ **DECIDED: `kstack-mindrun`** (verified free on skills.sh; rejected competitors:
  `premortem` crowded 1.2k+ installs, `preflight` polluted, `prebug` free but less faithful to the method).
  Folder renamed `cline-skill/` → `mindrun/`, frontmatter `name: mindrun`, artifacts renamed
  `mindrun-briefing.md` / `mindrun-report.md`, `[mindrun]` task prefix, tagline in the description.
- Record producer/consumer in `README.md` when the skill is finalized.
- License: field omitted for now (add if distributed).

## 7. Current state (post-drafting)

Skill written and **validated** (`skills-ref validate` → "Valid skill"):

```
cline-skill/
├── SKILL.md                      # 138 lines, English, conformant frontmatter
├── design-notes.md               # this file (not distributed)
└── references/
    ├── briefing-template.md      # F0 template
    ├── finding-format.md         # 5 fields + acceptance gate + good/bad examples
    ├── mismatch-axes.md          # 6 axes with questions and examples
    └── report-template.md        # incremental report template + STATUS block
```

Decisions applied vs the v2 plan:
- Artifacts reduced 5 → 2 (`desk-check-briefing.md`, `desk-check-report.md`); breadboard and walk
  are report sections, proposed-tasks is the report's tail section.
- Naive pass reformulated as a **per-step comprehension standard** ("can you reconstruct the
  input→output chain from the code alone?"), not as an inspectorial behavior: no explicit
  re-arming, no slapping down of implicits, mechanical questions only.
- Report written **incrementally** after each step → the partial report is the resume state.
- Language: English everywhere (SKILL.md + references).
- Formal validation passed with the provisional name matching the folder.

## 8. Installs

- **Pi** (earendil-works/pi): `~/.pi/agent/skills/kstack-mindrun/` (user-level, all projects) — ✅ validated
- **Cline**: `~/.cline/skills/kstack-mindrun/` (user-level, IDE/CLI/SDK) — ✅ validated
- Source of truth: `Desktop\.agents-clean\mindrun\` — the installs are copies: after every
  change to the source, re-copy to the destinations (or replace with symlink/junction).

