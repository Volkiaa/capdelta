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
# The image is the full node:22-bookworm, pinned by digest. The slim variant has
# no git and the test suite runs real git in throwaway repositories, so a full
# image lets the script install nothing at run time.
#
# The script never commits, pushes or writes to Git. It prints the dist/action
# diff; review it, then commit and push by hand.
set -euo pipefail

IMAGE="node:22-bookworm@sha256:0e5f906573693feaa1e21057ebdcfdb5bd5021f050b2dc7c9deceb629c7da2a8"

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

# Import a `dist/action` bundle tar into a repository root. Reject the archive
# before extracting if any member is not a regular file or a directory, is an
# absolute path, has a `..` component, or lies outside `dist/action`. Extract
# into a fresh directory under $tmp, check the extracted tree with find, and only
# then replace <dest>/dist/action. On rejection print the offending member names,
# return 1, and leave the destination unchanged.
import_bundle() {
  local tarfile="$1" dest="$2"
  local -a names=() offenders=()
  local name type i component
  local -a parts=()

  while IFS= read -r name; do
    names+=("$name")
  done < <(tar -tf "$tarfile")

  # The first field of `tar -tvf` is the permission string, whose first
  # character is the member type. It is `-` for a regular file and `d` for a
  # directory; anything else (a link or a device) is a rejection.
  i=0
  while IFS= read -r type; do
    case "$type" in
      - | d) ;;
      *) offenders+=("${names[$i]:-unknown} (type $type)") ;;
    esac
    i=$((i + 1))
  done < <(tar -tvf "$tarfile" | cut -c1)

  for name in "${names[@]}"; do
    if [[ "$name" == /* ]]; then
      offenders+=("$name (absolute path)")
      continue
    fi
    IFS='/' read -r -a parts <<<"$name"
    local has_parent=0
    for component in "${parts[@]}"; do
      [[ "$component" == ".." ]] && has_parent=1
    done
    if [[ "$has_parent" -eq 1 ]]; then
      offenders+=("$name (.. component)")
      continue
    fi
    case "$name" in
      dist/action | dist/action/*) ;;
      *) offenders+=("$name (outside dist/action)") ;;
    esac
  done

  if ((${#offenders[@]} > 0)); then
    printf 'error: refusing the bundle, offending members:\n' >&2
    printf '  %s\n' "${offenders[@]}" >&2
    return 1
  fi

  local extract="$tmp/extract"
  rm -rf "$extract"
  mkdir -p "$extract"
  if ! tar -x -f "$tarfile" -C "$extract" --no-same-owner --no-same-permissions; then
    printf 'error: could not extract the bundle\n' >&2
    return 1
  fi

  # A second check on the extracted tree, in case the listing missed something.
  offenders=()
  while IFS= read -r entry; do
    [[ -z "$entry" ]] && continue
    type="${entry%% *}"
    name="${entry#* }"
    case "$type" in
      f | d) ;;
      *)
        offenders+=("$name (extracted as type $type)")
        continue
        ;;
    esac
    case "$name" in
      dist | dist/action | dist/action/*) ;;
      *) offenders+=("$name (extracted outside dist/action)") ;;
    esac
  done < <(find "$extract" -mindepth 1 -printf '%y %P\n')

  if ((${#offenders[@]} > 0)); then
    printf 'error: the extracted bundle is invalid, offending members:\n' >&2
    printf '  %s\n' "${offenders[@]}" >&2
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
  if ! docker run "${common[@]}" --network none "$IMAGE" sh -c \
    '{ npm run package:action && npm run typecheck && npm run lint && npm run format:check && npm test && npm run check:deps; } 1>&2 && tar -c -f - dist/action' \
    >"$tmp/bundle.tar"; then
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
  docker volume rm -f "$vol" >/dev/null 2>&1 || true
  rm -rf "$tmp"
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  main "$@"
fi
