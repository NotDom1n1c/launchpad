#!/usr/bin/env bash
# Assembles the public playground for GitHub Pages:
#   portal UI + screenshots + the real template files (dot-files renamed, Pages hides them)
#   scripts/build-demo-site.sh <out-dir>
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
out="${1:?usage: build-demo-site.sh <out-dir>}"
rm -rf "$out"; mkdir -p "$out"
cp -r "$root/portal/public/." "$out/"
cp -r "$root/docs/screenshots" "$out/screenshots" 2>/dev/null || true
for t in static-site node-api; do
  (cd "$root/templates/$t" && find . -type f) | while read -r f; do
    dest="$out/templates/$t/$(echo "${f#./}" | sed -E 's#(^|/)\.#\1_#g')"
    mkdir -p "$(dirname "$dest")"; cp "$root/templates/$t/$f" "$dest"
  done
done
touch "$out/.nojekyll"
echo "demo site in $out"
