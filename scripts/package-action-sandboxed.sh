#!/usr/bin/env bash
#
# Rebuild and verify the bundled GitHub Action inside a Docker container that
# holds no credentials and never sees the checkout. The updated dependency code
# (ncc, TypeScript, the bumped packages, the tests) runs only in that container,
# never on the host, so it cannot reach a token, an npmrc or an SSH key.
#
# The container gets a `git archive HEAD` stream, not a mount of the working
# tree. It cannot read an ignored secret such as `.env` or `.git/config`, plant
# a file under `node_modules/` or `dist/` that the host runs later, overwrite an
# existing ignored file such as `.envrc`, or leave a file behind: the checkout is
# untouched until `import_bundle` validates the archive and replaces only
# `dist/action`.
#
# The bundle is checked against an allowlist, not a name rule. `import_bundle`
# takes the expected file set from the files tracked under `dist/action` in the
# destination repository, then accepts a member only if it is a regular file on
# that list or a directory that leads to one. A rule based on names alone lets a
# bundle carry `dist/action/HEAD` and `dist/action/config`, which turns the
# directory into a bare repository whose config (core.pager, alias.*) would run
# the next time git is used inside it.
#
# The image is the full node:22-bookworm, pinned by digest. The slim variant has
# no git and the test suite runs real git in throwaway repositories, so a full
# image lets the script install nothing at run time.
#
# The script never commits, pushes or writes to Git. It prints the dist/action
# diff; review it, then commit and push by hand.
set -euo pipefail

IMAGE="node:22-bookworm@sha256:0e5f906573693feaa1e21057ebdcfdb5bd5021f050b2dc7c9deceb629c7da2a8"

# The rebuilt dist/action tree is a few hundred KiB. Cap the streamed bundle at
# 50 MiB so a runaway or hostile container cannot fill the host disk.
MAX_BUNDLE_BYTES=$((50 * 1024 * 1024))

# Fail unless the streamed bundle file is within the cap. main streams the
# container output through `head -c $((MAX_BUNDLE_BYTES + 1))`, so a larger
# bundle is cut off at the cap and rejected here before any parsing.
bundle_within_cap() {
  local file="$1" max="${2:-$MAX_BUNDLE_BYTES}" size
  size="$(wc -c <"$file")"
  ((size <= max))
}

# Read `git status --porcelain --untracked-files=no` on stdin and fail if it is
# not empty. A tracked modification could hide an edit made by the rebuild, so
# refuse to run until it is gone. Untracked files do not block the run: they are
# never exported, because the container gets `git archive HEAD`.
check_worktree_clean() {
  local status=0 line
  while IFS= read -r line; do
    if [[ -n "$line" ]]; then
      printf 'error: the worktree has a tracked change before the rebuild: %s\n' "$line" >&2
      status=1
    fi
  done
  return "$status"
}

# Import a `dist/action` bundle tar into a repository root. Take the expected
# file set from the files tracked under `dist/action` in <dest>, then check the
# archive against it twice: the `tar -t` listing, then the extracted tree. A
# member is accepted only if it is a regular file whose path is one of the
# tracked files, or a directory on the way to one. Any other member, a missing
# tracked file, an extra file, or a corrupt archive is a rejection. On rejection
# print the offending names, return 1, and leave the destination unchanged.
import_bundle() {
  local tarfile="$1" dest="$2"
  local -a offenders=() missing=() names=() types=()
  local name type i component has_parent has_dot dir
  local -a parts=()
  local -A expected=() allowed=() seen=() seen_listing=()

  # The tracked files are trusted, but compare them as literal strings, never as
  # patterns.
  if ! git -C "$dest" ls-files -z -- dist/action >"$tmp/expected"; then
    printf 'error: could not list the tracked files under dist/action in %s\n' "$dest" >&2
    return 1
  fi
  while IFS= read -r -d '' name; do
    [[ -z "$name" ]] && continue
    expected["$name"]=1
    dir="${name%/*}"
    while [[ "$dir" == dist || "$dir" == dist/* ]]; do
      allowed["$dir"]=1
      [[ "$dir" == dist ]] && break
      dir="${dir%/*}"
    done
  done <"$tmp/expected"
  allowed[dist]=1
  allowed[dist/action]=1

  # Listing pass. Write both listings to files and check the exits: in a process
  # substitution a tar failure is silent.
  if ! tar -tf "$tarfile" >"$tmp/tar-names"; then
    printf 'error: could not read the bundle listing (truncated or corrupt archive)\n' >&2
    return 1
  fi
  if ! tar -tvf "$tarfile" >"$tmp/tar-list"; then
    printf 'error: could not read the bundle listing (truncated or corrupt archive)\n' >&2
    return 1
  fi
  while IFS= read -r name; do
    while [[ "$name" == */ ]]; do name="${name%/}"; done
    names+=("$name")
  done <"$tmp/tar-names"
  while IFS= read -r type; do types+=("${type:0:1}"); done <"$tmp/tar-list"
  if ((${#names[@]} != ${#types[@]})); then
    printf 'error: the bundle listing is inconsistent; the checkout is unchanged\n' >&2
    return 1
  fi

  for ((i = 0; i < ${#names[@]}; i++)); do
    name="${names[$i]}"
    type="${types[$i]}"
    # Defence in depth. The allowlist below already rejects everything the
    # bundle does not track, but keep the absolute, `..` and dot checks: a
    # component starting with a dot would let a nested `.git` reach the
    # checkout, and git would run its config the next time it runs in there.
    if [[ "$name" == /* ]]; then
      offenders+=("$name (absolute path)")
      continue
    fi
    IFS='/' read -r -a parts <<<"$name"
    has_parent=0
    has_dot=0
    for component in "${parts[@]}"; do
      [[ "$component" == ".." ]] && has_parent=1
      [[ "$component" == .* ]] && has_dot=1
    done
    if [[ "$has_parent" -eq 1 ]]; then
      offenders+=("$name (.. component)")
      continue
    fi
    if [[ "$has_dot" -eq 1 ]]; then
      offenders+=("$name (component starting with a dot)")
      continue
    fi
    case "$type" in
      -)
        if [[ -z "${expected[$name]:-}" ]]; then
          offenders+=("$name (regular file that is not tracked)")
        elif [[ -n "${seen_listing[$name]:-}" ]]; then
          offenders+=("$name (duplicate regular file)")
        else
          seen_listing["$name"]=1
        fi
        ;;
      d)
        [[ -n "${allowed[$name]:-}" ]] || offenders+=("$name (unexpected directory)")
        ;;
      *) offenders+=("$name (member type $type)") ;;
    esac
  done

  for name in "${!expected[@]}"; do
    [[ -n "${seen_listing[$name]:-}" ]] || missing+=("$name")
  done

  if ((${#offenders[@]} > 0)); then
    printf 'error: refusing the bundle, offending members:\n' >&2
    printf '  %s\n' "${offenders[@]}" >&2
    return 1
  fi
  if ((${#missing[@]} > 0)); then
    printf 'error: the bundle is missing tracked files: %s\n' "${missing[*]}" >&2
    printf 'the bundle file list changed, handle the rebuild by hand\n' >&2
    return 1
  fi

  local extract="$tmp/extract"
  rm -rf "$extract"
  mkdir -p "$extract"
  if ! tar -x -f "$tarfile" -C "$extract" --no-same-owner --no-same-permissions; then
    printf 'error: could not extract the bundle\n' >&2
    return 1
  fi
  # A mode-000 directory would stop find from descending, and find's error was
  # not fatal. Make the tree readable first, and check that too.
  if ! chmod -R u+rwX "$extract"; then
    printf 'error: could not make the extracted bundle readable\n' >&2
    return 1
  fi
  if ! find "$extract" -mindepth 1 -printf '%y %P\n' >"$tmp/extract-find"; then
    printf 'error: could not inspect the extracted bundle\n' >&2
    return 1
  fi

  # Second check, on the extracted tree.
  offenders=()
  while IFS= read -r entry; do
    [[ -z "$entry" ]] && continue
    type="${entry%% *}"
    name="${entry#* }"
    case "$type" in
      f)
        if [[ -z "${expected[$name]:-}" ]]; then
          offenders+=("$name (extracted file that is not tracked)")
        elif [[ -n "${seen[$name]:-}" ]]; then
          offenders+=("$name (duplicate extracted file)")
        else
          seen["$name"]=1
        fi
        ;;
      d)
        [[ -n "${allowed[$name]:-}" ]] || offenders+=("$name (extracted unexpected directory)")
        ;;
      *) offenders+=("$name (extracted as type $type)") ;;
    esac
  done <"$tmp/extract-find"

  missing=()
  for name in "${!expected[@]}"; do
    [[ -n "${seen[$name]:-}" ]] || missing+=("$name")
  done

  if ((${#offenders[@]} > 0)); then
    printf 'error: the extracted bundle is invalid, offending members:\n' >&2
    printf '  %s\n' "${offenders[@]}" >&2
    return 1
  fi
  if ((${#missing[@]} > 0)); then
    printf 'error: the extracted bundle is missing tracked files: %s\n' "${missing[*]}" >&2
    printf 'the bundle file list changed, handle the rebuild by hand\n' >&2
    return 1
  fi
  if [[ ! -d "$extract/dist/action" ]]; then
    printf 'error: the bundle holds no dist/action directory\n' >&2
    return 1
  fi

  mkdir -p "$dest/dist"
  rm -rf "$dest/dist/action"
  mv "$extract/dist/action" "$dest/dist/action"
}

main() {
  if ! command -v docker >/dev/null 2>&1; then
    printf 'error: docker is not on PATH\n' >&2
    return 1
  fi

  if [[ ! -f package.json || ! -f scripts/package-action.mjs ]]; then
    printf 'error: run this from the repository root (package.json and scripts/package-action.mjs must exist)\n' >&2
    return 1
  fi

  local toplevel
  toplevel="$(git rev-parse --show-toplevel)"
  if [[ "$toplevel" != "$PWD" ]]; then
    printf 'error: the working directory is not the repository root (%s)\n' "$toplevel" >&2
    return 1
  fi

  printf 'checking for tracked changes\n'
  if ! git status --porcelain --untracked-files=no | check_worktree_clean; then
    printf 'error: commit or stash the tracked changes above before rebuilding\n' >&2
    return 1
  fi

  # The named volume holds the sandbox working copy and the temp directory holds
  # the streamed bundle. Both are removed on every exit path, success or
  # failure, so a planted volume or bundle never outlives the run.
  tmp="$(mktemp -d)"
  vol="capdelta-sandbox-$$-$RANDOM"
  trap cleanup EXIT

  # No host path is mounted and no host environment variable is passed. The
  # volume is the only writable place the container sees.
  local common=(
    --rm
    --user node
    -e HOME=/tmp/home
    -e npm_config_cache=/tmp/npm-cache
    -v "$vol":/w
    -w /w
  )

  printf 'initializing the sandbox volume\n'
  # Docker fills a volume from the image on each mount while the volume stays
  # empty, and that resets the owner of /w to root. The marker entry keeps the
  # volume non-empty, so the chown sticks for the next containers. The marker
  # never leaves the sandbox: only dist/action is streamed back.
  docker run --rm --user root -v "$vol":/w -w /w "$IMAGE" \
    sh -c 'chown node:node /w && touch /w/.sandbox-keep'

  printf 'step 1/3: install dependencies from git archive HEAD (network allowed)\n'
  git archive --format=tar HEAD |
    docker run -i "${common[@]}" "$IMAGE" sh -c 'tar -x -f - && npm ci --ignore-scripts'

  printf 'step 2/3: rebuild and verify, no network\n'
  # Stream the bundle through head so a runaway container cannot fill the disk.
  # A bundle that reaches the cap is rejected below before any parsing.
  local rc=0
  docker run "${common[@]}" --network none "$IMAGE" sh -c \
    '{ npm run package:action && npm run typecheck && npm run lint && npm run format:check && npm test && npm run check:deps; } 1>&2 && tar -c -f - dist/action' |
    head -c $((MAX_BUNDLE_BYTES + 1)) >"$tmp/bundle.tar" || rc=$?
  if ((rc != 0)); then
    if ! bundle_within_cap "$tmp/bundle.tar"; then
      printf 'error: the bundle is over the %s byte cap; the checkout is unchanged\n' "$MAX_BUNDLE_BYTES" >&2
      return 1
    fi
    printf 'error: the rebuild or a check failed; the checkout is unchanged\n' >&2
    return 1
  fi

  printf 'step 3/3: import dist/action from the bundle\n'
  if ! import_bundle "$tmp/bundle.tar" "$PWD"; then
    printf 'error: the bundle was rejected; the checkout is unchanged\n' >&2
    return 1
  fi

  printf '\nthe checkout changed only under dist/action\n'
  git diff --stat -- dist/action
  printf '\nreview the diff above, then commit and push the change by hand\n'
}

# Remove the named volume and the temp directory on every exit path. The
# variables are global, not local to main, so the trap still sees them after
# main returns.
cleanup() {
  if ! docker volume rm -f "$vol" >/dev/null; then
    printf 'warning: could not remove the sandbox volume %s; remove it with docker volume rm\n' "$vol" >&2
  fi
  rm -rf "$tmp"
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  main "$@"
fi
