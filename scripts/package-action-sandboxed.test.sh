#!/usr/bin/env bash
# Tests for check_status_scope in scripts/package-action-sandboxed.sh.
# Feeds the function sample `git status --porcelain` lines. Needs no Docker.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/package-action-sandboxed.sh
source "$script_dir/package-action-sandboxed.sh"

passed=0
failed=0

# expect EXIT DESCRIPTION [BASELINE_FILE]
# Reads the porcelain lines to check on stdin.
expect() {
  local wanted="$1" description="$2" baseline="${3:-}"
  local actual
  if [[ -n "$baseline" ]]; then
    if check_status_scope "$baseline"; then actual=0; else actual=$?; fi
  else
    if check_status_scope; then actual=0; else actual=$?; fi
  fi
  if [[ "$actual" -eq "$wanted" ]]; then
    passed=$((passed + 1))
    printf 'ok   %s\n' "$description"
  else
    failed=$((failed + 1))
    printf 'FAIL %s (wanted exit %s, got %s)\n' "$description" "$wanted" "$actual" >&2
  fi
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# A rebuild may touch anything under these three directories.
expect 0 "changed file under dist/action/" <<'EOF'
 M dist/action/index.js
EOF

expect 0 "untracked file under dist/action/" <<'EOF'
?? dist/action/extra.js
EOF

expect 0 "ignored file under dist/" <<'EOF'
!! dist/index.js
EOF

expect 0 "ignored file under node_modules/" <<'EOF'
!! node_modules/.bin/ncc
EOF

# Anything else is a stray path.
expect 1 "untracked .envrc" <<'EOF'
?? .envrc
EOF

expect 1 "changed source file" <<'EOF'
 M src/x.ts
EOF

expect 1 "changed workflow" <<'EOF'
 M .github/workflows/x.yml
EOF

expect 1 "untracked stray.txt" <<'EOF'
?? stray.txt
EOF

expect 1 "one stray among allowed paths" <<'EOF'
 M dist/action/index.js
?? stray.txt
!! node_modules/.bin/ncc
EOF

# A path that already existed before the rebuild is not reported.
baseline="$tmp/baseline"
printf '?? .envrc\n?? NOTES.md\n' >"$baseline"
expect 0 "pre-existing stray path" "$baseline" <<'EOF'
?? .envrc
?? NOTES.md
EOF

expect 0 "pre-existing path with a new allowed path" "$baseline" <<'EOF'
?? .envrc
?? dist/action/extra.js
EOF

printf '\npassed: %s failed: %s skipped: 0\n' "$passed" "$failed"
[[ "$failed" -eq 0 ]]
