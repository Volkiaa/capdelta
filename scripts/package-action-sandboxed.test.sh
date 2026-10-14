#!/usr/bin/env bash
# Tests for check_worktree_clean and check_status_scope in
# scripts/package-action-sandboxed.sh. Feeds the functions sample
# `git status --porcelain` lines. Needs no Docker.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/package-action-sandboxed.sh
# shellcheck disable=SC1091
source "$script_dir/package-action-sandboxed.sh"

passed=0
failed=0

report() {
  local wanted="$1" actual="$2" description="$3"
  if [[ "$actual" -eq "$wanted" ]]; then
    passed=$((passed + 1))
    printf 'ok   %s\n' "$description"
  else
    failed=$((failed + 1))
    printf 'FAIL %s (wanted exit %s, got %s)\n' "$description" "$wanted" "$actual" >&2
  fi
}

# expect_clean WANTED DESCRIPTION
# Reads `git status --porcelain --untracked-files=all` lines on stdin.
expect_clean() {
  local wanted="$1" description="$2" actual
  if check_worktree_clean; then actual=0; else actual=$?; fi
  report "$wanted" "$actual" "$description"
}

# expect_scope WANTED DESCRIPTION [BASELINE_FILE]
# Reads `git status --porcelain --ignored --untracked-files=all` lines on stdin.
expect_scope() {
  local wanted="$1" description="$2" baseline="${3:-}" actual
  if [[ -n "$baseline" ]]; then
    if check_status_scope "$baseline"; then actual=0; else actual=$?; fi
  else
    if check_status_scope; then actual=0; else actual=$?; fi
  fi
  report "$wanted" "$actual" "$description"
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# Before the rebuild there must be no tracked change and no untracked file.
# Ignored entries never appear in this output.
expect_clean 0 "clean worktree" </dev/null

expect_clean 1 "modified tracked path before the run" <<'EOF'
 M src/x.ts
EOF

expect_clean 1 "modified bundle before the run" <<'EOF'
 M dist/action/index.js
EOF

expect_clean 1 "untracked file before the run" <<'EOF'
?? stray.txt
EOF

# The rebuild may touch anything under these three directories.
expect_scope 0 "changed file under dist/action/" <<'EOF'
 M dist/action/index.js
EOF

expect_scope 0 "untracked file under dist/action/" <<'EOF'
?? dist/action/extra.js
EOF

expect_scope 0 "ignored file under dist/" <<'EOF'
!! dist/index.js
EOF

expect_scope 0 "ignored file under node_modules/" <<'EOF'
!! node_modules/.bin/ncc
EOF

# Anything else is a stray path.
expect_scope 1 "untracked .envrc" <<'EOF'
?? .envrc
EOF

expect_scope 1 "changed source file" <<'EOF'
 M src/x.ts
EOF

expect_scope 1 "changed workflow" <<'EOF'
 M .github/workflows/x.yml
EOF

expect_scope 1 "untracked stray.txt" <<'EOF'
?? stray.txt
EOF

expect_scope 1 "one stray among allowed paths" <<'EOF'
 M dist/action/index.js
?? stray.txt
!! node_modules/.bin/ncc
EOF

# The baseline holds only ignored entries that already existed before the run.
baseline="$tmp/baseline"
printf '!! .env\n!! coverage/report.html\n' >"$baseline"

expect_scope 0 "pre-existing ignored path outside the allowed dirs" "$baseline" <<'EOF'
!! .env
!! coverage/report.html
!! node_modules/.bin/ncc
EOF

expect_scope 0 "pre-existing ignored path with a new allowed path" "$baseline" <<'EOF'
!! .env
?? dist/action/extra.js
EOF

expect_scope 1 "new ignored path outside the allowed dirs" "$baseline" <<'EOF'
!! .env
!! coverage/new.html
EOF

printf '\npassed: %s failed: %s skipped: 0\n' "$passed" "$failed"
[[ "$failed" -eq 0 ]]
