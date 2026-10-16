#!/usr/bin/env bash
# Break an app on purpose and watch the platform heal it.
#   scripts/chaos.sh <app>     e.g. scripts/chaos.sh gambit
set -euo pipefail
app="${1:?usage: chaos.sh <app>}"

echo "1) Someone scales $app to 0 by hand (drift from Git)"
kubectl -n "$app" scale deployment "$app" --replicas=0
kubectl -n "$app" get deployment "$app"

echo
echo "2) Argo CD self-heal puts Git's state back (watching for 90 s)"
for i in $(seq 1 18); do
  ready=$(kubectl -n "$app" get deployment "$app" -o jsonpath='{.status.readyReplicas}')
  printf '   t+%3ss  ready replicas: %s\n' $((i * 5)) "${ready:-0}"
  [ "${ready:-0}" -ge 1 ] && { echo "   healed."; break; }
  sleep 5
done

echo
echo "3) A pod gets killed"
kubectl -n "$app" delete pod -l "app.kubernetes.io/name=$app" --wait=false
sleep 3
kubectl -n "$app" get pods
echo "   Kubernetes starts a replacement right away. Check the restarts panel in Grafana."
