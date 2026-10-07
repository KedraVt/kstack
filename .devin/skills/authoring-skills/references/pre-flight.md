# Pre-flight checklist

Mechanical checks to run on every skill draft and every edit. THIS IS NOT OPTIONAL. If any box fails, the skill is not done. Most checks are greppable — run them, don't eyeball them.

## 1. Spec compliance — hard-fail checks

- [ ] `SKILL.md` exists at `skills/.../<name>/SKILL.md`, case-sensitive, sits ≤3 levels deep
- [ ] File starts with `---`; frontmatter parses as valid YAML (quote any value containing `:`, `#`, `[`, `]`)
- [ ] Only allowed keys: `name`, `description`, `license`, `compatibility`, `metadata`, `allowed-tools` — or documented harness-specific extras when targeting that harness
- [ ] `name` matches `^[a-z0-9-]+$`, ≤64 chars, no leading/trailing/double hyphens, equals the parent directory name, contains no reserved word
- [ ] `description` non-empty, ≤1024 chars, contains no `<` or `>`
- [ ] `compatibility` ≤500 chars if present
- [ ] No README/CHANGELOG/QUICK_REFERENCE inside the skill directory

## 2. Router — the description

- [ ] Third person throughout (grep for `I can`, `You can`, `I'll` → fail)
- [ ] Matches the formula: capabilities + "Use when…" + trigger phrases + "Do NOT use for…" boundaries
- [ ] Primary trigger in the first ~200 chars (front-loaded)
- [ ] ≥1 verbatim user utterance or concrete artifact (quoted phrase, file extension, error string)
- [ ] No workflow summary — grep for process verbs in the description ("then it will…", "it works by…") → fail
- [ ] Compared pairwise against every installed sibling description: no overlap that creates a coin-flip
- [ ] One trigger per distinct branch — no synonym written twice

## 3. Body

- [ ] <500 lines (target <5k tokens)
- [ ] Critical rules appear at top AND repeat verbatim at bottom
- [ ] ≤~10 hard constraints — more → split the skill
- [ ] Every step/phase ends on a checkable, exhaustive completion criterion
- [ ] Each step names an action, a tool, and an output
- [ ] No workflow menus ("you could use A, or B, or C…") — one default + escape hatch
- [ ] Prohibition scan: every "don't X" either (a) pairs with its positive target, (b) is a binary enumerated ban on a known tic, or (c) is a boundary clause — else rewrite positively
- [ ] No nuance clauses ("unless it matters"), no exemption clauses
- [ ] One term per concept — no synonym drift
- [ ] No time-sensitive content (dates, "currently", "recently" → delete or reframe)
- [ ] No-ops deleted: each line changes behavior vs default (if unsure, test by running, not debating)
- [ ] Verification step exists: a command, checklist, or criterion the agent can pass/fail
- [ ] Termination conditions + loop bound stated ("after N failed fixes → escalate")
- [ ] Declared syntax conventions if any ("sections are `##` headers…")

## 4. Bundle

- [ ] `scripts/` — no interactive prompts; `--help` works; stdout/stderr split; bounded output; exit codes; errors say what failed + what to try; invoked via interpreter (`bash scripts/x.sh`), never bare path
- [ ] Every bundled file declared run-vs-read ("Run `x.py`" vs "See `x.py`")
- [ ] Every bundled file reachable by a *when-pointer* in the body ("read X if Y") — a bare listing fails
- [ ] `references/` one level deep from SKILL.md; files >100–300 lines start with a TOC
- [ ] Forward slashes in all paths
- [ ] Scripts handle errors in-script ("solve, don't defer"); no magic constants

## 5. Proof — evals done, not vibes

- [ ] Baseline run recorded *without* the skill (no-skill control) — and it actually failed
- [ ] Trigger evals: ≥8 should-fire + ≥8 near-miss should-NOT prompts, 3 runs each; passed on a held-out validation split; no keyword-stuffed failed queries
- [ ] Task evals: ≥2 realistic cases; with-skill vs baseline compared same-turn; assertions written after seeing outputs
- [ ] Discipline skills: ≥5 pressure reps in fresh contexts; loopholes closed; variance reviewed
- [ ] Token/time cost recorded — passing-but-2×-cost → prune
- [ ] Tested on every model class it will ship to

## 6. Ship

- [ ] Security: no secrets; no unvetted piped scripts; no unwritten instruction-shaped content in references
- [ ] Invocation mode deliberate (`disable-model-invocation` set or justified)
- [ ] Side-effectful skills carry `permissions`/`deny`/`hooks` where the harness supports them
- [ ] Packaged: `skills/[<category>/]<name>/SKILL.md` layout; plugin manifest if marketplace-bound
- [ ] Versioned; changelog entry written outside the skill dir
