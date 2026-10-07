---
name: authoring-skills
description: >-
  Authors new agent skills or audits and repairs existing ones — SKILL.md files, skill suites, and agent instruction files. Use when the user wants to create, write, improve, split, merge, lint, or fix a skill; when a skill never triggers, triggers on the wrong tasks, or is ignored mid-run; or when a repeated workflow should be codified ("write a skill for…", "turn this into a skill", "my skill never fires", "codify what we just did"), even if they don't say the word "skill". Covers the full loop of baseline-failure capture, trigger/description engineering, progressive disclosure, eval-driven testing, validation, packaging, and lifecycle. Do NOT use for editing a skill's domain content (fix its scripts or domain knowledge directly) or for documents no agent will consume.
metadata:
  author: gstack-pi
  version: "0.1.0"
---

# Authoring skills

A skill is **behavior-shaping code, not documentation**. The agent runs the same process every invocation, so the file's job is to make that process predictable. Every line either changes what the agent does or gets deleted.

Two laws govern everything below; the rest is mechanics.

1. **The description is the entire router.** Only `name` + `description` stay in context permanently; the agent matches user intent against them and reads the body only after deciding to fire. A perfect body behind a weak description is a skill that never runs.
2. **No skill without a witnessed failure.** Until you watch the agent do the task without the skill, you cannot know what the skill must change. Baseline first — including for edits.

Companion reference: if a `writing-for-agents`-style skill is installed, invoke it alongside this one — it carries the theory (context pointers, context vs cognitive load, the information hierarchy) that this workflow applies.

## The pipeline

Authoring is a gated pipeline. Each phase ends on a completion criterion; do not advance on vibes.

| Phase | Produces | Gate — done when |
|---|---|---|
| 0. Gate | build/no-build verdict | evidence recorded: the baseline output, or the deterministic alternative chosen instead |
| 1. Baseline | failure transcript + verbatim rationalizations | ≥1 realistic task run *without* the skill; every failure named |
| 2. Shape | genre + invocation + scope decision | one verb-cluster; explicit boundaries vs sibling skills |
| 3. Router | name + description | passes every check in `references/rulebook.md` §A |
| 4. Body | SKILL.md draft | every step ends on a checkable, exhaustive completion criterion |
| 5. Bundle | scripts/references/assets | every file declared run-vs-read; every pointer says *when* to follow it |
| 6. Prove | green eval runs | with-skill passes the cases baseline failed; trigger evals at threshold; loopholes closed |
| 7. Ship | validated package | every box in `references/pre-flight.md` checked |
| 8. Maintain | versioned, pruned skill | versioning, staleness, and telemetry hooks in place |

Phases 0–2 are where skills are won or lost. Phases 3–8 are where they are finished.

## Phase 0 — Should this exist?

Kill the skill early unless it earns its slot:

- **Recurrence**: done ≥5 times, will be done ≥10 more? One-off → don't build.
- **Delta**: would the agent get this *wrong* without it? If the baseline already succeeds, the skill is a no-op — stop. (Self-generated skills show ~no measured benefit; human procedural knowledge in, agent polish out.)
- **Determinism**: could the rule be a hook, linter, test, or script instead? Instructions are for judgment; mechanisms are for guarantees. If it can be mechanized, mechanize it — the skill then only points at the mechanism.
- **Kind**: retrievable knowledge → an AGENTS.md/docs pointer beats a skill (a passive index measured ~100% vs ~79% for skill retrieval on knowledge-lookup tasks); a repeatable procedure, discipline, or judgment → skill.
- **Uniqueness**: does a sibling already claim this territory? Overlapping descriptions are the #1 measured cause of routing failure. Extend or sharpen boundaries — never fork.
- **Library pressure**: every always-loaded description spends shared routing budget (~1–2% of the context window; least-used skills get evicted first; practical ceiling ~30 skills). A skill that costs the library a slot must pay for it.

## Phase 1 — Baseline: watch it fail

Run ≥1 realistic task *without* the skill, in a fresh context:

- Record exactly what goes wrong, plus the agent's **verbatim rationalizations** — the rationalization table you'll write in Phase 4 is built from these quotes, never invented.
- Always run a no-guidance control: if the control doesn't fail, there is nothing to author. Stop.
- For discipline skills, capture pressure conditions (time pressure, sunk cost, "it's almost done"): disciplines fail under pressure, not in calm.

Completion: a named failure list — each failure tagged by type (see the form-to-failure table in Phase 4), with the observed transcript as evidence.

## Phase 2 — Shape

**Genre.** Pick the skeleton before writing — the production corpus shows four:

| Genre | For | Skeleton |
|---|---|---|
| Mode/persona | persistent judgment (minimalism, taste) | persona + ordered decision procedure + rules + persistence + explicit off-switch |
| Process/workflow | multi-step jobs | numbered gated phases + artifacts + completion criteria + escalation path |
| Router/index | capability hubs | entry table dispatching to bundled files/skills; read only the matched row |
| Flat reference | rule sets consulted on demand | co-located rules, one heading each + an exhaustiveness bar |

**Scope.** One skill = one verb-cluster = one non-overlapping job. If an honest description needs >~250 chars of "when" clauses, it's two skills wearing one coat — split it.

**Invocation mode.**

| Mode | Choose when | Cost |
|---|---|---|
| model-invoked (default) | the agent must reach it on its own, or another skill must call it | description always resident: permanent context load |
| user-invoked (`disable-model-invocation`) | only ever fired by hand, or orchestrates other skills | zero context load; the human is the index |

Model-invocation includes user reach — the flag only removes *agent* reach. Pick it only when agent- or skill-discovery is required.

**Structure.** Decide now what lives where — the three loading levels:

| Level | Loaded | Budget | Contents |
|---|---|---|---|
| metadata (`name` + `description`) | always | ~100 tokens | trigger surface only |
| SKILL.md body | on fire | <500 lines / <5k tokens | spine: workflow + critical rules + pointers |
| bundled files | on demand | ~0 until read | `references/`, `scripts/`, `assets/` |

## Phase 3 — Router: name + description

**Name**: kebab-case, ≤64 chars, must equal the directory name, gerund preferred (`writing-plans`, `systematic-debugging`); verb-led; never `helper`, `utils`, `tools`. Namespace by tool if the skill wraps one (`gh-address-comments`).

**Description** — write it last in the draft, first in importance. Formula:

`[capabilities — what it does] + "Use when…" [trigger branches] + [concrete trigger phrases, file types, symptoms, verbatim user utterances] + ["Do NOT use for…" boundary clauses]`

- Third person always — the text is injected into a system prompt; "I can help you…" breaks discovery.
- Every "when" lives here, never in the body. Enumerate the branches users actually say — including lazy phrasings ("fix it", "check this"), error messages, file extensions, and synonyms.
- Pushy on purpose: agents *under*-trigger skills by default, so bias toward firing ("even if they don't explicitly ask for it") — then claw back precision with explicit "Do NOT use for…" exclusions naming sibling territory.
- Tight: ≤1024 chars is the spec cap, but ~1,536-char listing truncation and the shared listing budget punish length. Front-load the primary trigger — the tail is evicted first.
- Never summarize the workflow in the description. Agents shortcut: they execute the description and skip the body. Describe *when*, not *how*.
- One trigger per distinct branch — a synonym written twice is one branch paying twice.
- Description edits are the highest-leverage changes in the whole system; expect to iterate here most.

## Phase 4 — Body: the decision procedure

Write the body as a procedure the agent executes, not a document it reads. The full rulebook is `references/rulebook.md`; the load-bearing rules:

- **Bookend critical rules**: state them at the top, restate the top few verbatim at the bottom. Mid-file is the weakest-attended region.
- **Rule budget**: ~10 constraints per file is the practical ceiling before compliance measurably degrades. More rules → split the skill, don't lengthen it.
- **Positive imperatives**: "Do X" beats "Don't Y" — naming the forbidden thing primes it. A prohibition earns its place only as a hard guardrail paired with its positive target. Exception: *binary enumerated bans* ("zero em-dashes") beat soft limits ("use sparingly") for known model tics.
- **Match the form to the failure** — Phase 1's tags drive this:

| Observed failure | Instruction form |
|---|---|
| discipline skipped under pressure | prohibition + rationalization table + red-flags list |
| wrong output shape | positive recipe/contract — state what the output IS |
| omitted element | REQUIRED slot in the output template |
| conditional behavior | condition on an *observable* predicate |
| repeated rationalization | excuse→reality table, verbatim from baseline |

  No nuance clauses ("unless it matters" reopens the negotiation). No exemption clauses (they suppress anyway).
- **Steps end on completion criteria** — checkable *and* exhaustive ("every modified model accounted for", not "produce a change list"). Vague bounds cause premature completion; sharpen the bound before hiding later steps.
- **Each step names an action, a tool, and an output**; edge cases become `if X → do Y` branches, not paragraphs.
- **Leading words**: compress repeated concepts into single pretrained tokens (*tight*, *red*, *ledger*) and reuse the same token in body and description. Coined jargon buys nothing.
- **Examples are format contracts**: 1–2 canonical ❌/✅ pairs beat an enumerated edge-case list.
- **Explain the why** for heuristics — reasoned instructions beat stacked MUSTs; reserve hard emphasis for genuine gates.
- **Verification is a step, not a hope**: every skill carries its own pass/fail check (a command, checklist, or criterion), explicit termination conditions, and a loop bound ("after N failed fixes → escalate").
- **Cut no-ops**: for each line ask "would the model do this anyway?" If yes, delete the whole line. Cache only what the environment can't confess — the unwritten convention, the reason behind a choice, the gotcha.
- **Name the failure modes**: "sediment", "skill shadowing", "a bug farm with a hit rate" — named modes get detected.

## Phase 5 — Bundle

- **`scripts/`** — deterministic or fragile work. Executed, not read: only output costs context. Requirements: no interactive prompts, `--help`, structured stdout (diagnostics → stderr), bounded output, meaningful exit codes, idempotent, `--dry-run` for write ops, errors that say what went wrong *and* what to try. Invoke through the interpreter (`bash scripts/x.sh`) — packagers strip executable bits.
- **`references/`** — prose loaded on demand. One level deep from SKILL.md (nested refs get truncated reads); >100–300 lines → TOC at top; split by domain so each branch loads only what it needs.
- **`assets/`** — files used in the output (templates, images, data).
- Declare **run-vs-read** for every file: "Run `x.py`" vs "See `x.py` for the algorithm".
- Every bundled file gets a **when-pointer** in the body: "Read `references/api-errors.md` if the API returns non-200". A bare directory listing is not a pointer.
- Match **degrees of freedom to fragility**: open-field tasks get heuristics; narrow-bridge tasks get exact scripts. Poka-yoke interfaces so misuse is structurally hard.
- Bundle what agents reinvent: if every baseline run wrote the same helper, ship it.

## Phase 6 — Prove it

**Trigger evals**: ~20 realistic prompts — 8–10 should-fire, 8–10 should-NOT (near-misses, not strawmen) — with typos, lowercase, file paths, casual phrasing. 3 runs each. 60/40 train/validation split; fix only from train; never keyword-stuff failed queries (overfitting); pick the winner on validation. Pass: >50% trigger rate per case; target ~90%.

**Task evals**: 2–3 realistic cases; run with-skill AND baseline in the same turn; draft assertions *after* seeing outputs; prefer mechanical checks; record tokens/time — a skill that passes but doubles cost needs pruning.

**Pressure tests** (discipline skills): fresh single-shot contexts, realistic system-prompt load, 5+ reps — variance is a metric. Close each observed loophole explicitly, then retest.

**Cross-model**: smaller models need more guidance; test on every model you'll ship to.

Then ask the failing agent: *"how should this skill have been written?"* — meta-testing surfaces wording fixes you can't see.

## Phase 7 — Ship

Run `references/pre-flight.md` end to end — every box, mechanically. Then:

- **Spec check**: six portable fields only (`name`, `description`, `license`, `compatibility`, `metadata`, `allowed-tools`); harness-specific fields (rulebook §F) only when targeting that harness.
- No README/CHANGELOG inside the skill directory — the skill holds only what an agent consumes.
- **Security pass**: no secrets, no unvetted piped scripts, no instruction-shaped payloads in references you didn't write — frontmatter and body are system-prompt surface.
- **Package for distribution**: canonical `skills/[<category>/]<name>/SKILL.md` layout (depth ≤3); `.claude-plugin/` manifest for marketplaces; `npx skills`-compatible.

## Phase 8 — Maintain

- **Version like software**: semver + changelog. Re-run pre-flight on every edit — agent-authored text carries measurably higher defect rates.
- **Prune for sediment**: lines go stale as behavior changes; the no-op test never expires. Skills are code — change them on eval evidence, not style.
- **Watch triggering in the field**: under-triggering → sharpen the description; over-triggering → add NOT-clauses. New skills start with zero usage history and are evicted first under listing pressure — invoke once manually to seed.
- **Write-back loop**: when the agent learns something the hard way in this skill's domain, update the skill — capture successful approaches and common mistakes.
- **Library audit**: periodically diff descriptions pairwise across the installed set; shadowing, not size, is what kills routing.

## Boundaries

- This skill authors the *container*, not the domain content: procedures, domain knowledge, and script logic come from the user, the codebase, and baseline runs — never invented wholesale (self-generated skills measure ≈no benefit).
- Deterministic enforcement outranks instructions: if the right answer is a hook, CI check, or script, this skill's job is to say so — and stop.
- Evidence tags throughout: **[SPEC]** spec-enforced · **[OFFICIAL]** vendor guidance · **[MEASURED]** tested · **[CONTESTED]** disputed. Mechanisms rot across harness versions — verify version-specific constants before relying on them.

## References

| Need | File |
|---|---|
| The full categorized rulebook — every technique, tagged by evidence | `references/rulebook.md` |
| The mechanical pre-flight checklist — run on every draft, every edit | `references/pre-flight.md` |
| Starter skeleton per genre | `assets/skill-template.md` |

---

The two laws, again: **the description is the entire router** — a perfect body behind a weak description never runs. **No skill without a witnessed failure** — baseline first, including for edits.
