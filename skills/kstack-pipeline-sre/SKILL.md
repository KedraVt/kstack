---
name: kstack-pipeline-sre
description: Designs SRE-grade CI/CD pipelines — pre-commit hygiene, test stages, progressive delivery, rollback strategy, infra stability. Use when the user says "set up CI/CD", "GitHub Actions / GitLab pipeline", "deployment pipeline", "progressive delivery", "release automation", or a pipeline needs hardening. Do NOT use for writing Dockerfiles (use kstack-docker-manager) or debugging a broken build (use kstack-investigate).
compatibility: Sprint doc-chain consumer — reads system-design_XX.md for stack choices (CI provider, runtime, deploy target); standalone invocations must state the stack explicitly.
---

<!-- provenance: kedra/pipeline-sre (verbatim) · ported S1 2026-02-11 -->

# Pipeline Automation & SRE Framework

**Inputs**: reads `system-design_XX.md` for stack choices when present; if absent, the stack (CI provider, language, deploy target) must be stated inline.

Apply this framework when building CI/CD pipelines, configuring infrastructure, or establishing deployment strategies. **Read `system-design_XX` to determine the specific tools (e.g., GitHub Actions vs GitLab CI, Docker, Kubernetes vs Serverless, languages to build).**

## Pre-Commit Hygiene & Static Analysis
* Check staged modifications (`git diff --staged`) for leaked secrets.
* Ensure `.gitignore` covers build directories and `.env` files.
* Enforce linting and type checking (specific to the project stack).

## The Quality Gate Pipeline
No gate can be skipped:
Lint -> Type Check -> Unit Tests -> Build -> Integration -> Security Audit (SAST/SCA).

## Deployment & Infrastructure Rules
* **Shift Left**: Catch bugs upstream. Run fast tests before slow tests.
* **Progressive Delivery**: Utilize feature flags and canary deployments where appropriate.
* **Rollbacks**: Every deployment must be instantly reversible via automated rollbacks.
* **Environment Management**: CI must never have production secrets. Use Vaults/Secrets Managers.
* **Containers & IaC**: Provision immutable infrastructure. Generate SBOMs and sign images if applicable. Refer to the `kstack-docker-manager` skill for all Dockerfile patterns (Domain A), sandbox security invariants (Domain B), and compose orchestration templates.

## Output Templates

You MUST write all generated infrastructure code to the shared volume directory (`devops/devsecops/`) so other agents can access it.

### Template A: CI/CD Pipeline Definition
Write the generated pipeline configurations to `devops/devsecops/ci-cd-pipeline.yaml` (or relevant format). Ensure all quality gates are present and tailor it to the `system-design_XX`. Explain caching and parallelization strategies.

### Template B: Dockerfile Audit & Remediation
The Dockerfiles are authored by the dev agents (frontend-developer and backend-developer) following `kstack-docker-manager` Domain A §A1 patterns. Your role is to **audit** those Dockerfiles against the rules defined in `kstack-docker-manager` (non-root user, pinned versions, healthcheck, .dockerignore, no secrets). If the audit fails, produce a corrected version at `devops/devsecops/Dockerfile.<service>` with inline comments explaining each fix.

### Template C: Docker Build & Security Report
Refer to the `kstack-docker-manager` Output Template. Write to `devops/devsecops/docker-build-report.md` with parseable `docker-build` and `docker-security` variables for the Planner's execution loop.

## DoD gate (verification)

- DoD: conditional — applies ONLY when authoring/modifying CI configs; least-privilege tokens, pinned action/tool versions, platform-vault secrets (never inline), fail-fast ordering, documented rollback. BP: reproducible builds over snowflake runners.
