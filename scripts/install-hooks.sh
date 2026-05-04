#!/bin/sh
# Wires this clone's git hooks to the shared workspace hooks at
# <workspace>/.githooks/. Run after a fresh clone:
#
#   sh scripts/install-hooks.sh
#
# Idempotent. Also runs automatically from `npm install` via the
# `postinstall` script in package.json.
#
# Why: core.hooksPath is a per-clone --local config, so it gets wiped on
# every reclone. Storing the install command in-repo means a future
# fresh clone is one `npm install` away from the same enforcement,
# without anyone having to remember the path.
#
# Tolerant by design: this runs from `npm install`, which CI also runs.
# If the workspace layout isn't recognized (CI runners, contributors who
# clone outside /Users/miszion/workplace/), we exit 0 silently rather
# than failing the install.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WORKSPACE="$(cd "$SCRIPT_DIR/../.." && pwd)"
HOOKS_DIR="$WORKSPACE/.githooks"

if [ ! -d "$HOOKS_DIR" ]; then
  echo "install-hooks: skipping (no shared hooks dir at $HOOKS_DIR)"
  exit 0
fi

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "install-hooks: skipping (not a git work tree)"
  exit 0
fi

git config core.hooksPath "$HOOKS_DIR"
echo "install-hooks: core.hooksPath -> $HOOKS_DIR"
