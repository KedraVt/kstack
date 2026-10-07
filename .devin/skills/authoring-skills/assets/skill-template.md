---
# Replace every {{placeholder}}. Delete any section your genre doesn't need.
# name must equal this directory's name. description ≤1024 chars, no < >.
name: {{gerund-verb-cluster}}
description: {{What it does — capabilities}}. Use when {{trigger branch 1}}, {{branch 2}}, or when the user says "{{verbatim utterance}}", mentions {{file types/symptoms}}, or asks for {{task}} — even if they don't explicitly request {{name}}. Do NOT use for {{sibling territory}} (use {{sibling}} instead) or {{out-of-scope}}.
# Uncomment only if hand-fired/orchestrating (harness-specific field):
# disable-model-invocation: true
metadata:
  version: "0.1.0"
---

# {{Title matching name}}

{{One sentence: what this skill makes the agent DO.}}
{{1–3 critical rules stated here — they repeat verbatim at the bottom.}}

## Overview / core principle

{{The leading-word concept this skill hangs on, in ≤3 lines.}}

## When to use / when not to

| Reach for this when | Reach elsewhere when |
|---|---|
| {{branch}} | {{boundary → sibling/nothing}} |

## The procedure

<!-- PROCESS/WORKFLOW genre: numbered gated phases.
     MODE/PERSONA genre: persona line + ordered decision ladder + persistence + off-switch.
     ROUTER/INDEX genre: first-matching-row table dispatching to bundled files.
     FLAT REFERENCE genre: co-located rules + exhaustiveness bar. -->

1. {{Step}} — done when {{checkable, exhaustive criterion}}.
2. {{Step}} — done when {{criterion}}.
   - If {{observable condition}} → {{branch action}}.

## Quick reference

| {{Want}} | {{Do / Read}} |
|---|---|
| {{case}} | {{action or `references/x.md`}} |

## Examples

❌ {{bad output/behavior — real, from baseline}}
✅ {{good output/behavior}}

## Common mistakes / gotchas

- {{Concrete mistake the agent WILL make — from baseline evidence}} → {{correction}}

## Common rationalizations

| Excuse | Reality |
|---|---|
| "{{verbatim baseline quote}}" | {{counter}} |

## Red flags — stop and re-read this skill

- {{observable self-deception signal}}

## Verification

- {{pass/fail check the agent can run}}
- Termination: {{when done / when to escalate — "after N failed fixes → …"}}

## Bundled files

| File | Run or read | Load when |
|---|---|---|
| `scripts/{{x.sh}}` | run | {{condition}} |
| `references/{{y.md}}` | read | {{condition}} |
| `assets/{{z}}` | read | {{condition}} |

## Boundaries

- {{What this skill will NOT do — scope edge}}
- {{Where it hands off, and to what}}

---

{{Repeat the 1–3 critical rules from the top, verbatim.}}
