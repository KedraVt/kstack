---
name: docker-manager
description: Build, run, orchestrate, and secure Docker containers for both the application stack and ephemeral sandbox execution. Use when any agent must write a Dockerfile, configure docker-compose services, spawn sandboxed workers, manage shared volumes, or verify container health.
version: "2.0.0"
---

<!-- provenance: kedra/docker-manager (verbatim) · ported S1 2026-02-11 -->

# Docker Manager

Container lifecycle management covering **two distinct operational domains**:

1. **Application Containerization** — Packaging frontend, backend, and infrastructure services into production-ready containers orchestrated via Docker Compose.
2. **Ephemeral Sandbox Execution** — Spawning short-lived, strictly isolated containers to execute untrusted AI-generated code safely.

Every agent in the sprint pipeline interacts with Docker at some level. This skill defines the shared rules, procedures, and safety invariants that all roles must follow.

---

## When to Use

- An agent must write or review a `Dockerfile` (frontend, backend, or worker image).
- An agent must configure `docker-compose` / `compose.local.yaml` service definitions.
- The backend must programmatically spawn, monitor, or kill ephemeral sandbox containers.
- DevSecOps must audit container security posture (non-root, network isolation, resource limits).
- QA must execute integration or E2E tests inside or against a containerized environment.
- Any agent needs to verify container health, inspect logs, or debug volume mounts.

---

## Domain A: Application Containerization

### A1. Writing Production Dockerfiles

Every service (frontend, backend) MUST have a dedicated, multi-stage Dockerfile.

**Frontend Dockerfile Pattern:**
```dockerfile
# Stage 1: Build
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --ignore-scripts
COPY . .
ARG VITE_API_URL
ARG VITE_SSE_URL
ENV VITE_API_URL=$VITE_API_URL
ENV VITE_SSE_URL=$VITE_SSE_URL
RUN npm run build

# Stage 2: Serve
FROM nginx:1.27-alpine AS production
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://localhost/ || exit 1
USER appuser
CMD ["nginx", "-g", "daemon off;"]
```

**Backend Dockerfile Pattern:**
```dockerfile
# Stage 1: Dependencies
FROM python:3.12-slim AS builder
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir --prefix=/install -r requirements.txt

# Stage 2: Production
FROM python:3.12-slim AS production
RUN groupadd -r appgroup && useradd -r -g appgroup appuser
WORKDIR /app
COPY --from=builder /install /usr/local
COPY . .
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s CMD curl -f http://localhost:8000/health || exit 1
USER appuser
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
```

**Mandatory Rules for All Dockerfiles:**
- Pin exact base image versions (e.g., `node:20-alpine`, never `node:latest`).
- Run as a non-root user in the production stage.
- Include a `HEALTHCHECK` instruction.
- Use `.dockerignore` to exclude `.git/`, `node_modules/`, `__pycache__/`, `.env`, and test directories.
- Inject environment-dependent values via `ARG`/`ENV` (never hardcode URLs or secrets).

### A2. Docker Compose Orchestration

The local development environment MUST be fully described in a `compose.local.yaml` file. Port allocation follows a deterministic strategy to prevent collisions.

**Port Allocation Convention:**
| Component         | Port Range  | Example              |
| :---              | :---        | :---                 |
| Frontend (Nginx)  | `30XX`      | `localhost:3000`     |
| Backend API       | `80XX`      | `localhost:8000`     |
| Database (PG)     | `54XX`      | `localhost:5432`     |
| Broker / KV Store | `63XX`      | `localhost:6379`     |

**Compose Template:**
```yaml
# compose.local.yaml
services:
  frontend:
    build:
      context: ./frontend
      args:
        VITE_API_URL: http://localhost:8000
        VITE_SSE_URL: http://localhost:8000/stream
    ports:
      - "3000:80"
    depends_on:
      backend:
        condition: service_healthy

  backend:
    build: ./backend
    ports:
      - "8000:8000"
    environment:
      - DATABASE_URL=postgresql://user:pass@db:5432/[project_db_name]
    volumes:
      - render_output:/app/output
      - /var/run/docker.sock:/var/run/docker.sock  # DinD: backend spawns sandbox containers
    depends_on:
      db:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8000/health"]
      interval: 10s
      timeout: 5s
      retries: 3

  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: user
      POSTGRES_PASSWORD: pass
      POSTGRES_DB: [project_db_name]
    ports:
      - "5432:5432"
    volumes:
      - pg_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U user"]
      interval: 5s
      timeout: 3s
      retries: 5

volumes:
  render_output:
  pg_data:
```

**Compose Commands:**
| Action            | Command                                           |
| :---              | :---                                               |
| Start stack       | `docker compose -f compose.local.yaml up -d --build` |
| View logs         | `docker compose -f compose.local.yaml logs -f`     |
| Stop stack        | `docker compose -f compose.local.yaml down`        |
| Full cleanup      | `docker compose -f compose.local.yaml down -v --rmi local` |

### A3. Windows Host Volume Mapping

Since the development host runs Windows, agents MUST handle path normalization:
- Docker Desktop for Windows automatically translates `C:\Users\...` paths when using WSL 2 backend.
- In `compose.local.yaml`, prefer named volumes over bind mounts for data persistence.
- For bind mounts (e.g., hot-reload in dev), use relative paths from the compose file location: `./backend:/app`.
- If using absolute paths, convert backslashes: `C:\Users\Mattia\project` → `/c/Users/Mattia/project`.

### A4. Networking & Service Discovery

Services in the same Compose network resolve by service name:
- `postgres://user:pass@db:5432/[project_db_name]` (`db` resolves to the database container)
- Expose ports to the host ONLY if needed for local debugging (`"127.0.0.1:5432:5432"`). In production, omit ports and use an internal network or reverse proxy.

### A5. Volume Strategies

- **Named volumes**: Use for persistent data (e.g., `pg_data:/var/lib/postgresql/data`).
- **Bind mounts**: Use strictly for source code hot-reload during development (`.:/app`).
- **Anonymous volumes**: Use to protect container dependencies from host overrides (e.g., `/app/node_modules`).

### A6. Container Security (Domain A)

- **Drop capabilities**: `cap_drop: [ALL]` where possible.
- **Read-only root**: Use `read_only: true` with `tmpfs: [/tmp]` where applicable.
- **Secret Management**: NEVER hardcode secrets (`ENV API_KEY=...`). Always use `.env` files (excluded from git) or Docker secrets.

### A7. .dockerignore Standard

Ensure a minimal build context by enforcing `.dockerignore`:
```text
node_modules
.git
.env
.env.*
dist
coverage
*.log
.next
.cache
docker-compose*.yml
Dockerfile*
README.md
tests/
```

---

## Domain B: Ephemeral Sandbox Execution

This section governs the **execution of untrusted, AI-generated code (e.g., Python rendering or computation scripts)** inside short-lived Docker containers. This is a **Core Domain** security boundary and its rules are non-negotiable.

### B1. Sandbox Security Invariants

These invariants are **immutable**. Any code or configuration that violates them MUST be rejected by DevSecOps:

| Invariant ID | Rule | Rationale |
| :--- | :--- | :--- |
| `SANDBOX-01` | Network access is DISABLED (`--network none`) | Prevents data exfiltration and C2 callbacks from malicious generated code. |
| `SANDBOX-02` | Filesystem is READ-ONLY (`--read-only`) except for an explicit tmpfs and the output volume mount | Prevents persistence of malware, rootkits, or unauthorized file writes. |
| `SANDBOX-03` | Runs as non-root user (UID ≥ 1000) | Limits privilege escalation even if container escape vulnerabilities exist. |
| `SANDBOX-04` | Hard resource limits are enforced (`--memory`, `--cpus`, `--pids-limit`) | Prevents fork-bombs and resource exhaustion DoS against the host. |
| `SANDBOX-05` | Container is ephemeral (`--rm`) with an absolute timeout (`--stop-timeout`) | Guarantees cleanup; prevents zombie containers from accumulating. |
| `SANDBOX-06` | No secrets, API keys, or host env vars are injected | Eliminates credential theft surface entirely. |
| `SANDBOX-07` | Capabilities are dropped (`--cap-drop=ALL`) | Minimizes kernel attack surface. |

### B2. Worker Image

The sandbox worker image MUST be purpose-built and minimal:

```dockerfile
# Dockerfile.worker
FROM python:3.12-slim

# Example: install the runtime + system dependencies (here: Manim CE for math rendering)
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      ffmpeg \
      libcairo2-dev \
      libpango1.0-dev \
      texlive-latex-base \
      texlive-fonts-recommended \
    && pip install --no-cache-dir manim==0.20.* \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Create non-root execution user
RUN groupadd -r sandbox && useradd -r -g sandbox -m renderer
USER renderer
WORKDIR /workspace

ENTRYPOINT ["manim"]
```

Build and tag: `docker build -f Dockerfile.worker -t sandbox-worker:latest .`

### B3. Sandbox Run Command

The backend service MUST use this exact pattern when spawning a sandbox container:

```bash
docker run --rm \
  --name "sandbox-${TASK_ID}" \
  --network none \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=128m \
  --memory="512m" \
  --cpus="1.0" \
  --pids-limit=64 \
  --cap-drop=ALL \
  --stop-timeout=300 \
  --user 1000:1000 \
  --volume "${HOST_OUTPUT_DIR}/${TASK_ID}:/workspace/output:rw" \
  sandbox-worker:latest \
  -ql /workspace/output/script.py -o /workspace/output/
```

**Parameter Rationale:**
| Flag | Value | Purpose |
| :--- | :--- | :--- |
| `--rm` | (auto-remove) | Prevents accumulation of dead containers. |
| `--network none` | disabled | `SANDBOX-01`: blocks all network I/O. |
| `--read-only` | enabled | `SANDBOX-02`: immutable root filesystem. |
| `--tmpfs /tmp:…` | 128 MB, noexec | Allows sandbox temp files without permanent writes or code execution from /tmp. |
| `--memory` | 512 MB | `SANDBOX-04`: hard memory ceiling. |
| `--cpus` | 1.0 | `SANDBOX-04`: limits CPU share. |
| `--pids-limit` | 64 | `SANDBOX-04`: prevents fork-bombs. |
| `--cap-drop=ALL` | all capabilities | `SANDBOX-07`: minimal kernel surface. |
| `--stop-timeout` | 300s (5 min) | `SANDBOX-05`: absolute rendering deadline. |
| `--user 1000:1000` | non-root | `SANDBOX-03`: least-privilege execution. |

### B4. Sandbox Lifecycle Management

The backend MUST implement these lifecycle operations:

1. **Spawn**: Create the sandbox container with the command from B3. Record `container_id` and `start_time` against the `task_id` in the database.
2. **Monitor**: Periodically poll `docker inspect --format='{{.State.Status}}' sandbox-${TASK_ID}` or use Docker SDK events.
3. **Timeout Kill**: If `elapsed_time > MAX_RENDER_TIMEOUT`, force-stop: `docker stop sandbox-${TASK_ID}`. Update task state to `FAILED` with reason `TIMEOUT`.
4. **Log Capture**: Before the container is removed, capture logs: `docker logs sandbox-${TASK_ID} 2>&1`. Sanitize by stripping all absolute host paths (replace with `/sandbox/`).
5. **Zombie Garbage Collection**: A scheduled background job MUST scan for any running containers matching the `sandbox-*` naming prefix that exceed the absolute timeout, and forcefully terminate them.

### B5. Log Sanitization Rules

Raw container logs MUST be sanitized before exposure to the client or storage:

```python
import re

def sanitize_log(raw_log: str) -> str:
    """Strip absolute host paths from sandbox logs."""
    # Remove Unix absolute paths
    sanitized = re.sub(r'/(?:home|workspace|app|var|tmp|usr|etc)[\w/.-]*', '/sandbox/', raw_log)
    # Remove Windows absolute paths
    sanitized = re.sub(r'[A-Z]:\\[\w\\.-]*', '/sandbox/', sanitized)
    return sanitized
```

---

## Verification Procedures

Every agent MUST use these commands to verify their container work. Results must be reported back in the agent's artifact using the Output Template below.

### Container Health
```bash
# All services running
docker compose -f compose.local.yaml ps --format "table {{.Name}}\t{{.Status}}\t{{.Ports}}"

# Individual health
docker inspect --format='{{.State.Health.Status}}' <container_name>

# Logs (last 50 lines)
docker logs --tail 50 <container_name>
```

### Build Verification
```bash
# Build must exit 0
docker build -t <image>:<tag> . && echo "BUILD OK" || echo "BUILD FAILED"

# Image size audit
docker images <image>:<tag> --format "{{.Size}}"
```

### Sandbox Verification
```bash
# Verify network isolation
docker run --rm --network none sandbox-worker:latest ping -c1 8.8.8.8  # MUST FAIL

# Verify read-only filesystem
docker run --rm --read-only sandbox-worker:latest touch /testfile  # MUST FAIL

# Verify non-root execution
docker run --rm --user 1000:1000 sandbox-worker:latest id  # uid=1000

# Verify resource limits
docker inspect --format='{{.HostConfig.Memory}}' sandbox-test  # 536870912 (512MB)
```

### Cleanup
```bash
# Stop all project containers
docker compose -f compose.local.yaml down

# Remove dangling images
docker image prune -f

# Remove orphaned volumes
docker volume prune -f

# Kill orphaned sandbox containers
docker ps -q --filter "name=sandbox-" | xargs -r docker stop
docker ps -aq --filter "name=sandbox-" | xargs -r docker rm
```

---

## Output Template: Docker Build & Security Report

Any agent generating or reviewing Docker artifacts MUST write results to `devops/devsecops/docker-build-report.md` using this exact format so the Planner can parse variables for the execution loop:

```markdown
## Docker Build & Security Report
**docker-build:** success | failed
**docker-security:** approved | rejected
**problems-docker:** [If all approved, write "none". If issues found, summarize them for the developers.]

### Build Results
| Image | Build Exit Code | Size | Healthcheck |
| :--- | :--- | :--- | :--- |
| [image:tag] | [0 or error] | [size] | [passing/failing/missing] |

### Sandbox Invariant Compliance
| Invariant | Status | Evidence |
| :--- | :--- | :--- |
| SANDBOX-01 (network=none) | ✅ / ❌ | [command output] |
| SANDBOX-02 (read-only fs) | ✅ / ❌ | [command output] |
| SANDBOX-03 (non-root) | ✅ / ❌ | [command output] |
| SANDBOX-04 (resource limits) | ✅ / ❌ | [command output] |
| SANDBOX-05 (ephemeral + timeout) | ✅ / ❌ | [command output] |
| SANDBOX-06 (no secrets injected) | ✅ / ❌ | [Dockerfile / run command audit] |
| SANDBOX-07 (cap-drop=ALL) | ✅ / ❌ | [command output] |

### Remediation (if rejected)
- **[Issue]**: [Description + exact fix command or code]
```

---

## Pitfalls

- **Never** store secrets in Dockerfiles, images, or `compose.local.yaml`. Use environment variables injected at runtime via a `.env` file excluded from version control.
- **Never** mount the Docker socket (`/var/run/docker.sock`) into the sandbox worker image. Only the backend orchestrator service is permitted to access it.
- **Never** use `--privileged` or `--cap-add` on sandbox containers.
- **Watch** for large Docker build contexts slowing builds — keep `.dockerignore` up to date.
- **Handle** signal propagation for graceful shutdown (use `exec` form CMD, not shell form).
- **Windows-specific**: Bind mounts from NTFS to Linux containers may cause permission mismatches. Prefer named volumes for persistent data; use bind mounts only for source code hot-reload during development.

## DoD gate (verification)

- DoD: conditional — applies ONLY when repo ships Dockerfile/compose; multi-stage build, pinned base images, non-root runtime, resource limits, healthchecks, no secrets in layers. BP: never introduce Docker into a project that does not use it.
