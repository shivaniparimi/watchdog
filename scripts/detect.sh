#!/usr/bin/env bash
# Sort the files a PR changed into per-language lists.
#
#   detect.sh <base-ref> <head-ref> <out-dir>
#
#   detect.sh --staged "" <out-dir>     (files staged for commit, for the pre-commit hook)
#
# Writes <out-dir>/{prettier,eslint,python,java,cpp,sql,all}.txt (one path per line) and, when
# running in GitHub Actions, outputs has-<lang>=true|false and codeql-languages=<comma list>.
set -euo pipefail

base=$1 head=$2 out=$3
mkdir -p "$out"

# Added, copied, modified or renamed files only; deleted files have nothing to lint.
if [ "$base" = --staged ]; then range=(--cached); else range=("$base...$head"); fi
git diff --name-only --diff-filter=ACMR "${range[@]}" \
  | grep -Ev '(^|/)(node_modules|vendor|dist|build|out|coverage|\.watchdog|\.venv|venv|__pycache__)/' \
  | grep -Ev '\.min\.(js|css)$|(^|/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock)$' \
  > "$out/all.txt" || true

pick() { grep -Ei "$1" "$out/all.txt" > "$out/$2.txt" || true; }
pick '\.(js|jsx|mjs|cjs|ts|tsx|mts|cts|json|jsonc|css|scss|less|html|vue|md|mdx|ya?ml|graphql)$' prettier
pick '\.(js|jsx|mjs|cjs|ts|tsx|mts|cts)$' eslint
pick '\.pyi?$' python
pick '\.java$' java
pick '\.(c|cc|cpp|cxx|h|hh|hpp|hxx)$' cpp
pick '\.sql$' sql

has() { [ -s "$out/$1.txt" ] && echo true || echo false; }

codeql=()
[ "$(has eslint)" = true ] && codeql+=(javascript-typescript)
[ "$(has python)" = true ] && codeql+=(python)
[ "$(has java)" = true ] && codeql+=(java-kotlin)
[ "$(has cpp)" = true ] && codeql+=(c-cpp)
codeql_list=$(IFS=,; echo "${codeql[*]-}")

summary="js=$(has prettier) python=$(has python) java=$(has java) cpp=$(has cpp) sql=$(has sql)"
echo "Changed files: $(wc -l < "$out/all.txt" | tr -d ' ') ($summary)"

if [ -n "${GITHUB_OUTPUT:-}" ]; then
  {
    echo "has-js=$(has prettier)"
    echo "has-python=$(has python)"
    echo "has-java=$(has java)"
    echo "has-cpp=$(has cpp)"
    echo "has-sql=$(has sql)"
    echo "has-any=$([ -s "$out/all.txt" ] && echo true || echo false)"
    echo "codeql-languages=$codeql_list"
  } >> "$GITHUB_OUTPUT"
fi
