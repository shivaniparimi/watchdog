#!/usr/bin/env bash
# Install a git pre-commit hook that runs Watchdog's formatters and linters on staged files.
#
#   scripts/install-hook.sh [path/to/repo]   (default: current directory)
#
# On each commit the hook auto-fixes staged files, re-stages them, then blocks the commit if
# lint problems remain. Skip it once with `git commit --no-verify`.
set -euo pipefail

WATCHDOG_DIR=$(cd "$(dirname "$0")/.." && pwd)
repo=$(cd "${1:-.}" && git rev-parse --show-toplevel)
hook=$(git -C "$repo" rev-parse --git-path hooks/pre-commit)
case "$hook" in /*) ;; *) hook=$repo/$hook ;; esac

if [ -e "$hook" ] && ! grep -q "Watchdog pre-commit hook" "$hook"; then
  echo "A different pre-commit hook already exists at $hook; not overwriting it." >&2
  exit 1
fi

mkdir -p "$(dirname "$hook")"
cat > "$hook" <<HOOK
#!/usr/bin/env bash
# Watchdog pre-commit hook (installed by $WATCHDOG_DIR/scripts/install-hook.sh)
set -o pipefail
export WATCHDOG_DIR="$WATCHDOG_DIR"
work=\$(mktemp -d)
trap 'rm -rf "\$work"' EXIT
export FILES_DIR=\$work/files RESULTS_DIR=\$work/results

"\$WATCHDOG_DIR/scripts/detect.sh" --staged "" "\$FILES_DIR" > /dev/null
[ -s "\$FILES_DIR/all.txt" ] || exit 0

for lang in js python java cpp sql; do "\$WATCHDOG_DIR/scripts/lint.sh" fix "\$lang" > /dev/null 2>&1; done
git add --pathspec-from-file="\$FILES_DIR/all.txt"

status=0
for lang in js python java cpp sql; do "\$WATCHDOG_DIR/scripts/lint.sh" check "\$lang" > "\$work/\$lang.out" 2>&1 || status=1; done
if [ \$status -ne 0 ]; then
  echo "Watchdog: lint problems remain in staged files:"
  awk -F'\t' '\$3 == "fail" { print "  " \$1 "/" \$2 }' "\$RESULTS_DIR/summary.tsv"
  echo
  for f in "\$RESULTS_DIR"/*.log; do
    tool=\$(basename "\$f" .log)
    if awk -F'\t' -v t="\$tool" '\$2 == t && \$3 == "fail" { found = 1 } END { exit !found }' "\$RESULTS_DIR/summary.tsv"; then
      echo "--- \$tool"; head -n 20 "\$f"
    fi
  done
  echo
  echo "Fix them, or commit with --no-verify to skip this check."
fi
exit \$status
HOOK
chmod +x "$hook"
echo "Installed Watchdog pre-commit hook at $hook"
