#!/usr/bin/env bash
# Installs (or shares) node_modules for the current checkout. Run via
# `mise run setup`, and automatically on `cd` once mise shell activation is
# wired up (see [hooks].enter in .mise.toml). Every location is derived from
# git, so this works from the primary checkout, any linked worktree, or a
# throwaway clone.
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
common_dir="$(git rev-parse --git-common-dir)"
main_root="$(dirname "$(realpath "$common_dir")")"

cd "$repo_root"

hash_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

stamp_path="node_modules/.mise-setup-stamp"
current_hash="$(hash_file package-lock.json)"

# Idempotency: this runs on every `cd` into a mise-activated checkout, so the
# no-op path has to be fast. Skip entirely once node_modules matches the
# current lockfile.
if [ -e node_modules ] && [ -f "$stamp_path" ] && [ "$(cat "$stamp_path")" = "$current_hash" ]; then
  exit 0
fi

if [ "$main_root" = "$repo_root" ]; then
  echo "mise-setup-deps: primary checkout ($repo_root), running npm ci"
  npm ci
  echo "$current_hash" > "$stamp_path"
  exit 0
fi

# A linked worktree: symlink the primary checkout's node_modules when its
# lockfile is byte-identical to ours (a branch that has not touched
# package.json or package-lock.json). Otherwise run a real, isolated npm ci,
# so a worktree that needs different dependencies never shares the wrong tree.
main_lock="$main_root/package-lock.json"

if [ -d "$main_root/node_modules" ] && cmp -s "$main_lock" package-lock.json; then
  echo "mise-setup-deps: worktree lockfile matches the primary checkout ($main_root), symlinking node_modules"
  rm -rf node_modules
  ln -s "$main_root/node_modules" node_modules
  echo "$current_hash" > "$stamp_path"
else
  echo "mise-setup-deps: worktree lockfile differs from the primary checkout (or it has no node_modules), running npm ci in $repo_root"
  npm ci
  echo "$current_hash" > "$stamp_path"
fi
