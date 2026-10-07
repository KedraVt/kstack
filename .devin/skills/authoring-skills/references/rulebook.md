# The skill-authoring rulebook

Every known technique for making agent skills reliable, grouped by surface. Each rule carries an evidence tag:

- **[SPEC]** — enforced by the open Agent Skills spec / shipped validators (hard requirement)
- **[OFFICIAL]** — vendor guidance (Anthropic docs, OpenAI guide, Devin docs, engineering blogs)
- **[MEASURED]** — backed by experiments, benchmarks, or binary-level inspection
- **[CORPUS]** — convention observed across high-star production skills
- **[THEORY]** — principled framing from the writing-for-agents literature
- **[CONTESTED]** — sources disagree; resolution given where one exists

## Contents

- A. Triggering & description (the router)
- B. Structure & progressive disclosure
- C. Instruction writing
- D. Bundled resources
- E. Testing & evals
- F. Portability & packaging
- G. Composition & library health
- H. Lifecycle & maintenance
- I. Documented failure modes → fixes
- J. Contested rules → resolutions

---

## A. Triggering & description — the router

The description is the only text the agent sees before deciding to fire. All routing quality lives or dies here.

**A1. Spec constraints.** `name`: kebab-case `a-z0-9-`, ≤64 chars, no leading/trailing/double hyphens, must equal directory name, no reserved words (`anthropic`, `claude`), no XML. `description`: non-empty, ≤1024 chars, no `<`/`>` characters. [SPEC]

**A2. The formula.** `[capabilities] + "Use when…" [branches] + [trigger phrases, file types, symptoms] + ["Do NOT use for…" exclusions]`. Canonical example: `Extract text and tables from PDF files, fill forms, merge documents. Use when working with PDF files or when the user mentions PDFs, forms, or document extraction.` [OFFICIAL]

**A3. Third person.** The description is injected into the system prompt; "I can help…" / "You can use…" cause discovery problems. [OFFICIAL]

**A4. Every "when" lives in the description, not the body.** All trigger information on the always-loaded surface. [OFFICIAL]

**A5. Enumerate verbatim trigger language.** Quoted user phrases ("be lazy", "/brag"), file extensions (.fig, .xlsx), error messages, symptoms, synonyms, lazy phrasings ("fix it", "check this"). Matching is closer to keyword-ish than purely semantic — surface phrases the model can literally match beat paraphrased intent. [MEASURED]

**A6. Pushy on purpose.** Agents under-trigger skills by default (vendor-acknowledged). Bias toward firing: "Make sure to use this skill whenever the user mentions X, Y, Z, even if they don't explicitly ask." [OFFICIAL — but see J1]

**A7. Negative triggers prevent over-triggering.** "Do NOT use for simple viewing (use X instead)", "not for general financial queries". Also the fix for sibling coin-flips. [OFFICIAL + MEASURED]

**A8. Front-load.** Combined description text is truncated at ~1,536 chars in listings; least-used skills' descriptions are dropped first when the listing budget overflows (~1–2% of context window). The tail is the first thing lost — primary trigger first, keywords early. [MEASURED — version-dependent constants]

**A9. Never summarize the workflow.** A description describing process ("does code review between tasks") caused an agent to execute the summary and skip the body. Describe *when*, never *how*. [MEASURED — superpowers; see J2]

**A10. One trigger per distinct branch.** Synonyms renaming one branch are one branch paying twice. Cut identity the body already carries. [THEORY]

**A11. Disjointness is the load-bearing property.** "Skill shadowing" — a similar description masking the right skill — accounts for up to ~68% of measured routing degradation; at ~200 skills agents abandon skill use ~38% of the time. Write descriptions to be *distinguishable*, not merely accurate; exclude sibling domains explicitly. [MEASURED — arXiv skill-shadowing study]

**A12. Distill the body's discriminative content.** Hiding the body costs 31–44 points of routing accuracy on an 80k-skill benchmark; descriptions that compress what makes *this* skill different recover part of the gap. The description compresses the body, not the topic. [MEASURED — SkillRouter]

**A13. Naming.** Gerund/verb-led preferred (`writing-plans`); never `helper`/`utils`/`tools`; namespace by tool (`gh-address-comments`). The name is part of the trigger surface. [OFFICIAL + CORPUS]

**A14. Simple requests don't fire skills.** Agents only consult skills for tasks beyond easy solo handling; "read this PDF" may not trigger a perfect PDF skill. Don't fight it with more trigger words — it's the router working as intended. [OFFICIAL]

## B. Structure & progressive disclosure

**B1. Three loading levels — the contract.** Metadata (~100 tokens, always) → body (<500 lines / <5k tokens, on fire) → bundled files (~0 cost until read, effectively unbounded). [SPEC + OFFICIAL]

**B2. Body = spine + table of contents.** Workflow, critical rules, and *when-pointers* to everything else — "like a table of contents in an onboarding guide". Not an encyclopedia. [OFFICIAL]

**B3. When-pointers, not listings.** "Read `references/api-errors.md` if the API returns non-200" beats "see references/". The pointer's *wording* decides whether the file is ever reached. [OFFICIAL + THEORY]

**B4. References one level deep.** Nested files get partial (`head -100`) reads → incomplete information. [OFFICIAL]

**B5. TOC in long references.** >100 lines (docs) / >300 lines (skill-creator) → table of contents at top. [OFFICIAL]

**B6. Steps vs reference.** Inline what every branch needs; disclose behind a pointer what only some branches reach. Buried steps turn execution into a coin-flip. [THEORY]

**B7. Bookend critical rules.** State them top, repeat the top few verbatim at the bottom; mid-file is the weakest-attended region (primacy + recency; verbatim repetition measurably helps). [MEASURED — Lost-in-the-Middle, repetition studies]

**B8. Rule-count budget.** Compliance degrades monotonically with instruction count; ~10 constraints/file is the practical ceiling; perfect compliance collapses near ~80 rules. More rules → split the skill. [MEASURED — ManyIFEval, FollowBench, RealGuardrails]

**B9. Genre skeletons.** Mode/persona · process/workflow · router/index · flat reference — four observed genres with distinct structures (see SKILL.md Phase 2 + assets template). [CORPUS]

**B10. Splitting.** By branch (load only what the branch needs), by sequence (hide post-completion steps behind a real context boundary — a handoff or subagent dispatch, not an inline call), by invocation (a model-invoked skill pays permanent context load for its description). [THEORY + OFFICIAL]

**B11. Post-compaction truncation.** After context compaction, invoked skills are re-attached at ~first 5k tokens each (~25k shared). Decision-critical procedure must live early — or be re-derivable. [MEASURED — Claude Code; version-dependent]

## C. Instruction writing

**C1. Imperative, second person.** Universal across the production corpus ("Read the files", "Run the validator"). [CORPUS]

**C2. Positive imperatives over prohibitions.** Naming the forbidden thing primes it (measured: ~87% of violations are priming failures). State the target behavior so the banned one is never spoken. A prohibition earns its place only as a hard guardrail paired with its positive target. [MEASURED — semantic-gravity study, negation inverse-scaling + THEORY]

**C3. Match the form to the failure.**

| Failure | Form |
|---|---|
| discipline skipped under pressure | prohibition + rationalization table + red-flags list |
| wrong output shape | positive recipe/contract ("state what the output IS") |
| omitted element | REQUIRED slot in the template |
| conditional behavior | conditional on an *observable* predicate |
| repeated rationalization | excuse→reality table, quotes verbatim from baseline |

Prohibition lists measurably *increase* unwanted output for shape problems; recipes win. No nuance clauses. No exemption clauses. [MEASURED — superpowers wording tests]

**C4. Completion criteria on every step.** Checkable *and* exhaustive ("every modified model accounted for" > "produce a change list"). Vague bounds → premature completion; demand drives legwork. Sharpen the bound first; hide later steps only across a real context boundary. [THEORY + MEASURED — MAST verification failures ≈17%]

**C5. Numbered steps; each names action + tool + output.** Edge cases become `if X → do Y` branches (logic), not enumerated prose (examples). [OFFICIAL — OpenAI agents guide]

**C6. Leading words.** Compress recurring concepts into single pretrained tokens (*tight*, *red*, *ledger*); repeat the token, never the definition; reuse it in body and description. Coined words recruit no priors — you pay definition tokens for what a known word gives free. [THEORY]

**C7. Explain the why for heuristics.** Reasoned instructions beat "musty MUSTs"; ALL-CAPS ALWAYS/NEVER walls are a yellow flag — reframe with reasoning. But: binary enumerated bans ("zero em-dashes") beat soft limits ("use sparingly") for known model tics. Emphasis is a prioritization signal, not a compliance guarantee — it doesn't rescue scale. [OFFICIAL + MEASURED — taste-skill field notes]

**C8. One term per concept, consistently.** Synonym drift confuses matching inside the loaded file. [OFFICIAL]

**C9. Declare your syntax.** "Sections are `##` headers; code in fenced blocks" — naming delimiters measurably improves robustness more than the choice of delimiter. Keep formatting conventional and consistent. [MEASURED]

**C10. Examples are format contracts.** 1–2 canonical ❌/✅ pairs teach format/label-space better than content lists. Diverse > numerous. Never enumerate every edge case as prose — branch it instead. [MEASURED — Min et al.; OFFICIAL]

**C11. Persona = judgment compression, not accuracy.** "You are a lazy senior dev" buys a decision system in one line; personas do *not* improve objective accuracy and can hurt it. Use for voice/judgment; use domain priming (task vocabulary) for competence. [MEASURED — 162-role study + CORPUS]

**C12. Verification built in.** A pass/fail check the agent can run (command, checklist, criterion), explicit termination conditions, loop bounds ("stop after 3 failed fixes → escalate"), and success criteria inside the skill so the agent self-checks. [OFFICIAL + MEASURED — MAST]

**C13. The no-op test.** "Would the model do this anyway?" — if yes, delete the whole line, don't trim it. Model-relative, settled by running the document, not debate. The environment (package.json, `--help`, directory layout) is a source of truth too — cache only what the agent can't find by looking: unwritten conventions, reasons behind choices, gotchas. [THEORY + OFFICIAL]

**C14. No menus of options.** "You can use pypdf, or pdfplumber, or PyMuPDF…" → give a default + an escape hatch. [OFFICIAL]

**C15. No time-sensitive content.** "Before August 2025…" rots. Use collapsible "Old patterns" sections or delete. [OFFICIAL]

**C16. Name the failure modes.** "AI tells", "sediment", "a bug farm with a hit rate" — a named mode is a leading word that makes detection reflexive. Rationalization tables (excuse → reality) and red-flags lists preempt known self-deception — build them from *verbatim baseline quotes*. [MEASURED — superpowers + CORPUS]

**C17. Checklist-copy pattern.** Having the agent copy a checklist into its reply re-surfaces rules into recent context mid-task — self-generated recency that counteracts drift. [OFFICIAL]

**C18. Design for drift.** Multi-turn instruction compliance decays (~15–20 pts by turn 3); re-inject critical rules at the point of action — per-step reminders, checklists, gates. Don't assume the file is re-read later. [MEASURED — Multi-IF, EvolIF]

**C19. Gotchas are the highest-value section.** Concrete corrections of mistakes the agent *will* make — convert every observed correction into a gotcha. [OFFICIAL + CORPUS — flagged as highest-signal content in a 138k-skill corpus study]

**C20. Persuasion, scoped.** For discipline skills: authority ("YOU MUST"), commitment (announce skill usage), social proof ("Every time"), unity ("your human partner") — measured compliance lift 33%→72% in persuasion research. For reference skills: clarity only, all persuasion off. Never sycophancy. [MEASURED — Cialdini/Meincke applied by superpowers]

## D. Bundled resources

**D1. Scripts for deterministic/fragile work.** Executed, never loaded — only output costs tokens; "more reliable than generated code". [OFFICIAL]

**D2. Agent-facing script contract.** No interactive prompts (hard rule — hangs forever); `--help`; structured stdout, diagnostics → stderr; bounded output (agents truncate ~10–30k chars); meaningful exit codes; idempotent; `--dry-run` for write ops; errors that state what failed + what to try; no magic constants. [OFFICIAL]

**D3. Invoke via interpreter.** `bash scripts/x.sh`, never bare path — packagers strip executable bits. [MEASURED]

**D4. Declare run-vs-read.** "Run `x.py`" (execute) vs "See `x.py` for the algorithm" (read as documentation). Undeclared code is ambiguous surface. [OFFICIAL]

**D5. Degrees of freedom ↔ fragility.** High freedom (prose heuristics) for context-dependent work; medium (pseudocode/params) for preferred patterns; low (exact script) for fragile operations. Narrow bridge → guardrails; open field → direction. [OFFICIAL]

**D6. Poka-yoke the interface.** Constrain inputs so misuse is structurally impossible (forced absolute paths eliminated an error class on SWE-bench); unambiguous names (`user_id` not `user`). [OFFICIAL + MEASURED]

**D7. Bundle what agents reinvent.** If every baseline run independently writes the same helper, it belongs in `scripts/`. [OFFICIAL]

**D8. Forward slashes, descriptive names.** `references/api-errors.md`, never `doc1.md`; Windows backslashes break cross-platform. [OFFICIAL]

## E. Testing & evals

**E1. Evals before docs.** Identify capability gaps by running the agent *without* the skill first; write minimal instructions; iterate. [OFFICIAL]

**E2. Baseline is mandatory.** Run with-skill AND no-skill (or old-skill) in the same turn — a skill that can't beat baseline is decoration. Watch the failure happen; if the control doesn't fail, stop. [OFFICIAL + MEASURED — OpenHands, SkillsBench]

**E3. Trigger evals — the algorithm.** ~20 realistic prompts (file paths, personal context, column names, typos, abbreviations); 8–10 should-fire + 8–10 near-miss should-NOT; 3 runs each; 60/40 train/validation split; revise only from train failures; never keyword-stuff failed queries (overfitting); select on validation score; ~5 iterations. Pass >50% per case; target ~90%. [OFFICIAL]

**E4. Task evals.** 2–3 realistic cases; assertions drafted *after* seeing outputs (objectively verifiable, descriptive names — don't force them on subjective quality); record tokens/duration; aggregate mean±stddev + delta vs baseline. [OFFICIAL]

**E5. Pressure tests for discipline skills.** Fresh single-shot contexts; realistic system prompt; combine 3+ pressures (time, sunk cost, authority, exhaustion); 5+ reps — single samples lie; **variance is a metric** (5 interpretations = wording isn't binding); always a no-guidance control. [MEASURED — superpowers]

**E6. Loophole closure.** Each observed evasion gets an explicit counter; rationalization table grows from *verbatim observed excuses*; "violating the letter is violating the spirit" for discipline skills. [MEASURED]

**E7. Meta-testing.** Ask the agent that failed: "how should this skill have been written?" — surfaces wording fixes invisible to the author. [MEASURED]

**E8. Test on the real harness.** Simulated API runs vs real CLI gave different trigger rates. Also test across model tiers — smaller models need more guidance. [MEASURED + OFFICIAL]

**E9. Human knowledge in.** Self-generated skills ≈ no measured benefit; models can't reliably author the procedural knowledge they benefit from. Capture human expertise, then agent-iterate on observed failures. [MEASURED — SkillsBench]

**E10. Skills can regress.** Curated skills +16.6pp average but negative deltas on ~19% of tasks; an untriggered skill scored *below* baseline in one vendor eval. Measure before installing; remove dead skills. [MEASURED — SkillsBench, Vercel]

## F. Portability & packaging

**F1. Six portable fields only.** `name`, `description`, `license`, `compatibility` (≤500 chars), `metadata` (string map), `allowed-tools` (experimental, space-separated). Anything else hard-fails official upload/validation. [SPEC]

**F2. Harness dialects — non-portable extras.**

| Harness | Extra fields |
|---|---|
| Claude Code | `when_to_use`, `argument-hint`, `disable-model-invocation`, `user-invocable`, `disallowed-tools`, `model`, `effort`, `context: fork`, `agent`, `background`, `hooks`, `paths`, `shell` |
| Devin | `triggers: [user, model]`, `permissions.{allow,deny,ask}`, `subagent`/`agent`, `argument-hint`, `model` |
| OpenAI/Codex | `agents/openai.yaml` sidecar (`display_name`, `short_description`, `default_prompt`, `policy.allow_implicit_invocation`) |

Write once portable; add dialect fields per target. `allowed-tools` is broadly supported; `context: fork`/`hooks` are Claude-Code-only. [SPEC-per-harness + MEASURED]

**F3. Layout.** `skill-name/SKILL.md` required; optional `scripts/`, `references/`, `assets/`; case-sensitive filename; relative paths, one level deep. Canonical distribution layout: `skills/[<category>/]<name>/SKILL.md`, depth ≤3. [SPEC + CORPUS]

**F4. No human docs inside the skill.** No README, CHANGELOG, QUICK_REFERENCE — only what an agent consumes. [OFFICIAL]

**F5. Security.** Frontmatter + body are system-prompt surface: no `<`/`>` in description, no reserved words in name. No secrets anywhere in the bundle. Audit fetched/external content — instruction-shaped payloads in references are an injection vector. AI-authored skills carry ~2.3× safety defects — self-review before shipping. [SPEC + OFFICIAL + MEASURED]

**F6. Invocation control is a feature.** `disable-model-invocation` for hand-fired/orchestrator skills; `permissions.deny`/hooks for side-effectful skills (deploy, send, commit) — hard blocks beat polite requests. [CORPUS + OFFICIAL]

**F7. Distribution mechanics.** `npx skills` is the de facto package manager (70+ agents, per-agent dirs, symlink default); `.claude-plugin/` manifests for marketplaces; `llms.txt` index + README badge aid discovery; install name = frontmatter `name`, which may differ from folder. [CORPUS + MEASURED]

**F8. Packaging.** `.skill` = zip of the folder; exclude `__pycache__`, `node_modules`, `.DS_Store`, `*.pyc`, root `evals/`. [OFFICIAL]

## G. Composition & library health

**G1. Library ceiling ~30 skills.** Measured pass-rate loss: −8 pts @52 skills, −14 @102, −21 @202; abandonment (no skill invoked) rises 12%→38.5%. Vendor tool-selection guidance warns past ~30–50 available tools — same mechanism. [MEASURED]

**G2. Shadowing dominates.** ≤68% of the degradation above is description overlap, not token bloat. Audit the installed set pairwise for trigger overlap. [MEASURED]

**G3. Inter-skill calls by name.** `Call the Skill tool with "grilling"` or `REQUIRED SUB-SKILL:`/`superpowers:<name>` — never `@`-links (force-loads files into context). A user-invoked skill may invoke model-invoked skills, never another user-invoked one. [CORPUS + THEORY]

**G4. Router skills.** When user-invoked skills multiply past human memory, one user-invoked skill names the others + when to reach for each — it hints, never fires them. [THEORY + CORPUS]

**G5. Suite design.** Shared vocabulary, shared tag taxonomy, closed loops (one skill leaves `ponytail:` markers, another harvests them; one generates triggers, a debugging skill consumes them). Design the suite, not just the skill. [CORPUS]

**G6. Config lives outside.** A `setup-*` skill writes repo-local config (`docs/agents/*.md`) that skills read at runtime — skills stay identical across repos. [CORPUS — mattpocock]

## H. Lifecycle & maintenance

**H1. Version like software.** Semver + changesets + CHANGELOG outside the skill dirs; lifecycle buckets (`in-progress/` → promoted → `deprecated/`). [CORPUS — mattpocock]

**H2. Prune sediment.** Lines go stale as behavior changes; unpruned docs accumulate dead layers. The no-op test (C13) never expires — re-run it on every edit. [THEORY]

**H3. Change on evidence, not style.** "Skills are not prose — they are code that shapes agent behavior." No restructuring without eval evidence. [CORPUS — superpowers AGENTS.md]

**H4. Seed new skills.** Zero-usage skills are evicted first under listing budget pressure (usage decays ~50%/week in measured implementations) — invoke once manually after install. [MEASURED — Claude Code internals; version-dependent]

**H5. Diagnose delivery before wording.** `--debug` surfaces YAML parse errors (a broken frontmatter loads mute); `/doctor`, `/context` show listing cost. "Rewriting a description the model never received fixes nothing." [MEASURED]

**H6. Write-back loop.** After novel failures/successes in the skill's domain, the agent updates the skill — capture common mistakes + successful approaches. Skills are compiled procedural memory. [OFFICIAL + papers — Reflexion/ExpeL lineage]

**H7. Honesty bounds.** Never invent metrics ("per-repo savings" with no baseline), never print unverifiable numbers, version-and-date every mechanism claim — constants rot across harness versions. [CORPUS + practitioner]

**H8. Telemetry.** Log invocations (PreToolUse hooks where available) to catch under/over-triggering in the field. [CORPUS]

## I. Documented failure modes → fixes

| Failure | Evidence | Fix |
|---|---|---|
| Never triggers — weak description | most common field report | rewrite to A2 grammar w/ verbatim triggers |
| Never triggers — description evicted | listing budget overflow; least-used dropped first | shorten descriptions; seed usage; cut library size |
| Triggers interactively, 0% headless | confirmed harness bug | explicit invocation in scripts; not an authoring fix |
| `paths:`-gated skill never fires | activation wired to Read/Edit only | description-based triggering, not `paths:` |
| YAML error → loads mute | unquoted `:`/`#`/brackets | quote description; `--debug` |
| Two skills coin-flip one request | overlapping descriptions | NOT-clauses; merge or split cleanly |
| Mega-skill matches all weakly | >~250-char honest description | decompose into core + satellites |
| Mid-run instruction decay | per-turn drift measured | bookends; checklist-copy; gates; hooks for hard rules |
| Body ignored — description summarized workflow | agent executes desc, skips body | strip process from description (A9) |
| Skill abandoned at scale | 202-skill library → 38.5% no-invoke | cap library; disjoint descriptions; router skills |
| `head -100` truncated nested refs | refs >1 level deep | flatten to one level |
| Stale skills actively hurt | +20% token cost, no gain (ETH study); below-baseline scores (Vercel) | prune; measure before installing |
| Keyword-stuffing overfit | description tuned to failed queries | fix general category, not the literal phrase; held-out validation |

## J. Contested rules → resolutions

**J1. Pushy vs short descriptions.** Vendor says "err pushy" (under-triggering is the default bias); measured evals show ~15-word descriptions beating verbose ones, and every char spends shared listing budget. *Resolution:* pushy in **wording** (explicit trigger intent), tight in **length** — never past the point of stealing budget or diluting the primary trigger.

**J2. What+when vs when-only.** Official formula = what it does + when to use; superpowers = trigger conditions only (measured: workflow summaries get executed in place of the body). *Resolution:* include *capabilities* (what — needed for discrimination vs siblings, A12), exclude *process* (how — causes shortcutting, A9).

**J3. Personas.** Vendor/corpus uses them; academic studies show no accuracy gain, sometimes harm. *Resolution:* persona carries **judgment and voice** (a compressed decision system); never expect it to carry **competence** — that comes from procedure + domain priming.

**J4. Edge cases: include or not?** OpenAI: capture them. Anthropic: don't stuff edge-case lists; canonical examples instead. *Resolution:* encode edge cases as `if→then` **branches** (logic); keep **examples** few and canonical.

**J5. Negations.** Theory/research: prohibitions prime the forbidden behavior. Community: "never do X" lines are the highest-valued content; binary bans beat soft limits. *Resolution:* prefer positive phrasing as default; prohibitions are valid for (a) hard guardrails paired with the positive target, (b) enumerated *binary* bans on known tics, (c) boundary clauses in descriptions. Never use negation as the primary steering mechanism.

**J6. Skills vs always-on files.** One controlled eval: passive 8KB index beat skill retrieval 100% vs 79% — for *knowledge lookup*. Skills added +16.6pp on *procedural* tasks. *Resolution:* knowledge that must always apply → AGENTS.md/index; procedures, disciplines, judgment → skills.

**J7. XML/markdown formatting.** Vendor docs recommend XML tags; benchmarks find no reliable format superiority — model-dependent. *Resolution:* declare and stay consistent; don't cargo-cult a syntax.

**J8. Many small skills vs few consolidated.** Voyager-style libraries grow many small skills; tool-guidance consolidates. *Resolution:* different layers — consolidate the *tool surface* (actions); skills stay narrow because only their descriptions cost context. The real metric is **overlap at decision time**, not count.

---

*Sources: synthesized from a 10-agent research pass — Anthropic official docs/spec/skill-creator, agentskills.io open spec, obra/superpowers (296k★), mattpocock/skills (279k★), anthropics/skills (180k★), Leonxlnx/taste-skill (93k★), headroom, handoff-genre, vercel-labs/skills (skills.sh), academic literature (Voyager, ReAct, Toolformer, AWM, ExpeL, Reflexion, MAST, Prompt Report, Bsharat principles, Lost-in-the-Middle, Chroma Context Rot, SkillsBench, skill-shadowing & SkillRouter papers, 138k-skill corpus study), and practitioner field reports (HumanLayer, happyskills binary analysis, Scott Spence trigger experiments, Vercel evals, Devin docs, HN field reports). Version-specific constants may drift — re-verify against the live spec.*
