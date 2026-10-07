# 🐕 Watchdog

Automated pull request checks for JavaScript/TypeScript, Python, Java, C/C++ and SQL. On every PR, Watchdog:

- **Lints and formats** the changed files, commits safe fixes back to the PR branch, and annotates the problems that remain.
- **Scans for security problems** with CodeQL, npm audit, pip-audit, Bandit and GitHub's dependency review.
- **Reviews the code with AI** (Google Gemini's free tier by default, or Claude), posting inline comments on real issues (with one-click suggested fixes) and a summary with a 1–10 score.
- **Finds test gaps**: functions whose logic changed but no test covers the change.
- **Checks instead of guessing.** Suspected bugs are proven with a test Watchdog writes and runs, false alarms are dropped, and changed lines are deliberately broken to see whether the tests notice.
- **Summarizes** every check in one table.

Adding it to a repository takes one small workflow file. Repos without their own linter configs get sensible defaults.

## Add it to a repository

1. Create `.github/workflows/watchdog.yml`:

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

2. Turn on the AI review and AI test-gap checks with a **free** Gemini API key: create one at [aistudio.google.com/apikey](https://aistudio.google.com/apikey) (Google account, no credit card) and add it as a `GEMINI_API_KEY` secret (Settings → Secrets and variables → Actions). To use Claude instead, add an `ANTHROPIC_API_KEY` secret. Without any key, everything else still runs.

3. Open a pull request.

### Options

Pass these under `with:` in the workflow above.

| Input               | Default            | What it does                                                                                    |
| ------------------- | ------------------ | ----------------------------------------------------------------------------------------------- |
| `auto-fix`          | `true`             | Commit formatter and safe lint fixes back to the PR branch (same-repo PRs only).                |
| `fail-on-lint`      | `true`             | Fail when lint or formatting problems remain after auto-fix.                                    |
| `ai-review`         | `true`             | Run the AI code review.                                                                         |
| `test-gap`          | `true`             | Run the test-gap finder.                                                                        |
| `codeql`            | `true`             | Run CodeQL for the languages that changed.                                                      |
| `dependency-review` | `true`             | Fail on newly added dependencies with high-severity vulnerabilities.                            |
| `ai-provider`       | `auto`             | `auto` (Gemini if `GEMINI_API_KEY` is set, else Claude), `gemini`, or `anthropic`.              |
| `model`             | (provider default) | Model override. Defaults: `gemini-3.8-flash` (free tier) or `claude-opus-5-5`.                  |
| `min-severity`      | `minor`            | Lowest AI finding severity posted inline: `critical`, `major`, `minor`, `nit`, or `none`.       |
| `max-comments`      | `15`               | Maximum AI inline comments per run. The most severe are kept.                                   |
| `fail-on-severity`  | `none`             | Fail the AI review on findings at this severity or worse.                                       |
| `test-gap-fail-on`  | `none`             | Fail the test-gap check on gaps at this risk or higher: `low`, `medium`, `high`.                |
| `verify-findings`   | `true`             | Prove suspected bugs with a test (needs an AI key and a supported test runner).                 |
| `mutation-testing`  | `true`             | Run the mutation check on changed lines.                                                        |
| `max-mutants`       | `30`               | Maximum deliberate breaks per PR.                                                               |
| `setup-command`     | (auto)             | Command that installs the project's dependencies for test runs, e.g. `npm ci && npm run build`. |
| `ignore-paths`      | (none)             | Globs the AI review and test-gap finder skip.                                                   |
| `watchdog-ref`      | `main`             | Pin Watchdog to a tag or commit.                                                                |

Optional secret: `WATCHDOG_PUSH_TOKEN`, a fine-grained token with contents write access. With GitHub's default token, the run started by the auto-fix commit waits for someone to approve it under the Actions tab. Commits pushed with this token start their runs normally.

## What each check does

### Lint and format

Only the files the PR changed are checked. If the repository has its own config for a tool, Watchdog uses it; otherwise it uses the defaults in [`configs/`](configs/).

| Language                                 | Formatting (auto-fixed) | Linting                                                  |
| ---------------------------------------- | ----------------------- | -------------------------------------------------------- |
| JS / TS (also JSON, CSS, YAML, Markdown) | Prettier                | ESLint (+ `tsc --noEmit` when there's a `tsconfig.json`) |
| Python                                   | Black, isort            | Flake8, mypy (advisory)                                  |
| Java                                     | google-java-format      | Checkstyle (Google style)                                |
| C / C++                                  | clang-format            | clang-tidy (advisory without `compile_commands.json`)    |
| SQL                                      | SQLFluff                | SQLFluff                                                 |

Problems appear as annotations on the PR's changed lines, and the job summary lists each tool's result. The AI review and test-gap jobs wait for auto-fix and comment on the fixed commit, so their comments don't go stale. With `auto-fix` on, formatting fixes and safe lint fixes are committed to the PR branch as `github-actions[bot]`. Fork PRs are checked but not auto-fixed, since GitHub doesn't allow pushing to forks.

### Security

- **CodeQL** for each changed language (no build needed). Alerts appear in the Security tab and on the PR.
- **npm audit**: high or critical advisories in production dependencies (`package-lock.json`).
- **pip-audit**: known vulnerabilities in `requirements*.txt`.
- **Bandit** on changed Python files. High-severity issues fail the job; medium ones are reported.
- **Dependency review**: blocks newly added dependencies with high-severity vulnerabilities.

### AI code review

The AI reviews the **whole pull request in the context of the repository**, not just the changed lines:

- **The whole PR goes in:** title, description, every commit message, and every changed file (code, docs and config) with its diff and full new content. Lockfiles, binaries and deleted files are listed by name. Files too large for the prompt budget are still reviewed through a `get_diff` tool.
- **It reads the code around the change.** The model has read-only tools for the PR's checkout (`read_file`, `search_code`, `list_files`). It uses them to find every caller of a changed function, read the types and helpers the change depends on, and check related tests and configs. So it can catch a change that breaks code in a file the PR didn't touch.
- **Structured findings:** each has a severity, category, exact line, explanation, and optionally a replacement that GitHub shows as a one-click **suggested change**.

Then:

- Every finding's line is checked against the diff before posting. Findings on lines outside the diff are listed in the summary, not dropped.
- All inline comments are posted together as one review. The summary comment (score, verdict, findings table, strengths, risks, how much surrounding code was read) is updated in place on each push.
- A problem already commented on in an earlier run (same file and category, within 3 lines) isn't posted again.
- The PR text, code and docs are treated as untrusted data in the prompt, and the tools can't leave the repository folder or read `.git`.

### Test gaps

For each function the PR changed, Watchdog finds its test files (by name and by import), then checks whether a test covers the change:

1. **Rule checks** (free): a test changed in this PR mentions the function → covered. No test mentions it → untested. Tests exist but weren't updated → unclear.
2. **The AI** decides the unclear and untested cases. It searches the whole repository for tests the rule check missed (for example, a function tested through its caller), rates the risk, and suggests a test in the repository's own style.

Untested functions get an inline comment, and a summary table lists every changed function.

## Proof, not guesses

Most AI reviewers only read code, so every comment is an opinion. Watchdog runs your tests to check its claims. Both checks support **Vitest, Jest and pytest**, and install the project's dependencies first (override with `setup-command`).

### Proven findings

For each suspected bug (category bug, security, error handling or concurrency), the AI writes one test that asserts the correct behavior, and Watchdog runs it against the PR's code:

| Result                 | What happens                                                                                         |
| ---------------------- | ---------------------------------------------------------------------------------------------------- |
| The test **fails**     | The finding is posted as **✅ Confirmed by a failing test**, with the test and its output attached.  |
| The test **passes**    | The suspected bug isn't there. The finding is dropped as a false alarm and listed under "dismissed". |
| The test **can't run** | The AI sees the error and gets one more try. If that fails too, the finding is posted unverified.    |

When a finding includes a suggested fix, Watchdog also applies the fix, runs the proof test and the file's existing tests, and marks it **🔧 Suggested fix verified** if they pass. Proof tests are temporary: they're deleted after running and never committed.

### Mutation check on changed lines

Coverage tools tell you a line _ran_ during the tests, not that any test _checked_ it. For each line the PR adds, Watchdog makes small deliberate breaks (`>` → `<=`, `&&` → `||`, `==` → `!=`, `true` → `false`, `+` → `-`) and runs that file's tests:

- A test fails: the change was **caught**, good.
- Every test still passes: nothing checks that line. Watchdog comments on it, showing the change that went unnoticed, and flags the function as a test gap even if a test mentions it.

The summary shows how many breaks were caught. This check needs no AI, so it's free and runs on every PR, including fork PRs. It's capped by `max-mutants` and a time budget, and every file is restored after each run.

### Safety

Proof tests are AI-written code, and both checks run the PR's own code. Test processes get an environment with every token, API key and Action input removed. GitHub doesn't give secrets to workflows on fork PRs, so the AI-written proof tests only run on PRs from branches in your own repository.

## Run it locally

```bash
git clone https://github.com/shivaniparimi/watchdog && cd watchdog && npm install

# Lint/format changed files in another repo (needs the linters installed locally)
cd ../my-project
../watchdog/scripts/detect.sh main HEAD /tmp/wd-files
FILES_DIR=/tmp/wd-files ../watchdog/scripts/lint.sh check python   # or js, java, cpp, sql
FILES_DIR=/tmp/wd-files ../watchdog/scripts/lint.sh fix python

# AI review or test gaps for your working tree vs. main (prints results, posts nothing)
cd ../watchdog
GEMINI_API_KEY=... npm run local -- --task review --repo ../my-project      # or ANTHROPIC_API_KEY=...
GEMINI_API_KEY=... npm run local -- --task test-gap --repo ../my-project
npm run local -- --task test-gap --repo ../my-project --no-ai          # rule checks only
npm run local -- --task test-gap --repo ../my-project --no-ai --mutate # + mutation check (free)
GEMINI_API_KEY=... npm run local -- --task review --repo ../my-project --verify   # + proof tests

# Pre-commit hook: auto-fix staged files, block the commit if problems remain
scripts/install-hook.sh ../my-project
```

## How it's built

```
.github/workflows/watchdog.yml   Reusable workflow: detect → lint / security / dependency review / AI review / test gaps → summary
.github/workflows/ci.yml         Watchdog's own CI (unit tests + Watchdog on its own PRs)
action.yml, dist/index.cjs       The Action that runs the AI tasks (task: review | test-gap)
scripts/detect.sh                Sorts changed files by language
scripts/lint.sh                  Runs each language's linters and formatters (check or fix)
scripts/security.sh              npm audit, pip-audit, Bandit
scripts/install-hook.sh          Installs the pre-commit hook
configs/                         Default linter configs and the annotation problem matcher
src/verify/                      Test runners, proof tests and the mutation check
src/agent/                       Repository tools (read, search, list, diff) and the exploration loop
src/ai/                          AI providers: Gemini (OpenAI-compatible API, free tier) and Claude
src/review/                      AI code review: collect the PR, run the model, validate findings, report
src/*.ts                         Test-gap finder: diff parsing, function detection, test matching, AI judge
src/tasks/, src/index.ts         Action entry point
src/local.ts                     Local CLI
```

### Develop

```bash
npm test           # unit tests (vitest)
npm run typecheck  # tsc
npm run build      # bundle to dist/index.cjs; commit dist/ so the Action can run
```

## Known limits

- **Gemini's free tier** has tight rate limits that Google changes often; Watchdog uses smaller prompts and fewer exploration rounds on it, and retries when throttled. On the free tier, [Google may use what you send to improve its products and humans may review it](https://ai.google.dev/gemini-api/terms), so use a paid key or Claude for private code you don't want shared.
- With Claude, the AI checks cost money per PR. Larger PRs and more exploration cost more; `max-iterations`, `ignore-paths` and the prompt budget keep this bounded.
- Proof tests and the mutation check need the project's tests to run in CI: Vitest, Jest or pytest, with dependencies that install with `npm ci`, `pip install -r requirements.txt` or `pip install -e .` (or a custom `setup-command`). Other runners are skipped.
- The mutation check only tries simple operator changes on added lines, so a high score isn't proof that tests are thorough; a surviving change is a strong sign they aren't.
- Function detection for the test-gap finder uses patterns, not a full parser, so unusual syntax can be missed.
- clang-tidy is advisory unless the repo provides `compile_commands.json`, because it can't know the real compiler flags otherwise.
- CodeQL results upload only for same-repo PRs. Private repositories need GitHub Advanced Security for CodeQL and dependency review.
- With the default token, the run started by an auto-fix commit waits for manual approval (see `WATCHDOG_PUSH_TOKEN`).
- Dependency review needs the repository's dependency graph turned on (Settings → Code security). Without it, the check is skipped with a warning.
