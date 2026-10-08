# Test Framework Bootstrap

Read this when a fix-mode run needs regression tests but no test framework
exists in the repo. Bootstrapping is a side-quest: get a minimal framework
running, prove it, commit it, return to QA.

## 1. Detect

```bash
# Runtime
[ -f Gemfile ] && echo "RUNTIME:ruby"
[ -f package.json ] && echo "RUNTIME:node"
[ -f requirements.txt ] || [ -f pyproject.toml ] && echo "RUNTIME:python"
[ -f go.mod ] && echo "RUNTIME:go"
[ -f Cargo.toml ] && echo "RUNTIME:rust"
[ -f composer.json ] && echo "RUNTIME:php"
# Existing test infra — if found, skip bootstrap entirely
ls jest.config.* vitest.config.* playwright.config.* .rspec pytest.ini phpunit.xml 2>/dev/null
ls -d test/ tests/ spec/ __tests__/ cypress/ e2e/ 2>/dev/null
# Opt-out marker
[ -f .kstack/no-test-bootstrap ] && echo "BOOTSTRAP_DECLINED"
```

- Framework detected → read 2–3 existing test files to learn conventions
  (naming, imports, assertion style). Skip the rest.
- `BOOTSTRAP_DECLINED` → skip, continue without tests.
- No runtime detected → `ask_user_question` which runtime, or "no tests needed"
  → write `.kstack/no-test-bootstrap` and continue.

## 2. Propose (via `ask_user_question`)

| Runtime | Primary | Alternative |
|---------|---------|-------------|
| Ruby/Rails | minitest + fixtures + capybara | rspec + factory_bot |
| Node.js | vitest + @testing-library | jest + @testing-library |
| Next.js | vitest + @testing-library/react + playwright | jest + cypress |
| Python | pytest + pytest-cov | unittest |
| Go | stdlib testing + testify | stdlib only |
| Rust | cargo test + mockall | — |
| PHP | phpunit + mockery | pest |
| Elixir | ExUnit + ex_machina | — |

A) Primary (recommend, with rationale) B) Alternative C) Skip → write
`.kstack/no-test-bootstrap`. Monorepo → ask which runtime first.

## 3. Install & verify

Install packages, minimal config, test dir, ONE example test proving setup.
Run the suite — fails → debug once → still failing → revert and continue
without tests. Never import secrets/credentials in test files.

## 4. First real tests (1–5)

- `git log --since=30.days --name-only --format="" | sort | uniq -c | sort -rn | head -10`
- Prioritize risk: error handlers > business logic > API endpoints > pure functions.
- Each test asserts real behavior — never `expect(x).toBeDefined()`.
- Pass → keep. Fail → fix once. Still fails → delete silently.

## 5. CI + docs + commit

- `.github/` exists → create `.github/workflows/test.yml` (setup action +
  verified test command, on push+PR). Other CI → note and skip.
- Write `TESTING.md` (framework, run command, test layers, conventions) —
  update, never overwrite, if it exists.
- Append a `## Testing` section to `AGENTS.md`/`CLAUDE.md` if absent
  (run command + "when fixing a bug, write a regression test").
- `git commit -m "chore: bootstrap test framework ({name})"` — only if changes.
