#!/usr/bin/env bash
# Rebuild and verify the bundled GitHub Action in a credential-free container.
# Threat model: docs/adr/0021-credential-free-action-rebuild.md
set -euo pipefail

IMAGE="node:22-bookworm@sha256:0e5f906573693feaa1e21057ebdcfdb5bd5021f050b2dc7c9deceb629c7da2a8"

MAX_BUNDLE_BYTES=$((50 * 1024 * 1024))

# Print container output with every control byte made visible (ESC as ^[, CR as
# ^M, high bytes as M-x). The build inside the container is untrusted, and raw
# escape sequences reaching the terminal could rewrite the clipboard, the window
# title or earlier lines, for example to fake a success message.
sanitize_output() {
  LC_ALL=C cat -v
}

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

import_bundle() {
  local tarfile="$1" dest="$2" work="$3"
  local -a offenders=() missing=() names=() types=()
  local name type i component has_parent has_dot dir
  local -a parts=()
  local -A expected=() allowed=() seen=() seen_listing=()

  if ! git -C "$dest" ls-files -z -- dist/action >"$work/expected"; then
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
  done <"$work/expected"
  allowed[dist]=1
  allowed[dist/action]=1

  # Listing pass. Write both listings to files and check the exits: in a process
  # substitution a tar failure is silent. Every read goes through stdin, because
  # GNU tar decompresses gzip, xz or zstd on its own when it reads a named file,
  # and refuses a compressed archive on stdin. A small compressed bundle could
  # otherwise expand past the cap during extraction.
  if ! tar -tf - <"$tarfile" >"$work/tar-names"; then
    printf 'error: could not read the bundle listing (truncated or corrupt archive)\n' >&2
    return 1
  fi
  # --numeric-owner prints owner and group as numbers. The names come from the
  # archive and may hold spaces, which would shift the size column below.
  if ! tar --numeric-owner -tvf - <"$tarfile" >"$work/tar-list"; then
    printf 'error: could not read the bundle listing (truncated or corrupt archive)\n' >&2
    return 1
  fi

  # The third column of `tar -tvf` is the member size, the logical size for a
  # sparse member, so the sum bounds what extraction writes.
  local total
  if ! total="$(awk '{ sum += $3 } END { printf "%d", sum }' "$work/tar-list")"; then
    printf 'error: could not sum the bundle member sizes\n' >&2
    return 1
  fi
  if ((total > ${MAX_EXTRACTED_BYTES:-$MAX_BUNDLE_BYTES})); then
    printf 'error: the bundle members total %s bytes, over the %s byte cap\n' "$total" "${MAX_EXTRACTED_BYTES:-$MAX_BUNDLE_BYTES}" >&2
    return 1
  fi
  while IFS= read -r name; do
    while [[ "$name" == */ ]]; do name="${name%/}"; done
    names+=("$name")
  done <"$work/tar-names"
  while IFS= read -r type; do types+=("${type:0:1}"); done <"$work/tar-list"
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

  local extract="$work/extract"
  rm -rf "$extract"
  mkdir -p "$extract"
  if ! tar -x -f - -C "$extract" --no-same-owner --no-same-permissions <"$tarfile"; then
    printf 'error: could not extract the bundle\n' >&2
    return 1
  fi
  # A mode-000 directory would stop find from descending, and find's error was
  # not fatal. Make the tree readable first, and check that too.
  if ! chmod -R u+rwX "$extract"; then
    printf 'error: could not make the extracted bundle readable\n' >&2
    return 1
  fi
  if ! find "$extract" -mindepth 1 -printf '%y %P\n' >"$work/extract-find"; then
    printf 'error: could not inspect the extracted bundle\n' >&2
    return 1
  fi

  # Check the size again on disk, where the archive cannot misreport it.
  local extracted
  if ! extracted="$(find "$extract" -type f -printf '%s\n' | awk '{ sum += $1 } END { printf "%d", sum }')"; then
    printf 'error: could not sum the extracted bundle size\n' >&2
    return 1
  fi
  if ((extracted > ${MAX_EXTRACTED_BYTES:-$MAX_BUNDLE_BYTES})); then
    printf 'error: the extracted bundle holds %s bytes, over the %s byte cap\n' "$extracted" "${MAX_EXTRACTED_BYTES:-$MAX_BUNDLE_BYTES}" >&2
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
  done <"$work/extract-find"

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

sandbox_docker_flags() {
  printf '%s\n' \
    --rm --user node \
    -e HOME=/tmp/home \
    -e npm_config_cache=/tmp/npm-cache \
    -e NO_COLOR=1 \
    -e FORCE_COLOR=0 \
    -v "$1":/w \
    -w /w
}

run_sandbox() {
  local vol="$1"
  local -a common
  mapfile -t common < <(sandbox_docker_flags "$vol")

  printf 'initializing the sandbox volume\n'
  # Docker fills a volume from the image on each mount while the volume stays
  # empty, and that resets the owner of /w to root. The marker entry keeps the
  # volume non-empty, so the chown sticks for the next containers. The marker
  # never leaves the sandbox: only dist/action is streamed back.
  docker run --rm --user root -v "$vol":/w -w /w "$IMAGE" \
    sh -c 'chown node:node /w && touch /w/.sandbox-keep' 2>&1 | sanitize_output

  printf 'step 1/3: install dependencies from git archive HEAD (network allowed)\n'
  git archive --format=tar HEAD |
    docker run -i "${common[@]}" "$IMAGE" sh -c 'tar -x -f - && npm ci --ignore-scripts' 2>&1 |
    sanitize_output
}

stream_bundle_capped() {
  local vol="$1" out="$2"
  local -a common
  mapfile -t common < <(sandbox_docker_flags "$vol")

  printf 'step 2/3: rebuild and verify, no network\n'
  # The container's stdout (fd 3) carries the bundle to head; its stderr goes
  # through sanitize_output to the terminal.
  local rc=0
  {
    docker run "${common[@]}" --network none "$IMAGE" sh -c \
      '{ npm run package:action && npm run typecheck && npm run lint && npm run format:check && npm test && npm run check:deps; } 1>&2 && tar -c -f - dist/action' \
      2>&1 1>&3 3>&- | sanitize_output >&2 3>&-
  } 3>&1 |
    head -c $((MAX_BUNDLE_BYTES + 1)) >"$out" || rc=$?
  if ((rc != 0)); then
    if ! bundle_within_cap "$out"; then
      printf 'error: the bundle is over the %s byte cap; the checkout is unchanged\n' "$MAX_BUNDLE_BYTES" >&2
      return 1
    fi
    printf 'error: the rebuild or a check failed; the checkout is unchanged\n' >&2
    return 1
  fi
}

cleanup_sandbox() {
  local vol="$1" tmp="$2"
  local ids attempt
  local -a id_list
  # A container killed by SIGPIPE at the cap can outlive its docker client, and
  # a --rm container may still be removing itself, so the volume can be in use
  # for a few seconds. Retry for up to ten seconds, then warn about what is left.
  for attempt in 1 2 3 4 5 6 7 8 9 10; do
    ids="$(docker ps -aq --filter "volume=$vol")" || ids="unknown"
    if [[ -z "$ids" ]] && docker volume rm -f "$vol" >/dev/null 2>&1; then
      break
    fi
    if [[ -n "$ids" && "$ids" != "unknown" ]]; then
      mapfile -t id_list <<<"$ids"
      docker rm -f "${id_list[@]}" >/dev/null 2>&1 || :
    fi
    sleep 1
  done
  if docker volume inspect "$vol" >/dev/null 2>&1; then
    printf 'warning: could not remove the sandbox volume %s after %s attempts; remove it with docker volume rm\n' "$vol" "$attempt" >&2
  fi
  rm -rf "$tmp"
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

  # The EXIT trap runs after main returns, so it reads these globals.
  SANDBOX_VOL="capdelta-sandbox-$$-$RANDOM"
  SANDBOX_TMP="$(mktemp -d)"
  trap 'cleanup_sandbox "$SANDBOX_VOL" "$SANDBOX_TMP"' EXIT

  run_sandbox "$SANDBOX_VOL"
  stream_bundle_capped "$SANDBOX_VOL" "$SANDBOX_TMP/bundle.tar"

  printf 'step 3/3: import dist/action from the bundle\n'
  if ! import_bundle "$SANDBOX_TMP/bundle.tar" "$PWD" "$SANDBOX_TMP"; then
    printf 'error: the bundle was rejected; the checkout is unchanged\n' >&2
    return 1
  fi

  printf '\nthe checkout changed only under dist/action\n'
  git diff --stat -- dist/action
  printf '\nreview the diff above, then commit and push the change by hand\n'
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  main "$@"
fi
