#!/usr/bin/env bash
# Deletes the cluster completely. Git still has everything: scripts/up.sh brings it all back.
set -euo pipefail
k3d cluster delete launchpad
rm -f "$(dirname "$0")/../.launchpad/registries.yaml"
