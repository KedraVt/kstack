---
name: gstack-document
description: >-
  Documentation writer and post-ship doc auditor, on the Diataxis framework
  (tutorial / how-to / reference / explanation). Mode generate: codebase
  archaeology → partition plan → quadrant docs with cross-linking and quality
  gates. Mode release: post-ship coverage-map audit of docs vs diff, factual
  updates, CHANGELOG voice polish, gap flagging. Use when the user says
  "document this", "write docs", "update the docs", "README is stale", or when
  ship routes to doc-update before merge. Do NOT use for code review
  (gstack-review) or release mechanics (gstack-ship).
metadata:
  version: "1.0.0"
compatibility: runtime/bin/gstack-redact for leak scanning; degrades to manual-pattern scan when absent.
---

<!-- provenance: gstack/gstack-document-generate (Diataxis writer) + gstack/gstack-document-release (coverage map, doc audit) · merged S1 2026-02-11 -->

# Document

**Research the whole, then write the parts.** Like an architect who surveys
the site before drawing a room — read the full codebase surface before writing
any documentation. Accuracy is non-negotiable: every code example must work,
every API description must match the code.

```bash
bash C:/Users/Mattia/.pi/agent/extensions/gstack-pi/runtime/bin/gstack-telemetry-log --event-type skill_run --skill gstack-document --status start 2>/dev/null || true
```

> **Headless run?** If `ask_user_question` is unavailable (spawned/non-interactive run), default to creating new files under `docs/`, proceed with the full partition plan, and flag deferred choices in the output — never block waiting for an answer.

## Mode resolution

| Mode | When | Behavior |
|------|------|----------|
| **generate** | "document this" on a feature/module/project; or filling coverage gaps flagged by release mode | Archaeology → Diataxis partition → write quadrant docs → cross-link → quality gates → commit. |
| **release** | After ship, before PR merge | Coverage-map audit of docs vs diff; factual updates only; flag gaps — never auto-generate pages. |

## Generate mode

### Step 0: Scope & intent

1. Determine scope: explicit target (feature/module/file) · entire project ·
   specific entities from a release-mode coverage map.
2. `ask_user_question` — documentation target: A) inline in existing files
   B) standalone `docs/` C) both (recommended — discoverability + depth).
3. Follow existing conventions: `docs/` dir, doc framework (Nextra,
   Docusaurus, MkDocs, VitePress), else plain Markdown in `docs/`.

### Step 1: Codebase archaeology (the most important step)

1. Map structure: `find . -type f -not -path "./.git/*" -not -path "./node_modules/*" -not -path "./dist/*" | head -200`.
2. Read entry points: README, ARCHITECTURE, CONTRIBUTING, AGENTS.md,
   manifests, main entry files, config.
3. For each target entity: read implementation end-to-end (not signatures),
   read the tests (they reveal intended behavior and edge cases), read
   dependents and dependencies, read `// NOTE:`/`// DESIGN:`/`// WHY:` comments.
4. Build a concept map: purpose · 3–5 key concepts · public surface ·
   dependencies/dependents · edge cases · design decisions.
5. Output: "Researched N files, K public surface items, M concepts, J design
   decisions."

### Step 2: Diataxis partitioning

Decide which quadrants each entity needs — not every entity needs all four:

| Entity type | Tutorial | How-to | Reference | Explanation |
|---|---|---|---|---|
| User-facing feature | ✅ | ✅ | ✅ | maybe |
| CLI command/flag | maybe | ✅ | ✅ | no |
| Internal module | no | no | ✅ | ✅ |
| Config option | no | ✅ | ✅ | no |
| Design pattern | no | no | no | ✅ |
| API endpoint | maybe | ✅ | ✅ | no |
| Workflow | ✅ | ✅ | no | maybe |

Output the partition plan; >5 documents → confirm via `ask_user_question`.

### Steps 3–6: Write quadrants (reference → explanation → how-to → tutorial)

Order matters: reference first — it establishes vocabulary. Templates and
per-quadrant rules: `references/diataxis-templates.md` — read it before
writing; it is the source of truth for format.

### Step 7: Cross-linking & discoverability

- Every quadrant links to its siblings (reference↔how-to; tutorial→both).
- Update entry points: README docs section, AGENTS.md structure, docs index/
  sidebar config.
- Every new doc reachable within 2 clicks from README; grep for `](` links to
  files that don't exist.

### Step 8: Quality self-review — fix failures before committing

- **Accuracy**: every example compiles/runs; every API matches the signature;
  every command produces the output shown; no stale references.
- **Completeness**: reference covers 100% public surface; how-tos cover the
  top-3 user tasks; tutorials hit a working result in ≤3 steps; explanations
  name trade-offs.
- **Voice**: smart person who hasn't seen the code; jargon glossed on first
  use; active voice; "You can now…" not "The system provides…".

### Step 9: Commit & output

1. Stage doc files by name — never `git add -A`.
2. **Redaction scan before commit** — generated docs love embedding example
   credentials; a live-format secret in committed docs is a leak:
   ```bash
   git diff --cached --no-color | grep '^+' | sed 's/^+//' | \
     bash C:/Users/Mattia/.pi/agent/extensions/gstack-pi/runtime/bin/gstack-redact --json
   # exit 3 (HIGH) → unstage, remove the secret, re-stage. Do NOT commit.
   ```
3. `git commit -m "docs: generate [scope] documentation (Diataxis)"`, push to
   the branch.
4. If a PR exists, add a `## Documentation Generated` section: table of files ×
   quadrant × one-line description.
5. Structured summary: scope · files new/updated · per-quadrant counts ·
   quality-gate results.

## Release mode

Runs after ship, before the PR merges. Mostly automated — **only stop for**:
risky/subjective doc changes (narrative, philosophy, security, removals, large
rewrites) · VERSION bump decisions · new TODOS items · cross-doc narrative
contradictions. **Never stop for** factual corrections from the diff, list/
table additions, path/count/version updates, stale cross-references, CHANGELOG
voice polish, marking TODOS complete. **NEVER**: overwrite/regenerate
CHANGELOG entries (polish wording only — Edit with exact matches, never Write);
bump VERSION without asking.

### Step 1: Pre-flight & diff analysis

- On the base branch → abort: "Run from a feature branch."
- `git diff <base>...HEAD --stat` + `git log` + `--name-only`.
- Discover docs: `find . -maxdepth 2 -name "*.md" -not -path "./.git/*" -not -path "./node_modules/*" -not -path "./.gstack/*" | sort`.
- Classify changes: new features · changed behavior · removed functionality ·
  infrastructure.

### Step 1.5: Coverage map (blast-radius analysis)

Extract public-surface changes from the diff (new exports, commands, flags,
endpoints, env vars; renamed/removed surface). For each, assess doc coverage:

```
Coverage map:
  [entity]         [reference?] [how-to?] [tutorial?] [explanation?]
  /new-skill       ✅ AGENTS.md  ❌        ❌          ❌
  --new-flag       ✅ README     ✅ README  ❌          ❌
```

Zero coverage → **critical gap**, flag it. Reference-only → common gap, note
for PR body. **Diagram drift:** extract entity names from ASCII/Mermaid
diagrams in docs; flag entities renamed/split/removed by the diff — advisory
only, never auto-edit diagrams (human judgment).

The coverage map informs; it never generates. Significant gaps → suggest
running generate mode as follow-up.

### Steps 2–9: Doc audit & updates

Read `references/release-body.md` and execute it in full — per-file audit,
CHANGELOG voice polish, cross-doc consistency, TODOS cleanup, VERSION ask,
commit. It is the source of truth; do not work from memory.

## Important rules

- **Read before editing.** Always read the full file before modifying it.
- **Coverage map informs, never generates.**
- **Never clobber CHANGELOG** — polish only, preserve all content.
- **Be explicit about what changed** — every edit gets a one-line summary.
- **Cross-link everything** — isolated docs are undiscoverable docs.
- **Completeness over minimalism** — write complete docs; boil the ocean.

```bash
bash C:/Users/Mattia/.pi/agent/extensions/gstack-pi/runtime/bin/gstack-telemetry-log --event-type skill_run --skill gstack-document --status end 2>/dev/null || true
```

## DoD gate (verification)

- **generate**: partition plan emitted; every produced doc follows its
  quadrant template; cross-links + ≤2-click discoverability verified; accuracy
  gate run (examples compile, APIs match); redaction scan passed; summary
  emitted.
- **release**: coverage map emitted (gaps flagged, not filled); doc edits are
  factual-only or were asked; CHANGELOG edited with targeted Edits; VERSION
  untouched or user-approved.
- Termination: on base branch → abort; >5 docs to generate → confirmed first.

## Bundled files

| File | Run or read | Load when |
|---|---|---|
| `references/diataxis-templates.md` | read | before writing any quadrant doc (generate) |
| `references/release-body.md` | read | before the per-file doc audit (release steps 2–9) |

---

**Research the whole, then write the parts. Accuracy is non-negotiable: every
code example must work, every API description must match the code.**
