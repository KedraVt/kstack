---
name: kstack-risk-scan
description: STRIDE-lite threat model and risk assessment over architecture and system designs. Use when auditing design docs, reviewing trust boundaries from capability specs, or identifying security and operational risks before implementation. Do NOT use for code-level security audits (use kstack-cso) or product capability definition (use kstack-product-capability).
compatibility: Runs on system-design_XX.md with product-capability_XX.md context; produces findings and in-session doc hardening.
---

<!-- provenance: kstack/risk-scan · authored S4 2026-10-11 -->

# Risk Scan (STRIDE-lite)

Audit the technical design against declared trust boundaries before implementation begins.
Fixable design ambiguities and security gaps must be corrected **in session** directly within `system-design_XX.md`.
Unresolvable trade-offs are documented as explicit open items for the Architect Review Gate.

## Inputs
- `product-capability_XX.md`: Trust boundaries, actors, assets, authentication/authorization requirements.
- `system-design_XX.md`: Domain models, API schemas, process workflows, local topology, integrations.

## STRIDE-lite Categories
1. **Spoofing**: Can an attacker forge identities across bounded contexts or API boundaries?
2. **Tampering**: Are data stores, state transitions, or event streams vulnerable to unauthorized mutation?
3. **Repudiation**: Does the architecture maintain an append-only audit trail or provable transaction ledger?
4. **Information Disclosure**: Do API responses, logs, or telemetry leak sensitive tokens, internal paths, or credentials?
5. **Denial of Service**: Are resource quotas, timeouts, rate limits, and unbonded queues bounded and guarded?
6. **Elevation of Privilege**: Are ACLs, role checks, and sandboxes enforced at the perimeter and internal interfaces?

## Procedure
1. **Enumerate Trust Boundaries**: Trace every cross-boundary boundary from the capability spec (client ↔ API, worker ↔ broker, orchestrator ↔ child process, external service ↔ webhook).
2. **Apply STRIDE Checklist**: Evaluate each category against the domain aggregates, invariants, and sequence diagrams.
3. **Remediate In-Session**:
   - Add missing validation constraints directly to `system-design_XX.md`.
   - Tighten Boolean invariants (`INV-XX`).
   - Define missing unhappy path payloads (4xx/5xx).
4. **Document Residual Risks**: Any unfixable architectural tension must be logged under an explicit `## Residual Risks & Decisions` section for review by the software architect.

## DoD gate
- Every trust boundary enumerated in `product-capability_XX.md` is addressed in the risk review.
- Each of the 6 STRIDE-lite categories is explicitly evaluated.
- Fixable vulnerabilities are patched directly into `system-design_XX.md` before proceeding.
- All residual or unmitigated risks are documented with clear options for the Architect Review Gate.
