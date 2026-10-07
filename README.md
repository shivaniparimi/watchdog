# Test Gap Finder

A GitHub Action that flags functions a pull request changed when no test covers the change.

It posts one inline comment on each untested function (with a suggested test) and a summary table on the PR.

## How it works

1. **Read the diff.** Get the PR's changed files and the real line number of every changed line.
2. **Sort files.** Each changed file is a source file, a test file, or ignored (docs, config, generated code, migrations).
3. **Find changed functions.** Group changed lines by the function they're in. Changes that can't affect behavior are dropped: comments, imports, logging, blank lines.
4. **Match tests.** For each source file, find its test files by name (`cart.ts` → `cart.test.ts`, `test_cart.py`, `CartTest.java`) or by import. Go uses the package directory.
5. **Rule check.** Each function gets one of three results:
   - **covered-in-pr**: a test file changed in this PR mentions the function.
   - **untested**: no matching test mentions it at all.
   - **needs-judgment**: tests mention it but weren't updated.
6. **Claude decides** on untested and needs-judgment functions. It reads the function's diff and the relevant test excerpts, then returns structured JSON: covered or not, risk, a one-sentence reason, and a suggested test.
7. **Report.** One review with inline comments, plus a summary comment that's updated in place on later pushes. Comments already posted aren't repeated.

Supported languages: TypeScript, JavaScript, Python, Go, Java.

## Use it in a repo

```yaml
# .github/workflows/test-gap.yml
on:
  pull_request:
    types: [opened, synchronize, reopened]
permissions:
  contents: read
  pull-requests: write
jobs:
  test-gap:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: <your-github-user>/test-gap@v1
        with:
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
```

| Input | Default | Description |
|---|---|---|
| `anthropic-api-key` | (none) | Without it, only the rule checks run. |
| `model` | `claude-opus-5-5` | Claude model used to judge coverage. |
| `fail-on` | `none` | Fail the check on gaps at this risk or higher: `low`, `medium`, `high`. |
| `max-functions` | `40` | Maximum number of functions checked per PR. The most worrying ones are kept. |
| `ignore-paths` | (none) | Extra globs to skip, one per line or comma-separated. |

Output: `gaps`, the number of functions that look untested.

## Run it locally

Compare any repo's working tree with its base branch, without opening a PR:

```bash
npm install
npm run local -- --repo ../my-project --base main --no-ai   # rule checks only
ANTHROPIC_API_KEY=sk-... npm run local -- --repo ../my-project   # with Claude
npm run local -- --repo ../my-project --json                     # raw findings
```

## Develop

```bash
npm test           # unit tests (vitest)
npm run typecheck  # tsc
npm run build      # bundle to dist/index.cjs; commit dist/ so the Action can run
```

| File | Role |
|---|---|
| `src/diff.ts` | Parse patches into line-numbered entries |
| `src/classify.ts` | Source / test / ignore, plus language detection |
| `src/symbols.ts` | Find function ranges; group changed lines by function |
| `src/testMap.ts` | Match source files to test files; extract mentions |
| `src/analyze.ts` | Rule checks |
| `src/judge.ts` | Claude call with structured output |
| `src/pipeline.ts` | Puts the steps together; falls back to rule results if AI fails |
| `src/report.ts` | Inline comments, summary, pass/fail |
| `src/github.ts`, `src/index.ts` | Action entry point and GitHub API calls |
| `src/local.ts` | Local CLI |

## Known limits

- Functions are found with regexes, not a real parser. Unusual syntax can be missed: multi-line JS method signatures, or functions nested inside template strings. Tree-sitter would fix this.
- A test "mentions" a function when its name appears in the test file. Very common names like `get` can match by accident.
- Coverage reports (Istanbul, coverage.py) aren't read yet. Where a repo has them, they'd be more accurate than name matching.
