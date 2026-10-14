#!/usr/bin/env bash
# Tests for import_bundle in scripts/package-action-sandboxed.sh. Builds small
# tar files with the host `tar` and checks which ones the function accepts.
# Needs no Docker.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/package-action-sandboxed.sh
# shellcheck disable=SC1091
source "$script_dir/package-action-sandboxed.sh"

passed=0
failed=0

pass() {
  passed=$((passed + 1))
  printf 'ok   %s\n' "$1"
}

fail() {
  failed=$((failed + 1))
  printf 'FAIL %s\n' "$1" >&2
}

# expect_rc WANTED ACTUAL DESCRIPTION
expect_rc() {
  if [[ "$2" -eq "$1" ]]; then
    pass "$3"
  else
    fail "$3 (wanted exit $1, got $2)"
  fi
}

# import_bundle reads the directory it extracts into from the global $tmp.
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

new_dest() {
  local dest="$1"
  mkdir -p "$dest/dist/action"
  printf 'old\n' >"$dest/dist/action/old.js"
}

# expect_reject TARFILE DESCRIPTION
# Calls import_bundle against a destination that holds an old dist/action tree
# and checks that it fails and leaves that tree untouched.
expect_reject() {
  local tarfile="$1" description="$2"
  local dest
  dest="$tmp/dest.$RANDOM"
  new_dest "$dest"

  local actual=0
  import_bundle "$tarfile" "$dest" >/dev/null 2>&1 || actual=$?
  expect_rc 1 "$actual" "$description"

  if [[ -f "$dest/dist/action/old.js" ]]; then
    pass "destination untouched after: $description"
  else
    fail "destination modified after: $description"
  fi
}

# A valid bundle: a dist/action directory with two regular files.
stage="$tmp/stage-valid"
mkdir -p "$stage/dist/action"
printf 'new\n' >"$stage/dist/action/index.js"
printf '{}\n' >"$stage/dist/action/package.json"
tar -cf "$tmp/valid.tar" -C "$stage" dist/action

dest="$tmp/dest-accept"
new_dest "$dest"
actual=0
import_bundle "$tmp/valid.tar" "$dest" >/dev/null 2>&1 || actual=$?
expect_rc 0 "$actual" "accepts a valid dist/action tree"
if [[ -f "$dest/dist/action/index.js" && -f "$dest/dist/action/package.json" ]]; then
  pass "valid tree was imported"
else
  fail "valid tree was not imported"
fi
if [[ ! -e "$dest/dist/action/old.js" ]]; then
  pass "old dist/action was replaced"
else
  fail "old dist/action survived the import"
fi

# A symlink member.
stage="$tmp/stage-symlink"
mkdir -p "$stage/dist/action"
ln -s ../../../../etc/passwd "$stage/dist/action/link"
tar -cf "$tmp/symlink.tar" -C "$stage" dist/action
expect_reject "$tmp/symlink.tar" "rejects a symlink member"

# A hard link member.
stage="$tmp/stage-hardlink"
mkdir -p "$stage/dist/action"
printf 'x\n' >"$stage/dist/action/index.js"
ln "$stage/dist/action/index.js" "$stage/dist/action/hard"
tar -cf "$tmp/hardlink.tar" -C "$stage" dist/action
expect_reject "$tmp/hardlink.tar" "rejects a hard link member"

# Names built with --transform so the archive holds a literal member name.
printf 'x\n' >"$tmp/payload"
make_tar() {
  local name="$1" out="$2"
  tar --transform="s|^payload\$|$name|" -cf "$out" -C "$tmp" payload 2>/dev/null
}

make_tar '../x' "$tmp/parent.tar"
expect_reject "$tmp/parent.tar" "rejects a ../ member"

make_tar 'dist/action/../../x' "$tmp/dotdot.tar"
expect_reject "$tmp/dotdot.tar" "rejects a dist/action/../../x member"

make_tar '/tmp/abs/payload' "$tmp/absolute.tar"
expect_reject "$tmp/absolute.tar" "rejects an absolute member"

make_tar '.envrc' "$tmp/envrc.tar"
expect_reject "$tmp/envrc.tar" "rejects .envrc"

make_tar 'dist/cli.js' "$tmp/dist-cli.tar"
expect_reject "$tmp/dist-cli.tar" "rejects dist/cli.js"

printf '\npassed: %s failed: %s skipped: 0\n' "$passed" "$failed"
[[ "$failed" -eq 0 ]]
