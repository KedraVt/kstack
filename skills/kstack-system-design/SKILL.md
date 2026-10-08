---
name: kstack-system-design
description: Produces a system-design document — tactical DDD domain model, aggregates, bounded contexts, transaction sequences, stack-agnostic architecture. Use when the user says "design the architecture", "technical design doc", "domain model", "bounded context", "map the services", or a user story needs its technical design. Do NOT use for product requirements (use kstack-product-capability), task breakdown (use kstack-tasks), or recording a settled decision (use kstack-adr).
compatibility: Sprint doc-chain middle layer — reads user-story_XX.md, feeds adr and tasks; without it, supply the requirement text directly.
---

<!-- provenance: kedra/system-design (verbatim) · ported S1 2026-02-11 -->

# System Design

**Inputs**: reads `user-story_XX.md` when present; if absent, design from the requirements stated inline. Output feeds `kstack-adr` and `kstack-tasks`.

## Workflow
* **domain & behavior**:
  * **Scan User Story**: Understand what the Product Manager wants through events/brainstorming.
  * **Establish Ubiquitous Language**: Analyze *user-story_XX.md* and extract a strict, shared glossary of technical terms.
  * **Domain & subdomain**: Categorize feature's operational space, distinguish Core domain (based on system invariants) and subdomain (based on supporting/upgrading features). 
  * **Model the Domain**: Define coherent aggregate boundaries and system invariants. Implement a rigorous command/event logic.
* **architecture & infrastructure**:
  * **Context Mapping**: Establish context mapping: you must map the integration boundary of every component affected by the sprint (upstream/downstream relationships, conformist patterns, or anti-corruption layers).
  * **Integration Strategy Justification**: For every Downstream relationship, you must choose and justify a tactical pattern: either an Anti-Corruption Layer (ACL) to sandbox untrusted data/AI-generated inputs, or a Conformist pattern for direct, internal trust boundaries.
  * **Local Topology Enforcement**: The architectural layout must strictly align with the local container environment (e.g., *compose.local.yaml*). You must specify exact local port mappings dynamically based on the chosen stack (e.g., API on Port X, DB on Port Y) and necessary local host directory volume mounts.
  * **Long-Running Processes**: Define explicit state management (e.g., Saga pattern) for asynchronous jobs to track intermediate states and establish strict unhappy paths.
  * **Immutable API & Stream Contracts**: For every component interaction, you must explicitly draft the exact JSON structures and the precise real-time event types (SSE) to act as an unchangeable contract between frontend and backend teams.
  * **Autonomous Design Mandate**: generate robust JSON contracts following the template, strictly typed, REST-compliant, and directly reflect the Aggregates and Invariants defined in your Domain Modeling. Never use lazy or generic data structures.
  * **Deterministic Infrastructure Planning**: You are explicitly responsible for designing the local network topology. When autonomously assigning local host ports, you MUST follow a deterministic spacing logic to prevent collisions (e.g., APIs on 80XX, Databases on 54XX). When selecting the underlying tech stack for the workers, default to standardized, container-friendly solutions unless specific constraints are present.

# Rules
* **Invariant Accountability&consistency**: Every system invariant identified must be written as a strict Boolean logical condition (e.g., "A ProcessingJob cannot be COMPLETED if OutputPath is NULL"), and must be immutable to guide automated QA verification.
* **Subdomain Isolation**: Explicitly flag whether the components belong to the Core Domain (primary business logic/execution engine) or Supporting domains (API metadata, logging) to prioritize optimization and sandbox security.
* **Context**: Every time you use this skill, ensure that the generated *system-design_XX.md* file strictly corresponds to its specific *user-story_XX.md* counterpart in the root directory.
* **Zero Conversational Filler**: The output must contain ONLY the requested Markdown structure. No conversational filler, introductory remarks, or concluding summaries are allowed.
* **Scalability Enforcement**: The architecture MUST mandate stateless design for all execution workers to support horizontal scaling. Resource quotas and load distribution strategies must be defined.
* **Reliability & Resilience**: Explicitly map failure modes for external dependencies and LLM generation (e.g., handling syntactically broken code). You must define retry policies, dead-letter queues, and circuit breaker implementations.
* **Maintainability & Dependency Direction**: Enforce strict module boundaries. Dependencies MUST flow strictly inwards toward the Core Domain (Ports and Adapters / Hexagonal Architecture principles).
* **Observability Strategy**: Define the distributed tracing protocol across all boundaries (e.g., Client -> API Gateway -> Message Broker/Worker -> Container Logs). Require a unified structured logging format and define key performance metrics to monitor.
* **Strict API Payloads**: You MUST NOT provide vague descriptions for API endpoints. Every network interaction must include the exact JSON request/response payload with keys and data types.
* **SSE Protocol Specification**: When an asynchronous process requires real-time UI updates, you MUST define the exact Server-Sent Events (SSE) contract, outlining the precise event names (e.g., `event: progress`, `event: success`) and the payload structure of the data line.
* **Error Payload Standardization**: Every API contract MUST explicitly outline the JSON structure for Unhappy Paths (4XX/5XX responses). 
* **Runtime Schema Validation**: The architecture MUST mandate the use of runtime schema validators (e.g., Pydantic for Backend, Zod/TypeScript for Frontend) to enforce the immutability of the defined contracts during data exchange.
* **Security & CORS Enforcement**: Every API contract MUST define required HTTP Headers (e.g., Authorization). Furthermore, the architecture must explicitly define Cross-Origin Resource Sharing (CORS) policies between the local Client and API boundaries to prevent browser-level network blocks.

# Domain Discovery & Modeling template

## Ubiquitous Language (Glossary)
| Domain Term | Technical Name (Code/DB) | Definition | Allowed Synonyms |
| :--- | :--- | :--- | :--- |
| [Term] | [Exact naming rule] | [Business context] | NONE |

## Subdomain Classification
* **Core Domain Components**: [List components requiring strict sandboxing, high rigor, or heavy computation]
* **Supporting/Generic Components**: [List CRUD or peripheral components]

## Aggregates & System Invariants
* **Aggregate Root**: `[Name]`
  * **Invariants**: 
    - `INV-01`: [Logical condition]

## Behavioral Mapping & Process Management
* `[Command Name]` ──> Updates Aggregate State (e.g., PENDING) ──> Emits `[DomainEventName]`
* `[Event Handler]` ──> Executes Task ──> Updates Final State (e.g., COMPLETED / FAILED)

## Architectural Topology & Context Mapping

### Component Topology Boundaries
* **[Client/Frontend Layer]**: Sub-system boundary managing local state and client UI rendering.
* **[API/Orchestration Layer]**: Stateless backend orchestration layer (Upstream to Client / Downstream to Workers or DB).
* **[Execution/Worker Layer]**: Asynchronous execution engine for long-running or resource-intensive tasks.

### Context Mapping Matrix
| Upstream (U) | Downstream (D) | Strategy (ACL / Conformist) | Tactical Purpose & Data Contract |
| :--- | :--- | :--- | :--- |
| [Component A] | [Component B] | [Strategy] | [Explain payload structure (e.g., JSON schema) and how data is digested or isolated by the downstream component] |

### Immutable API Endpoints Contract
* **`[HTTP_METHOD] [ENDPOINT_PATH]`**
  * **Description**: [What this endpoint triggers]
  * **Required Headers**: `{"Authorization": "Bearer [Token]", "Content-Type": "application/json"}`
  * **Request Payload (JSON)**:
    ```json
    {
      "[key]": "[type] // Description"
    }
    ```
  * **Response Payload (JSON - Success 200/201 Single Item)**:
    ```json
    {
      "[key]": "[type] // Description"
    }
    ```
  * **Alternative Response Payload (JSON - Success 200/201 For Collections/Lists)**:
    ```json
    {
      "items": [
        {
          "[nested_key]": "[type] // Description of the item object structure"
        }
      ],
      "pagination": {
        "total_count": "int // Total number of available items across all pages",
        "page": "int // Current active page (1-indexed)",
        "limit": "int // Number of items returned per page",
        "total_pages": "int // Total calculated pages available"
      }
    }
    ```
  * **Error Response Payload (JSON - 4XX/5XX)**:
    ```json
    {
      "error_code": "string",
      "message": "string // Detailed description of the invariant violation or failure"
    }
    ```


### Asynchronous Real-Time Stream Contract (SSE)
* **SSE Endpoint**: `GET [STREAM_ENDPOINT_PATH]`
  * **Subscription Trigger**: [What action opens this stream]
  * **Streamed Events**:
    - `event: [event_name_1, e.g., progress]`
      ```json
      { "[key]": "[type]" }
      ```
    - `event: [event_name_2, e.g., success]`
      ```json
      { "[key]": "[type]" }
      ```
    - `event: [event_name_3, e.g., error]`
      ```json
      { "error_code": "string", "message": "string" }
      ```

### Infrastructure & Network Layout (Local Dev)
* **Network Drivers**: Bridge mode inside local compose network.
* **Port Allocation**:
  - `localhost:[PORT_1]` ──> [Component 1, e.g., API Gateway]
  - `localhost:[PORT_2]` ──> [Component 2, e.g., Relational Database]
  - `localhost:[PORT_3]` ──> [Component 3, e.g., Message Broker / KV Store]
* **Volume Mount Strategy**: Explicit host mapping from the local OS (e.g., Windows NTFS paths) into container target paths to prevent execution or file-sharing errors.

### Unhappy Paths & State Rollback
* **Scenario: [Name of failure mode, e.g., Process Interrupted / Runtime Exception]**
  * **Detection Point**: [Identify which component catches the error, e.g., Exception handler in the Worker]
  * **Rollback & Cleanup Action**: [Step-by-step technical recovery: state update in Database, queue eviction, or file purging on the host volume]

## Cross-Cutting Guards & Observability Matrix

### Runtime Validation Guardrails
* **Frontend Validation Engine**: [e.g., Zod Schemas enforcing the API Contracts]
* **Backend Validation Engine**: [e.g., Pydantic v2 BaseModels mapping Request Payloads]

### Distributed Tracing & Observability Protocol
* **Correlation ID Flow**: [e.g., Generated by Client UI -> Carried via X-Correlation-ID HTTP Header -> Injected into FastAPI Log -> Appended to Docker Worker metadata]
* **Key Performance Metrics**:
  - `Metric 1`: [What to measure, e.g., Rendering Latency in seconds]
  - `Metric 2`: [e.g., Docker Worker Container CPU/Memory spikes]

---

## DoD gate (verification)

- DoD: system-design_XX.md contains a Ubiquitous Language glossary table (BINDING for all dev agents), domains with data flows, aggregates+invariants as boolean conditions, unhappy-path error payloads. BP: contracts immutable once consumers exist; storage advisory (SQLite prototype / PostgreSQL concurrent production).
