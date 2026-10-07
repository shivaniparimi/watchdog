#!/usr/bin/env bash
# Install a repository's dependencies so Watchdog can run its tests (proof tests and mutation checks).
#
# Environment: SETUP_COMMAND (custom command; replaces detection), HAS_JS, HAS_PYTHON (true/false).
# Failures are reported but don't stop Watchdog; those checks are skipped instead.
set -uo pipefail

if [ -n "${SETUP_COMMAND:-}" ]; then
  echo "Running custom setup: $SETUP_COMMAND"
  bash -c "$SETUP_COMMAND"
  exit $?
fi

status=0
if [ "${HAS_JS:-}" = true ] && [ -f package.json ]; then
  if [ -f package-lock.json ]; then npm ci --no-audit --no-fund || status=1
  elif [ -f pnpm-lock.yaml ]; then corepack enable && pnpm install --frozen-lockfile || status=1
  elif [ -f yarn.lock ]; then corepack enable && yarn install --frozen-lockfile || status=1
  else npm install --no-audit --no-fund || status=1
  fi
fi

if [ "${HAS_PYTHON:-}" = true ]; then
  python -m pip install --quiet --upgrade pip
  for req in $(git ls-files '*requirements*.txt'); do python -m pip install --quiet -r "$req" || status=1; done
  if [ -f pyproject.toml ] && grep -q '^\[project\]' pyproject.toml; then python -m pip install --quiet -e . || status=1; fi
  python -m pip install --quiet pytest || status=1
fi

[ $status -eq 0 ] || echo "::warning::Some project dependencies failed to install; Watchdog skips test-based checks it can't run."
exit $status
