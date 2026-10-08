# 🐕 Watchdog

Watchdog is a plug-and-play GitHub pull request checker for JavaScript/TypeScript, Python, Java, C++ and SQL. It lints and auto-formats your code, scans for security problems, reviews the whole PR with AI, and finds changes that no test covers.

Unlike most AI reviewers, Watchdog **checks its claims by running your tests**. Suspected bugs are proven with a failing test, and false alarms are thrown away.

## Features

- **Multi-language linting and formatting**: ESLint, Prettier, Flake8, Black, Checkstyle, clang-tidy, SQLFluff and more, on changed files only. Fixes are committed back to the PR automatically.
- **Security scanning**: CodeQL, Bandit, pip-audit, npm audit and GitHub's dependency review.
- **AI code review of the whole PR**: the AI reads every changed file plus the code around it (callers, helpers, tests), then posts inline comments with one-click fixes and a 1–10 score.
- **Proof tests**: for each suspected bug, Watchdog writes a test and runs it. A failing test means the bug is **confirmed**; a passing one means it was a false alarm.
- **Mutation check**: Watchdog makes small deliberate breaks to changed lines (like `>` → `>=`) and runs the tests. If nothing fails, no test really checks that line.
- **Test-gap finder**: flags functions whose logic changed without a matching test.
- **Free to run**: uses Google Gemini's free tier by default, or Claude if you prefer.
- **One summary**: every check's result in a single table.
- **Two ways to run**: as a GitHub Actions workflow, or as a self-hosted **Express** server that receives GitHub webhooks.
- **Measured, not just claimed**: a **Python** benchmark of 24 planted-bug PRs scores how well Watchdog does, with a **FastAPI** dashboard for the results.

## Tech Stack

| Area                               | Tools                                                  |
| ---------------------------------- | ------------------------------------------------------ |
| Automation                         | GitHub Actions (reusable workflow), Bash               |
| Watchdog itself                    | TypeScript, Node.js, Zod, Vitest, esbuild              |
| Self-hosted server                 | Express, Docker                                        |
| Benchmark and dashboard            | Python, FastAPI, pandas, matplotlib, pytest            |
| AI                                 | Google Gemini (free tier, default) or Anthropic Claude |
| JavaScript / TypeScript            | ESLint, Prettier, `tsc`                                |
| Python                             | Flake8, Black, isort, mypy, Bandit, pip-audit          |
| Java                               | Checkstyle, google-java-format                         |
| C / C++                            | clang-tidy, clang-format                               |
| SQL                                | SQLFluff                                               |
| Security                           | CodeQL, npm audit, Dependency Review                   |
| Test runners (proofs and mutation) | Vitest, Jest, pytest                                   |

## Architecture

### 1. The pipeline

Every pull request runs through these jobs. Lint, security and dependency review run in parallel. The AI review and test-gap jobs wait for auto-fix, so their comments land on the fixed code.

```mermaid
flowchart TD
    PR[Pull request opened or updated] --> D[Detect changed languages]
    D --> L[Lint and format]
    D --> S[Security scan]
    D --> DR[Dependency review]
    L -->|auto-fix commit| L2[Fixed code]
    L2 --> AI[AI code review]
    L2 --> TG[Test gaps]
    L --> SUM[Summary table]
    S --> SUM
    DR --> SUM
    AI --> SUM
    TG --> SUM
```

### 2. AI code review

The AI gets the whole PR, then explores the repository with read-only tools before reporting anything. Each finding is checked against the diff, and suspected bugs are proven with a test.

```mermaid
flowchart LR
    A[PR title, description, commits, every changed file] --> B[AI reviews the PR]
    B <-->|read_file, search_code, list_files, get_diff| R[(Repository)]
    B --> C[Findings: severity, line, explanation, fix]
    C --> V[Check each line is in the diff]
    V --> P{Proof test}
    P -->|test fails| OK[✅ Confirmed]
    P -->|test passes| X[Dismissed as false alarm]
    P -->|can't test| U[Posted unverified]
    OK --> POST[One PR review + summary comment]
    U --> POST
```

### 3. Test gaps and the mutation check

```mermaid
flowchart LR
    F[Changed functions] --> M[Match to test files by name and import]
    M --> RC{Rule check}
    RC -->|test updated in this PR| COV[Covered]
    RC -->|no test mentions it| UN[Untested]
    RC -->|unclear| J[AI decides, searching the repo for tests]
    COV --> MU[Mutation check: break changed lines, run tests]
    J --> MU
    MU -->|a test fails| GOOD[Caught ✔]
    MU -->|all tests pass| GAP[Comment: no test checks this line]
```

### 4. Self-hosted server (Express)

The same checks can run outside GitHub Actions. GitHub sends a webhook when a PR changes; the server verifies its signature, queues a job, checks out the PR's exact commit, runs the tasks, and posts the results.

```mermaid
flowchart LR
    GH[GitHub webhook] -->|HMAC-signed| E[Express server]
    API["REST API<br/>POST /api/reviews"] --> E
    E --> Q[Job queue<br/>one at a time]
    Q --> W[Worker: check out PR commit]
    W --> T[Review and test-gap tasks]
    T -->|comments| GH2[Pull request]
```

### 5. Benchmark (Python)

```mermaid
flowchart LR
    C[24 test cases<br/>known bugs, weak tests,<br/>untested code, clean PRs] --> B[Build a git repo per case]
    B --> W[Run Watchdog]
    W --> S[Score against the answer key]
    S --> R[Report and charts<br/>pandas, matplotlib]
    R --> D[FastAPI dashboard]
```

### 6. How the code is organized

```mermaid
flowchart TD
    WF[".github/workflows/watchdog.yml<br/>reusable workflow"] --> SH["scripts/<br/>detect, lint, security, setup"]
    WF --> ACT["action.yml + dist/<br/>the Watchdog Action"]
    SH --> CFG["configs/<br/>default linter configs"]
    ACT --> T["src/tasks/<br/>review and test-gap tasks"]
    T --> RV["src/review/<br/>collect PR, validate, report"]
    T --> TGAP["src/*.ts<br/>test-gap finder"]
    T --> VER["src/verify/<br/>proof tests, mutation, test runners"]
    RV --> AIL["src/ai/<br/>Gemini and Claude providers"]
    TGAP --> AIL
    VER --> AIL
    AIL --> TOOLS["src/agent/<br/>repository tools"]
    SRV["src/server/<br/>Express server"] --> T
    BENCH["bench/<br/>Python benchmark + FastAPI"] -->|runs| ACT
```

## Quick Start

### 1. Add the workflow

Create `.github/workflows/watchdog.yml` in your repository:

```yaml
name: Watchdog
on:
  pull_request:
    types: [opened, synchronize, reopened]
permissions:
  contents: write
  pull-requests: write
  security-events: write
  actions: read
jobs:
  watchdog:
    uses: shivaniparimi/watchdog/.github/workflows/watchdog.yml@main
    secrets: inherit
```

### 2. Add a free AI key (optional)

Create a free Gemini key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey). It only needs a Google account, no credit card. Add it under **Settings → Secrets and variables → Actions** as `GEMINI_API_KEY`.

To use Claude instead, add `ANTHROPIC_API_KEY`. Without any key, everything except the AI features still runs.

### 3. Open a pull request

Watchdog runs automatically and comments on the PR.

## Configuration

Watchdog works without any configuration. If your repo has its own linter configs (`eslint.config.js`, `.prettierrc`, `.flake8`, `pyproject.toml`, `.clang-format`, `.sqlfluff`…), Watchdog uses them; otherwise it uses the defaults in [`configs/`](configs/).

Common options go under `with:` in the workflow:

| Option             | Default | What it does                                            |
| ------------------ | ------- | ------------------------------------------------------- |
| `auto-fix`         | `true`  | Commit formatting fixes back to the PR                  |
| `ai-review`        | `true`  | Run the AI code review                                  |
| `verify-findings`  | `true`  | Prove suspected bugs with a test                        |
| `mutation-testing` | `true`  | Run the mutation check                                  |
| `test-gap`         | `true`  | Run the test-gap finder                                 |
| `codeql`           | `true`  | Run CodeQL                                              |
| `ai-provider`      | `auto`  | `gemini`, `anthropic`, or `auto` (whichever key is set) |
| `min-severity`     | `minor` | Lowest AI finding severity posted as a comment          |
| `fail-on-severity` | `none`  | Fail the check on AI findings this severe               |
| `setup-command`    | auto    | How to install your project so its tests can run        |
| `ignore-paths`     | none    | Files for the AI to skip                                |

All options are listed in [`.github/workflows/watchdog.yml`](.github/workflows/watchdog.yml).

### Supported files

| Language                | Extensions                  | Format             | Lint         | Proofs and mutation |
| ----------------------- | --------------------------- | ------------------ | ------------ | ------------------- |
| JavaScript / TypeScript | `.js` `.jsx` `.ts` `.tsx`   | Prettier           | ESLint, tsc  | Vitest, Jest        |
| Python                  | `.py`                       | Black, isort       | Flake8, mypy | pytest              |
| Java                    | `.java`                     | google-java-format | Checkstyle   | —                   |
| C / C++                 | `.c` `.cpp` `.h` `.hpp`     | clang-format       | clang-tidy   | —                   |
| SQL                     | `.sql`                      | SQLFluff           | SQLFluff     | —                   |
| Styles, data, docs      | `.css` `.json` `.yml` `.md` | Prettier           | —            | —                   |

## Self-hosted server

Run Watchdog as a service instead of (or alongside) GitHub Actions:

```bash
WEBHOOK_SECRET=... GITHUB_TOKEN=... GEMINI_API_KEY=... npm run server
# or, with Docker:
npm run build && docker build -t watchdog-server . && docker run -p 3000:3000 -e WEBHOOK_SECRET=... -e GITHUB_TOKEN=... watchdog-server
```

Then add a webhook in your repository (**Settings → Webhooks**): payload URL `https://<your-server>/webhooks/github`, content type `application/json`, the same secret, and the **Pull requests** event.

| Endpoint                             | What it does                                                 |
| ------------------------------------ | ------------------------------------------------------------ |
| `POST /webhooks/github`              | Receives PR events (signature checked), queues a review      |
| `POST /api/reviews`                  | Starts a review on demand: `{"owner", "repo", "pullNumber"}` |
| `GET /api/jobs`, `GET /api/jobs/:id` | Job status and results                                       |
| `GET /health`                        | Health check with job counts                                 |

| Variable                               | Required | What it does                                                                                                 |
| -------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------ |
| `WEBHOOK_SECRET`                       | yes      | Secret shared with the GitHub webhook                                                                        |
| `GITHUB_TOKEN`                         | yes      | Token that can read the repo and comment on PRs                                                              |
| `GEMINI_API_KEY` / `ANTHROPIC_API_KEY` | no       | Turns on the AI steps                                                                                        |
| `WATCHDOG_API_KEY`                     | no       | Turns on the `/api` routes (sent as a Bearer token)                                                          |
| `WATCHDOG_TASKS`                       | no       | `review,test-gap` (default) or one of them                                                                   |
| `RUN_TESTS`                            | no       | `true` runs proof tests and the mutation check. Off by default, because it runs the PR's code on your server |

## Benchmark

To check that Watchdog actually works, [`bench/`](bench/) holds 24 small pull requests (12 TypeScript, 12 Python) with an answer key: 13 planted bugs, 5 lines with weak tests, 4 untested functions, and clean refactors that should raise nothing. A Python runner builds a git repo for each case, runs Watchdog, and scores the output.

Results of the free checks (no AI), from [`bench/results/no-ai`](bench/results/no-ai/report.md):

| Metric                                             | Result     |
| -------------------------------------------------- | ---------- |
| Lines with weak tests caught by the mutation check | **5 / 5**  |
| Untested functions flagged                         | **4 / 4**  |
| Well-tested functions wrongly flagged              | **0 / 15** |
| Mutation false alarms                              | **0**      |
| Planted bugs in code the free checks flagged       | 4 / 13     |

The last row is why the AI review exists: most logic bugs sit in code that _is_ tested, just not for the bug. Running the benchmark with `--ai` scores the AI review and proof tests too (bugs found, false positives before and after proof tests).

![Benchmark results](bench/results/no-ai/summary.png)

```bash
cd bench && pip install -r requirements.txt
python -m watchdog_bench run              # free checks, about 30 seconds
GEMINI_API_KEY=... python -m watchdog_bench run --ai   # also the AI review and proof tests
python -m watchdog_bench serve            # FastAPI dashboard at http://127.0.0.1:8000
```

## Project Structure

```
watchdog/
├── .github/workflows/
│   ├── watchdog.yml        # The pipeline other repos use
│   └── ci.yml              # Watchdog's own tests
├── action.yml              # The Watchdog Action (AI review and test gaps)
├── dist/index.cjs          # Built Action (generated by npm run build)
├── scripts/
│   ├── detect.sh           # Sort changed files by language
│   ├── lint.sh             # Run linters and formatters (check or fix)
│   ├── security.sh         # npm audit, pip-audit, Bandit
│   ├── setup-project.sh    # Install a repo's dependencies to run its tests
│   └── install-hook.sh     # Optional pre-commit hook
├── configs/                # Default linter configs
├── Dockerfile              # Container for the self-hosted server
├── bench/                  # Python benchmark: cases, runner, scoring, FastAPI dashboard
├── src/
│   ├── server/             # Express server: webhooks, REST API, job queue
│   ├── ai/                 # Gemini and Claude providers
│   ├── agent/              # Read-only repository tools for the AI
│   ├── review/             # AI code review
│   ├── verify/             # Proof tests, mutation check, test runners
│   ├── tasks/              # Review and test-gap tasks (shared by the Action and the server)
│   ├── *.ts                # Test-gap finder
│   └── local.ts            # Run Watchdog locally
└── test/                   # Unit tests
```

## Run it locally

```bash
git clone https://github.com/shivaniparimi/watchdog && cd watchdog && npm install

# AI review of another repo's changes vs. main (prints results, posts nothing)
GEMINI_API_KEY=... npm run local -- --task review --repo ../my-project --verify

# Test gaps and the mutation check (no AI needed)
npm run local -- --task test-gap --repo ../my-project --no-ai --mutate

# Pre-commit hook that auto-formats staged files
scripts/install-hook.sh ../my-project
```

To work on Watchdog itself: `npm test`, `npm run typecheck`, `npm run build` (commit `dist/` afterward), and `python -m pytest bench/tests` for the benchmark.

## Good to know

- **Free tier limits**: Gemini's free tier allows about 20 requests per model per day, and one run can use 10–20. Watchdog switches to another free model when one runs out, and posts a note instead of failing if all are used up. Use a key just for Watchdog.
- **Privacy**: on the free tier, [Google may use what you send to improve its products](https://ai.google.dev/gemini-api/terms). For private code, use a paid key or Claude.
- **Safety**: tests run with all tokens and keys removed from their environment, and proof tests are deleted after running. Fork PRs never get your secrets.
- **Fork PRs** are checked but not auto-fixed, since GitHub doesn't allow pushing to forks.
- **Auto-fix commits** made with the default token need someone to approve the next run. Add a `WATCHDOG_PUSH_TOKEN` secret to skip that.
- **Dependency review** needs the dependency graph turned on (Settings → Code security).
