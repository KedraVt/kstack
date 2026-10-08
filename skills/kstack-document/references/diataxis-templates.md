# Diataxis templates

One template per quadrant. Accuracy over elegance — every claim traceable to
code; every example compiles if copy-pasted. Voice: friendly, user-forward —
explain to a smart person who hasn't seen the code.

## Reference (information-oriented)

```markdown
# [Entity Name]

[One paragraph: what it is, what it does, when you'd use it.]

## API / Interface
[Complete public surface: functions, commands, config options, parameters —
types, defaults, constraints. Pull from code, don't paraphrase.]

## Options / Configuration
[Every option with type, default, effect.]

## Examples
[2-3 concrete examples that would actually run.]

## Related
[Links to the how-to / explanation quadrants.]
```

Rules: "Accepts a string" is insufficient — "Accepts a string (max 256 chars,
must match `^[a-z-]+$`)" is reference-grade. Never explain *why* here — that
belongs to explanation.

## Explanation (understanding-oriented)

```markdown
# [Concept / Design Decision]

[The problem this design solves, for a smart reader who hasn't seen the code.]

## The problem
[What goes wrong without this design — real failure modes, not abstractions.]

## The approach
[How the design solves it. ASCII or Mermaid diagrams for architecture.]

## Trade-offs
[What was given up — name it: "We chose X over Y because Z."]

## Alternatives considered
[What was tried/rejected and why, from comments/ADRs/history.]
```

Rules: lead with the problem; name trade-offs explicitly; link to reference,
don't repeat it.

## How-to (task-oriented)

```markdown
# How to [accomplish specific task]

[One sentence: what you'll accomplish and the end result.]

## Prerequisites
[Versions, tools, config state — specific.]

## Steps
1. [Action verb] [specific instruction]
   ```bash
   [exact command]
   ```
   [Expected output, if non-obvious.]

## Verification
[How to confirm it worked — a command, URL, or test.]

## Troubleshooting
[Common failure modes and fixes — pull from tests and error handling.]
```

Rules: title starts with "How to" — no exceptions; every step actionable ("Run
X", never "consider whether…"); verification mandatory; troubleshooting
mandatory if the task can fail.

## Tutorial (learning-oriented)

```markdown
# [Title — what you'll build/learn]

[What you'll build, why it's useful, what you'll understand by the end —
concrete: "You'll build a working X that does Y", not "This tutorial covers X".]

## What you'll need
[Tools, versions, prior knowledge — link to install guides.]

## Step 1: [Set up the foundation]
[Clean state, every command shown, brief explanation on first encounter.]

## Step 2: [Build the first working piece]
[Working, visible result as fast as possible — within the first 3 steps.]

## Step N: [Final step]

## What you built
[Recap + links to reference docs + next steps.]
```

Rules: **time to first result < 3 steps**; every step produces visible output;
exact commands the reader will type; show common errors + fixes inline; end
with "What you built".
