#!/usr/bin/env bash
# Lint or auto-fix the changed files of one language.
#
#   lint.sh <check|fix> <js|python|java|cpp|sql>
#
# Environment:
#   FILES_DIR    per-language file lists written by detect.sh (required)
#   RESULTS_DIR  where check results go: summary.tsv plus one <tool>.log per tool (default: ./watchdog-results)
#   WATCHDOG_DIR Watchdog checkout, for default configs and tools (default: this script's parent dir)
#   TOOLS_DIR    downloaded Java jars (default: $RUNNER_TEMP/watchdog-tools or /tmp/watchdog-tools)
#
# The repository's own config is used when it has one; otherwise Watchdog's defaults in configs/.
# In check mode each tool's result is recorded as pass, fail, warn (non-blocking) or skip.
# Exit status is 0 unless a blocking check failed.
# No `set -u`: bash 3.2 (macOS) treats empty arrays as unset.
set -o pipefail

mode=$1 lang=$2
WATCHDOG_DIR=${WATCHDOG_DIR:-$(cd "$(dirname "$0")/.." && pwd)}
export RESULTS_DIR=${RESULTS_DIR:-$PWD/watchdog-results}
TOOLS_DIR=${TOOLS_DIR:-${RUNNER_TEMP:-/tmp}/watchdog-tools}
CONFIGS=$WATCHDOG_DIR/configs
mkdir -p "$RESULTS_DIR"
failed=0

files_for() {
  local list=$FILES_DIR/$1.txt
  [ -s "$list" ] || return 0
  # Only files that still exist (a fix step may have run, but files are never deleted by it).
  while IFS= read -r f; do [ -f "$f" ] && printf '%s\n' "$f"; done < "$list"
}

# record <tool> <pass|fail|warn|skip> [note]
record() {
  [ "$mode" = check ] || return 0
  printf '%s\t%s\t%s\t%s\n' "$lang" "$1" "$2" "${3:-}" >> "$RESULTS_DIR/summary.tsv"
  [ "$2" = fail ] && failed=1
  return 0
}

# run <tool> <blocking|advisory> <command...>: runs the command, logs output, records the result.
run() {
  local tool=$1 kind=$2
  shift 2
  echo "::group::$lang · $tool ($mode)"
  local log=$RESULTS_DIR/$tool.log
  "$@" > "$log" 2>&1
  local code=$?
  cat "$log"
  echo "::endgroup::"
  if [ "$mode" = fix ]; then return 0; fi
  if [ $code -eq 0 ]; then
    record "$tool" pass
  elif [ "$kind" = advisory ]; then
    record "$tool" warn "exit $code"
  else
    record "$tool" fail "exit $code"
  fi
}

skip() { echo "$lang · $1: skipped ($2)"; record "$1" skip "$2"; }

has_any() { for f in "$@"; do [ -e "$f" ] && return 0; done; return 1; }

bin_for() {
  # Prefer the repository's own install of a tool, then Watchdog's, then the PATH.
  local name=$1
  if [ -x "node_modules/.bin/$name" ]; then echo "node_modules/.bin/$name"
  elif [ -x "$WATCHDOG_DIR/node_modules/.bin/$name" ]; then echo "$WATCHDOG_DIR/node_modules/.bin/$name"
  else command -v "$name" || true
  fi
}

lint_js() {
  pfiles=(); while IFS= read -r _l; do pfiles+=("$_l"); done < <(files_for prettier)
  efiles=(); while IFS= read -r _l; do efiles+=("$_l"); done < <(files_for eslint)

  if [ ${#pfiles[@]} -gt 0 ]; then
    local prettier
    prettier=$(bin_for prettier)
    local pconf=()
    if ! has_any .prettierrc .prettierrc.json .prettierrc.yaml .prettierrc.yml .prettierrc.js .prettierrc.cjs \
      .prettierrc.mjs .prettierrc.toml prettier.config.js prettier.config.cjs prettier.config.mjs \
      && ! node -e 'process.exit(require("./package.json").prettier ? 0 : 1)' 2> /dev/null; then
      pconf=(--config "$CONFIGS/.prettierrc.json")
    fi
    if [ -z "$prettier" ]; then skip prettier "prettier not installed"
    elif [ "$mode" = fix ]; then run prettier blocking "$prettier" "${pconf[@]}" --write --ignore-unknown "${pfiles[@]}"
    else run prettier blocking "$prettier" "${pconf[@]}" --check --ignore-unknown "${pfiles[@]}"
    fi
  fi

  if [ ${#efiles[@]} -gt 0 ]; then
    local eslint econf=()
    if has_any eslint.config.js eslint.config.mjs eslint.config.cjs eslint.config.ts eslint.config.mts \
      eslint.config.cts; then
      # The repository's config needs its own plugins, so it must use its own installed ESLint.
      if [ -x node_modules/.bin/eslint ]; then eslint=node_modules/.bin/eslint
      else skip eslint "repo has an ESLint config but ESLint isn't installed (run npm ci)"; eslint=""
      fi
    elif has_any .eslintrc .eslintrc.js .eslintrc.cjs .eslintrc.json .eslintrc.yml .eslintrc.yaml; then
      skip eslint "legacy .eslintrc configs aren't supported by ESLint 9+; migrate to eslint.config.js"
      eslint=""
    else
      eslint=$WATCHDOG_DIR/node_modules/.bin/eslint
      econf=(--config "$CONFIGS/eslint.config.js")
    fi

    if [ -n "$eslint" ]; then
      if [ "$mode" = fix ]; then
        run eslint blocking "$eslint" "${econf[@]}" --no-warn-ignored --fix "${efiles[@]}"
      else
        # JSON output, reshaped into "file:line:col: severity: message [rule]" lines for annotations.
        run eslint blocking bash -c '
          "$0" "$@" --no-warn-ignored -f json > "$RESULTS_DIR/eslint.json"; code=$?
          node -e "
            const results = JSON.parse(require(\"fs\").readFileSync(process.argv[1], \"utf8\"));
            const cwd = process.cwd() + \"/\";
            for (const r of results) for (const m of r.messages)
              console.log(\`\${r.filePath.replace(cwd, \"\")}:\${m.line ?? 1}:\${m.column ?? 1}: \${m.severity === 2 ? \"error\" : \"warning\"}: \${m.message} [\${m.ruleId ?? \"eslint\"}]\`);
          " "$RESULTS_DIR/eslint.json"
          exit $code' "$eslint" "${econf[@]}" "${efiles[@]}"
      fi
    fi

    # Type-check the whole project when it has a tsconfig and TypeScript files changed.
    if [ "$mode" = check ] && [ -f tsconfig.json ] && printf '%s\n' "${efiles[@]}" | grep -qE '\.(ts|tsx|mts|cts)$'; then
      if [ -x node_modules/.bin/tsc ]; then run tsc blocking node_modules/.bin/tsc --noEmit --pretty false -p tsconfig.json
      else skip tsc "TypeScript isn't installed in the repo"
      fi
    fi
  fi
}

lint_python() {
  files=(); while IFS= read -r _l; do files+=("$_l"); done < <(files_for python)
  [ ${#files[@]} -gt 0 ] || return 0

  local fconf=() bconf=() iconf=()
  if ! has_any .flake8 && ! grep -qs '^\[flake8\]' setup.cfg tox.ini; then fconf=(--config "$CONFIGS/.flake8"); fi
  if ! grep -qs '^\[tool\.black\]' pyproject.toml; then bconf=(--config "$CONFIGS/pyproject.toml"); fi
  if ! has_any .isort.cfg && ! grep -qs '^\[tool\.isort\]' pyproject.toml && ! grep -qs '^\[isort\]' setup.cfg tox.ini; then
    iconf=(--settings-file "$CONFIGS/pyproject.toml")
  fi

  if [ "$mode" = fix ]; then
    command -v isort > /dev/null && run isort blocking isort "${iconf[@]}" -q "${files[@]}"
    command -v black > /dev/null && run black blocking black "${bconf[@]}" -q "${files[@]}"
    return 0
  fi

  if command -v black > /dev/null; then run black blocking black "${bconf[@]}" --check --diff -q "${files[@]}"
  else skip black "black not installed"; fi
  if command -v isort > /dev/null; then run isort blocking isort "${iconf[@]}" --check-only --diff "${files[@]}"
  else skip isort "isort not installed"; fi
  if command -v flake8 > /dev/null; then run flake8 blocking flake8 "${fconf[@]}" "${files[@]}"
  else skip flake8 "flake8 not installed"; fi
  # Type errors are reported but don't block, since most projects aren't fully typed.
  if command -v mypy > /dev/null; then
    run mypy advisory mypy --ignore-missing-imports --follow-imports=silent --show-column-numbers --no-error-summary "${files[@]}"
  fi
}

lint_java() {
  files=(); while IFS= read -r _l; do files+=("$_l"); done < <(files_for java)
  [ ${#files[@]} -gt 0 ] || return 0
  command -v java > /dev/null || { skip google-java-format "java not installed"; return 0; }

  local gjf=$TOOLS_DIR/google-java-format.jar checkstyle=$TOOLS_DIR/checkstyle.jar
  # google-java-format needs access to javac internals on JDK 16+.
  local gjf_cmd=(java --add-exports=jdk.compiler/com.sun.tools.javac.api=ALL-UNNAMED
    --add-exports=jdk.compiler/com.sun.tools.javac.code=ALL-UNNAMED
    --add-exports=jdk.compiler/com.sun.tools.javac.file=ALL-UNNAMED
    --add-exports=jdk.compiler/com.sun.tools.javac.parser=ALL-UNNAMED
    --add-exports=jdk.compiler/com.sun.tools.javac.tree=ALL-UNNAMED
    --add-exports=jdk.compiler/com.sun.tools.javac.util=ALL-UNNAMED
    -jar "$gjf")

  # `java -version` prints e.g. `openjdk version "21.0.2"` or `"1.8.0_392"`; take the major version.
  local java_major
  java_major=$(java -version 2>&1 | sed -nE '1s/.*version "(1\.)?([0-9]+).*/\2/p')
  if [ ! -f "$gjf" ]; then skip google-java-format "jar not found in $TOOLS_DIR"
  elif [ "${java_major:-0}" -lt 17 ]; then skip google-java-format "needs Java 17+ (found $java_major)"
  elif [ "$mode" = fix ]; then run google-java-format blocking "${gjf_cmd[@]}" --replace "${files[@]}"
  else run google-java-format blocking "${gjf_cmd[@]}" --dry-run --set-exit-if-changed "${files[@]}"
  fi

  if [ "$mode" = check ]; then
    if [ ! -f "$checkstyle" ]; then skip checkstyle "jar not found in $TOOLS_DIR"
    else
      local config=/google_checks.xml
      [ -f checkstyle.xml ] && config=checkstyle.xml
      run checkstyle blocking java -jar "$checkstyle" -c "$config" "${files[@]}"
      # Checkstyle exits 0 when it only finds warnings (Google style reports everything as warnings).
      if grep -q '^\[WARN\]' "$RESULTS_DIR/checkstyle.log" && tail -n1 "$RESULTS_DIR/summary.tsv" | grep -q $'checkstyle\tpass'; then
        sed -i.bak '$ d' "$RESULTS_DIR/summary.tsv" && rm -f "$RESULTS_DIR/summary.tsv.bak"
        record checkstyle warn "$(grep -c '^\[WARN\]' "$RESULTS_DIR/checkstyle.log") warnings"
      fi
    fi
  fi
}

lint_cpp() {
  files=(); while IFS= read -r _l; do files+=("$_l"); done < <(files_for cpp)
  [ ${#files[@]} -gt 0 ] || return 0

  local style="--style=file:$CONFIGS/.clang-format"
  [ -f .clang-format ] || [ -f _clang-format ] && style=--style=file
  if ! command -v clang-format > /dev/null; then skip clang-format "clang-format not installed"
  elif [ "$mode" = fix ]; then run clang-format blocking clang-format "$style" -i "${files[@]}"
  else run clang-format blocking clang-format "$style" --dry-run --Werror "${files[@]}"
  fi

  [ "$mode" = check ] || return 0
  sources=(); while IFS= read -r _l; do sources+=("$_l"); done < <(printf '%s\n' "${files[@]}" | grep -E '\.(c|cc|cpp|cxx)$')
  [ ${#sources[@]} -gt 0 ] || return 0
  if ! command -v clang-tidy > /dev/null; then skip clang-tidy "clang-tidy not installed"; return 0; fi

  local tconf=()
  [ -f .clang-tidy ] || tconf=(--config-file="$CONFIGS/.clang-tidy")
  local db=""
  for d in . build out cmake-build-debug; do [ -f "$d/compile_commands.json" ] && db=$d && break; done
  if [ -n "$db" ]; then
    run clang-tidy blocking clang-tidy "${tconf[@]}" -p "$db" "${sources[@]}"
  else
    # Without a compilation database clang-tidy has to guess flags, so its result is advisory.
    run clang-tidy advisory clang-tidy "${tconf[@]}" "${sources[@]}" -- -std=c++17 -I. -Iinclude -Isrc
  fi
}

lint_sql() {
  files=(); while IFS= read -r _l; do files+=("$_l"); done < <(files_for sql)
  [ ${#files[@]} -gt 0 ] || return 0
  command -v sqlfluff > /dev/null || { skip sqlfluff "sqlfluff not installed"; return 0; }

  local sconf=()
  if [ ! -f .sqlfluff ] && ! grep -qs '^\[tool\.sqlfluff' pyproject.toml; then sconf=(--config "$CONFIGS/.sqlfluff"); fi
  if [ "$mode" = fix ]; then run sqlfluff blocking sqlfluff fix "${sconf[@]}" --quiet "${files[@]}"
  elif [ -n "${GITHUB_ACTIONS:-}" ]; then
    run sqlfluff blocking sqlfluff lint "${sconf[@]}" --format github-annotation-native "${files[@]}"
  else run sqlfluff blocking sqlfluff lint "${sconf[@]}" "${files[@]}"
  fi
}

case "$mode:$lang" in
  check:* | fix:*) ;;
  *) echo "usage: lint.sh <check|fix> <js|python|java|cpp|sql>" >&2; exit 2 ;;
esac
case "$lang" in
  js) lint_js ;;
  python) lint_python ;;
  java) lint_java ;;
  cpp) lint_cpp ;;
  sql) lint_sql ;;
  *) echo "unknown language: $lang" >&2; exit 2 ;;
esac
exit $failed
