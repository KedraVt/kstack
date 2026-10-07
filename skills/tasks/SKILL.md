---
name: tasks
description: Ingests functional requirements from *user-story_XX.md* and technical layout from *system-design_XX.md* to break the execution workflow into role-assigned, atomic tasks. Ensures maximum clarity, order, and structural rigor for all sub-agents.
---

<!-- provenance: kedra/tasks (verbatim) · ported S1 2026-02-11 -->

# Tasks

## Task Rules

- **Atomicity**: Tasks must be atomic, representationally independent, and sequentially assignable.
- **Data Payloads**: Tasks must include the necessary input data payloads, API schemas, or environment contexts.
- **Constraints**: Tasks must outline strict constraints guiding the sub-agent (e.g., architectural patterns).
- **Success Condition**: Tasks must contain a clear, empirical success condition.
- **Artifact Target**: All broken-down tasks must be collected into a file named *tasks_XX.md* in the root, sorted by ID, rigidly following the template below.
- **Resilience**: Tasks must explicitly define unhappy paths or fallback behaviors for the developer sub-agents to evaluate before stopping.

## Task Breakdown

1. Analyze the technical complexities of *user-story_XX.md*.
2. Decide *how* to implement the features based on the chosen architecture from *ADR-log_XX.md* and *system-design_XX.md*.
3. Formalize: write a detailed to-do list of atomic, sequentially assignable tasks for each sub-agent role (planner, software-architect, frontend-developer, backend-developer, qa-engineer, devops-devsecops).
4. Establish and enforce a rigorous Definition of Done from *definition-of-done.md* to ensure quality and completeness.

# Tasks Template

```markdown
## ROLE (e.g., BACKEND DEVELOPER)

### Goal_XX
[Goal that the sub-agent should reach by completing its tasks]
[Extended description of the goal to provide macroscopic context to the agent]

### TASK_XX
- **Atomic description**: [title, description]
- **Context & inputs**: [component layer from system-design (e.g., API Layer / Worker Core), data payload & invariants]
- **Constraints**: [glossary enforcement, boundary obedience (constraints from *system-design_XX.md* and *ADR-log_XX.md*)]
- **Unhappy paths**: [technical fallback behavior or structured error payload response]
- **Success condition**:
  - Action: [exact CLI command, test script, or endpoint to call]
  - Expected: [expected verifiable output (e.g., "exit status 0" or "HTTP 200")]
- **Execution steps**: [ordered list of steps]
```

## DoD gate (verification)

- DoD: tasks_XX.md entries atomic (one verifiable outcome each) specifying inputs, constraints, unhappy paths, falsifiable success condition, owning role, dependencies. BP: 'build the backend' is not a task; every success condition externally checkable.
