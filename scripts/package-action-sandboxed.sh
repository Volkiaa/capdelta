#!/usr/bin/env bash
#
# Rebuild and verify the bundled GitHub Action inside a Docker container that
# holds no credentials. The updated dependency code (ncc, TypeScript, the
# bumped packages, the tests) runs only in that container, never on the host,
# so it cannot reach a token, an npmrc or an SSH key.
#
# The image is the full node:22-bookworm, pinned by digest. The slim variant
# has no git and the test suite runs real git in throwaway repositories, so a
# full image lets the script install nothing at run time.
#
# The checkout's `.git` is mounted read-only on top of the working copy. A
# writable `.git/hooks` would let the build leave a hook that the host runs at
# the next commit, which is host code execution from updated dependency code.
#
# The script never commits, pushes or writes to Git. It prints the dist/action
# diff; review it, then commit and push by hand.
set -euo pipefail

IMAGE="node:22-bookworm@sha256:0e5f906573693feaa1e21057ebdcfdb5bd5021f050b2dc7c9deceb629c7da2a8"

# The path a `git status --porcelain` line refers to. Renames and copies read
# "old -> new", so take the new path.
porcelain_path() {
  local rest="${1:3}"
  printf '%s\n' "${rest##* -> }"
}

# The rebuild may only change, add or ignore paths under these directories.
# dist/action/ is tracked; dist/ and node_modules/ are ignored (see .gitignore).
path_is_allowed() {
  case "$1" in
    dist/action | dist/action/* | dist/* | node_modules/*) return 0 ;;
    *) return 1 ;;
  esac
}

# Read `git status --porcelain --untracked-files=all` on stdin and fail if it
# is not empty. Any tracked change or untracked file must be gone before the
# rebuild, because the container could edit such a path and the status line
# would stay the same, hiding the edit. Ignored entries do not appear in this
# output, so an installed package or existing build output does not block the
# run. Prints each offending path to stderr and returns 1 if there is one.
check_worktree_clean() {
  local status=0 line path
  while IFS= read -r line; do
    if [[ -z "$line" ]]; then
      continue
    fi
    path="$(porcelain_path "$line")"
    printf 'error: the worktree is not clean before the rebuild: %s\n' "$path" >&2
    status=1
  done
  return "$status"
}

# Read `git status --porcelain --ignored --untracked-files=all` on stdin and
# fail if any path lies outside dist/action/, dist/ or node_modules/. Paths in
# the optional baseline file are skipped. The baseline holds the ignored
# entries (`!!` lines) recorded before the rebuild, so an ignored path that
# already existed is not reported even when it sits outside the three
# directories. Prints the offending paths to stderr and returns 1 if there are
# any.
check_status_scope() {
  local baseline_file="${1:-}"
  local -A preexisting=()
  if [[ -n "$baseline_file" ]]; then
    local base_line
    while IFS= read -r base_line; do
      if [[ -n "$base_line" ]]; then
        preexisting["$(porcelain_path "$base_line")"]=1
      fi
    done <"$baseline_file"
  fi

  local status=0 line path
  while IFS= read -r line; do
    if [[ -z "$line" ]]; then
      continue
    fi
    path="$(porcelain_path "$line")"
    if [[ -n "${preexisting[$path]:-}" ]]; then
      continue
    fi
    if ! path_is_allowed "$path"; then
      printf 'stray path outside dist/action, dist and node_modules: %s\n' "$path" >&2
      status=1
    fi
  done
  return "$status"
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

  # No host environment variable, home directory, npmrc, gitconfig, SSH agent
  # or Docker socket is mounted. `.git` is remounted read-only on top.
  local mounts=(
    --rm
    --user "$(id -u):$(id -g)"
    -e HOME=/tmp/home
    -e npm_config_cache=/tmp/npm-cache
    -v "$PWD":/w
    -v "$PWD/.git":/w/.git:ro
    -w /w
  )

  # Tracked changes and untracked files would hide a container edit, so refuse
  # to run until they are gone.
  printf 'checking for a clean worktree\n'
  if ! git status --porcelain --untracked-files=all | check_worktree_clean; then
    printf 'error: commit, stash or remove the paths above before rebuilding\n' >&2
    return 1
  fi

  # Ignored paths that already exist. They pass the scope check unchanged;
  # only new ignored paths outside dist/action, dist and node_modules count as
  # strays.
  local baseline
  baseline="$(git status --porcelain --ignored --untracked-files=all | grep '^!!' || true)"

  printf 'step 1/3: install dependencies (network allowed)\n'
  docker run "${mounts[@]}" "$IMAGE" npm ci --ignore-scripts

  printf 'step 2/3: rebuild and verify, no network\n'
  docker run "${mounts[@]}" --network none "$IMAGE" sh -c \
    'npm run package:action && npm run typecheck && npm run lint && npm run format:check && npm test && npm run check:deps'

  printf 'step 3/3: check for stray paths\n'
  if ! git status --porcelain --ignored --untracked-files=all |
    check_status_scope <(printf '%s\n' "$baseline"); then
    printf 'error: the rebuild changed paths outside dist/action, dist and node_modules\n' >&2
    return 1
  fi

  printf '\nthe rebuild changed nothing outside dist/action (ignoring dist/ and node_modules/ scratch)\n'
  git diff --stat -- dist/action
  printf '\nreview the diff above, then commit and push the change by hand\n'
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  main "$@"
fi
