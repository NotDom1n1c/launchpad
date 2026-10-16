#!/usr/bin/env bash
# Renders the shared pipeline with an app-specific test block.
#   scripts/render-pipeline.sh <test-block-file> <output-file>
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
python3 - "$here/pipeline.tmpl.yml" "$1" "$2" <<'PY'
import sys
tmpl, block, out = sys.argv[1:]
body = open(block, encoding="utf8").read().rstrip("\n")
open(out, "w", encoding="utf8", newline="\n").write(open(tmpl, encoding="utf8").read().replace("__TEST__", body))
PY
