#!/usr/bin/env bash
# Tests for import_bundle and the bundle size cap in
# scripts/package-action-sandboxed.sh. Builds small tar files with the host
# `tar` and small git repositories with the host `git`. Needs no Docker.
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

# import_bundle and the cap function read the global $tmp.
tmp="$(mktemp -d)"
trap 'chmod -R u+rwX "$tmp" 2>/dev/null || true; rm -rf "$tmp"' EXIT

# The identity for the throwaway repositories, passed before the subcommand.
git_env=(git -c user.email=test@example.com -c user.name=test -c commit.gpgsign=false)

# new_dest DEST
# Create a destination repository whose tracked dist/action tree looks like a
# real bundle: two regular files, one of them in a subdirectory. `git ls-files`
# inside import_bundle reads these.
new_dest() {
  local dest="$1"
  mkdir -p "$dest/dist/action/parser-worker"
  printf 'old index\n' >"$dest/dist/action/index.js"
  printf 'old worker\n' >"$dest/dist/action/parser-worker/index.js"
  "${git_env[@]}" -C "$dest" init -q
  "${git_env[@]}" -C "$dest" add -A
  "${git_env[@]}" -C "$dest" commit -qm init
}

# assert_untouched DEST DESCRIPTION
assert_untouched() {
  local dest="$1" description="$2"
  if [[ "$(cat "$dest/dist/action/index.js" 2>/dev/null)" == "old index" ]]; then
    pass "destination untouched after: $description"
  else
    fail "destination modified after: $description"
  fi
}

# expect_reject TARFILE DESCRIPTION
# Calls import_bundle against a fresh destination repository and checks that it
# fails and leaves that repository's dist/action tree untouched.
expect_reject() {
  local tarfile="$1" description="$2"
  local dest="$tmp/dest.$RANDOM"
  new_dest "$dest"

  local actual=0
  import_bundle "$tarfile" "$dest" >/dev/null 2>&1 || actual=$?
  expect_rc 1 "$actual" "$description"
  assert_untouched "$dest" "$description"
}

# make_valid_tar OUT
# Build a bundle whose members are exactly the tracked files of new_dest.
# Content is long enough that the tar is truncated by the size test below.
make_valid_tar() {
  local out="$1"
  local stage="$tmp/stage.valid"
  rm -rf "$stage"
  mkdir -p "$stage/dist/action/parser-worker"
  head -c 3000 /dev/zero | tr '\0' 'i' >"$stage/dist/action/index.js"
  head -c 3000 /dev/zero | tr '\0' 'w' >"$stage/dist/action/parser-worker/index.js"
  tar -cf "$out" -C "$stage" dist/action
}

make_valid_tar "$tmp/valid.tar"

# A bundle with exactly the tracked files replaces the old tree.
dest="$tmp/dest-accept"
new_dest "$dest"
actual=0
import_bundle "$tmp/valid.tar" "$dest" >/dev/null 2>&1 || actual=$?
expect_rc 0 "$actual" "accepts a bundle with exactly the tracked files"
if [[ -f "$dest/dist/action/index.js" && -f "$dest/dist/action/parser-worker/index.js" ]]; then
  pass "valid bundle was imported"
else
  fail "valid bundle was not imported"
fi
if [[ "$(wc -c <"$dest/dist/action/index.js")" -eq 3000 ]]; then
  pass "valid bundle content replaced the old tree"
else
  fail "valid bundle content did not replace the old tree"
fi

# The bare-repository layout has no dot component and must still be rejected.
stage="$tmp/stage-bare"
rm -rf "$stage"
mkdir -p "$stage/dist/action/objects" "$stage/dist/action/refs"
printf 'ref: refs/heads/x\n' >"$stage/dist/action/HEAD"
printf '[core]\n\tbare = true\n' >"$stage/dist/action/config"
printf 'x\n' >"$stage/dist/action/objects/x"
printf 'x\n' >"$stage/dist/action/refs/x"
tar -cf "$tmp/bare.tar" -C "$stage" dist/action
expect_reject "$tmp/bare.tar" "rejects the bare-repository layout"

# An extra regular file that is not tracked.
stage="$tmp/stage-extra"
rm -rf "$stage"
mkdir -p "$stage/dist/action/parser-worker"
printf 'i\n' >"$stage/dist/action/index.js"
printf 'w\n' >"$stage/dist/action/parser-worker/index.js"
printf 'x\n' >"$stage/dist/action/extra.js"
tar -cf "$tmp/extra.tar" -C "$stage" dist/action
expect_reject "$tmp/extra.tar" "rejects an extra regular file"

# A tracked file missing from the archive.
stage="$tmp/stage-missing"
rm -rf "$stage"
mkdir -p "$stage/dist/action"
printf 'i\n' >"$stage/dist/action/index.js"
tar -cf "$tmp/missing.tar" -C "$stage" dist/action
expect_reject "$tmp/missing.tar" "rejects a missing tracked file"

# An extra directory that holds no tracked file.
stage="$tmp/stage-newdir"
rm -rf "$stage"
mkdir -p "$stage/dist/action/parser-worker" "$stage/dist/action/newdir"
printf 'i\n' >"$stage/dist/action/index.js"
printf 'w\n' >"$stage/dist/action/parser-worker/index.js"
tar -cf "$tmp/newdir.tar" -C "$stage" dist/action
expect_reject "$tmp/newdir.tar" "rejects an extra empty directory"

# A truncated archive: tar is happy with its partial listing, but the missing
# tracked files reject it.
head -c 1000 "$tmp/valid.tar" >"$tmp/truncated.tar"
expect_reject "$tmp/truncated.tar" "rejects a truncated tar"

# A mode-000 directory holding a file that is not tracked. The listing pass
# rejects the untracked file inside it.
stage="$tmp/stage-mode000"
rm -rf "$stage"
mkdir -p "$stage/dist/action/modedir"
printf 'x\n' >"$stage/dist/action/modedir/secret.js"
tar -cf "$tmp/mode000.tar" --mode=000 -C "$stage" dist/action
expect_reject "$tmp/mode000.tar" "rejects a mode-000 directory holding an untracked file"

# A mode-000 directory that holds only tracked files is accepted: extraction
# makes the tree readable before find descends, so the permissions cannot hide
# a member.
stage="$tmp/stage-mode000-ok"
rm -rf "$stage"
mkdir -p "$stage/dist/action/parser-worker"
printf 'i\n' >"$stage/dist/action/index.js"
printf 'w\n' >"$stage/dist/action/parser-worker/index.js"
tar -cf "$tmp/mode000-ok.tar" --mode=000 -C "$stage" dist/action
dest="$tmp/dest-mode000"
new_dest "$dest"
actual=0
import_bundle "$tmp/mode000-ok.tar" "$dest" >/dev/null 2>&1 || actual=$?
expect_rc 0 "$actual" "accepts a mode-000 directory holding only tracked files"

# A corrupt archive that tar itself rejects.
printf 'not a tar archive\n' >"$tmp/corrupt.tar"
expect_reject "$tmp/corrupt.tar" "rejects a corrupt tar"

# The remaining rejection cases build an archive with a single literal member
# name using --transform.
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

make_tar 'dist/action/.git/config' "$tmp/nested-git.tar"
expect_reject "$tmp/nested-git.tar" "rejects a nested .git directory"

make_tar 'dist/action/sub/.git/config' "$tmp/deep-git.tar"
expect_reject "$tmp/deep-git.tar" "rejects a .git directory deeper in dist/action"

make_tar 'dist/action/.envrc' "$tmp/action-envrc.tar"
expect_reject "$tmp/action-envrc.tar" "rejects a dotfile inside dist/action"

# A compressed bundle is refused: GNU tar would expand it on its own when
# reading a named file, past the size cap.
gzip -c "$tmp/valid.tar" >"$tmp/valid.tar.gz"
expect_reject "$tmp/valid.tar.gz" "rejects a gzip-compressed bundle"

# The member sizes are summed before extraction. The valid bundle holds 6000
# bytes of content, so a 5000-byte limit rejects it.
dest="$tmp/dest-extracted-cap"
new_dest "$dest"
actual=0
MAX_EXTRACTED_BYTES=5000 import_bundle "$tmp/valid.tar" "$dest" >/dev/null 2>&1 || actual=$?
expect_rc 1 "$actual" "rejects members totalling more than the extracted cap"
assert_untouched "$dest" "rejects members totalling more than the extracted cap"

# The size cap function compares a file against a limit.
printf '0123456789' >"$tmp/ten-bytes"
if bundle_within_cap "$tmp/ten-bytes" 10; then
  pass "size cap accepts a bundle exactly at the limit"
else
  fail "size cap rejected a bundle exactly at the limit"
fi
if bundle_within_cap "$tmp/ten-bytes" 9; then
  fail "size cap accepted a bundle over the limit"
else
  pass "size cap rejects a bundle over the limit"
fi
if bundle_within_cap "$tmp/ten-bytes" 1000; then
  pass "size cap accepts a bundle under the limit"
else
  fail "size cap rejected a bundle under the limit"
fi

printf '\npassed: %s failed: %s skipped: 0\n' "$passed" "$failed"
[[ "$failed" -eq 0 ]]
