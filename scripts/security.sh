#!/usr/bin/env bash
# Dependency and code security checks that run outside CodeQL.
#
#   security.sh
#
# Environment: FILES_DIR (from detect.sh), RESULTS_DIR (default ./watchdog-security).
# Writes summary.tsv (check, status, note) and one log per check. Exits 1 if any check failed.
#   npm audit   high or critical advisories in production npm dependencies
#   pip-audit   known vulnerabilities in requirements*.txt dependencies
#   bandit      high-severity issues in changed Python files (medium ones are reported, not blocking)
set -o pipefail

export RESULTS_DIR=${RESULTS_DIR:-$PWD/watchdog-security}
mkdir -p "$RESULTS_DIR"
failed=0

record() {
  printf '%s\t%s\t%s\n' "$1" "$2" "${3:-}" >> "$RESULTS_DIR/summary.tsv"
  [ "$2" = fail ] && failed=1
  return 0
}

# check <name> <command...>: run, log, and record pass/fail by exit code.
check() {
  local name=$1
  shift
  echo "::group::security · $name"
  "$@" > "$RESULTS_DIR/$name.log" 2>&1
  local code=$?
  cat "$RESULTS_DIR/$name.log"
  echo "::endgroup::"
  if [ $code -eq 0 ]; then record "$name" pass; else record "$name" fail "exit $code"; fi
}

# npm: only when there's a lockfile to audit.
if [ -f package-lock.json ]; then
  if command -v npm > /dev/null; then check npm-audit npm audit --audit-level=high --omit=dev
  else record npm-audit skip "npm not installed"; fi
elif [ -f yarn.lock ] || [ -f pnpm-lock.yaml ]; then
  record npm-audit skip "only package-lock.json is audited"
fi

# Python dependencies pinned in requirements files.
reqs=()
while IFS= read -r f; do reqs+=("$f"); done < <(git ls-files '*requirements*.txt' 2> /dev/null)
if [ ${#reqs[@]} -gt 0 ]; then
  if command -v pip-audit > /dev/null; then
    args=()
    for r in "${reqs[@]}"; do args+=(-r "$r"); done
    check pip-audit pip-audit --progress-spinner off --desc on "${args[@]}"
  else
    record pip-audit skip "pip-audit not installed"
  fi
fi

# Bandit on changed Python files.
py=()
if [ -s "${FILES_DIR:-}/python.txt" ]; then
  while IFS= read -r f; do [ -f "$f" ] && py+=("$f"); done < "$FILES_DIR/python.txt"
fi
if [ ${#py[@]} -gt 0 ]; then
  if command -v bandit > /dev/null; then
    echo "::group::security · bandit"
    bandit -q --severity-level medium --confidence-level medium -f custom \
      --msg-template '{relpath}:{line}:{col}: {severity}: [{test_id}] {msg}' "${py[@]}" \
      > "$RESULTS_DIR/bandit.log" 2>&1
    cat "$RESULTS_DIR/bandit.log"
    echo "::endgroup::"
    high=$(grep -c ': HIGH: ' "$RESULTS_DIR/bandit.log")
    medium=$(grep -c ': MEDIUM: ' "$RESULTS_DIR/bandit.log")
    if [ "$high" -gt 0 ]; then record bandit fail "$high high, $medium medium"
    elif [ "$medium" -gt 0 ]; then record bandit warn "$medium medium"
    else record bandit pass; fi
  else
    record bandit skip "bandit not installed"
  fi
fi

[ -f "$RESULTS_DIR/summary.tsv" ] || echo "No dependency manifests or Python changes to scan."
exit $failed
