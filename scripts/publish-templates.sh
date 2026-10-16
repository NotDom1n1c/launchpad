#!/usr/bin/env bash
# Publishes templates/<name> to the template repositories created by infra/github (OpenTofu).
#   static-site -> launchpad-template-static
#   node-api    -> launchpad-template-node
set -euo pipefail
cd "$(dirname "$0")/.."
OWNER="${OWNER:-NotDom1n1c}"
root="$(pwd)"

publish() {
  local src="$1" repo="$2" tmp
  tmp="$(mktemp -d)"
  git clone -q "https://github.com/$OWNER/$repo.git" "$tmp/repo" 2>/dev/null || { mkdir -p "$tmp/repo"; git -C "$tmp/repo" init -q -b main; git -C "$tmp/repo" remote add origin "https://github.com/$OWNER/$repo.git"; }
  find "$tmp/repo" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
  cp -r "$root/templates/$src/." "$tmp/repo/"
  git -C "$tmp/repo" add -A
  if git -C "$tmp/repo" diff --cached --quiet; then echo "$repo: up to date"; else
    git -C "$tmp/repo" commit -qm "Template update from launchpad@$(git -C "$root" rev-parse --short HEAD)"
    git -C "$tmp/repo" push -q origin HEAD:main
    echo "$repo: published"
  fi
  rm -rf "$tmp"
}

publish static-site launchpad-template-static
publish node-api launchpad-template-node
