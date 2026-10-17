#!/usr/bin/env bash
# Builds the whole LAUNCHPAD platform from nothing:
#   k3d cluster -> Argo CD -> secrets -> root apps. Argo CD installs everything else from Git.
#
# Optional environment:
#   GITHUB_TOKEN     lets the portal create repos (scripts/../launchpad.ps1 passes `gh auth token`)
#   GHCR_TOKEN       pull credentials for private ghcr.io images (token with read:packages)
#   DISCORD_WEBHOOK  where Alertmanager sends alerts
#   WAIT_MINUTES     how long to wait for everything to turn healthy (default 15)
set -euo pipefail

cd "$(dirname "$0")/.."
ARGOCD_CHART_VERSION=10.10.5
CLUSTER=launchpad
STATE=.launchpad
mkdir -p "$STATE"

step() { printf '\n\033[1;38;5;208m==> %s\033[0m\n' "$*"; }

# ---------------------------------------------------------------- cluster
if k3d cluster list -o json | grep -q "\"name\":\"$CLUSTER\""; then
  step "Cluster '$CLUSTER' exists, starting it"
  k3d cluster start "$CLUSTER" >/dev/null
else
  step "Creating cluster from cluster/k3d.yaml"
  extra=()
  if [ -n "${GHCR_TOKEN:-}" ]; then
    cat > "$STATE/registries.yaml" <<EOF
configs:
  ghcr.io:
    auth:
      username: ${GHCR_USER:-token}
      password: ${GHCR_TOKEN}
EOF
    extra+=(--registry-config "$STATE/registries.yaml")
  fi
  k3d cluster create --config cluster/k3d.yaml "${extra[@]}"
fi
kubectl config use-context "k3d-$CLUSTER" >/dev/null

# ---------------------------------------------------------------- secrets (never in Git)
step "Secrets"
for ns in argocd monitoring launchpad; do kubectl create namespace "$ns" --dry-run=client -o yaml | kubectl apply -f - >/dev/null; done

if ! kubectl -n monitoring get secret grafana-admin >/dev/null 2>&1; then
  pw="$(head -c 18 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 20)"
  kubectl -n monitoring create secret generic grafana-admin --from-literal=admin-user=admin --from-literal=admin-password="$pw" >/dev/null
fi
kubectl -n monitoring create secret generic alertmanager-discord \
  --from-literal=url="${DISCORD_WEBHOOK:-http://127.0.0.1:9/discord-not-configured}" \
  --dry-run=client -o yaml | kubectl apply -f - >/dev/null
kubectl -n launchpad create secret generic launchpad-github \
  --from-literal=token="${GITHUB_TOKEN:-}" \
  --dry-run=client -o yaml | kubectl apply -f - >/dev/null
echo "grafana-admin, alertmanager-discord, launchpad-github: ok"

# ---------------------------------------------------------------- argo cd
step "Argo CD (chart $ARGOCD_CHART_VERSION)"
helm repo add argo https://argoproj.github.io/argo-helm >/dev/null 2>&1 || true
helm repo update argo >/dev/null
for attempt in 1 2 3; do
  helm upgrade --install argocd argo/argo-cd --version "$ARGOCD_CHART_VERSION" \
    --namespace argocd -f bootstrap/argocd-values.yaml --wait --timeout 6m && break
  [ "$attempt" -eq 3 ] && { echo "Argo CD did not come up"; exit 1; }
  echo "Argo CD not ready yet (attempt $attempt), retrying"
done

step "Handing over to GitOps (bootstrap/root.yaml)"
kubectl apply -f bootstrap/root.yaml

# ---------------------------------------------------------------- wait
step "Waiting for every Application to be Synced + Healthy"
deadline=$(( $(date +%s) + ${WAIT_MINUTES:-15} * 60 ))
while :; do
  table="$(kubectl -n argocd get applications -o custom-columns='APP:.metadata.name,SYNC:.status.sync.status,HEALTH:.status.health.status' --no-headers 2>/dev/null || true)"
  total=$(printf '%s\n' "$table" | grep -c . || true)
  ready=$(printf '%s\n' "$table" | awk '$2=="Synced" && $3=="Healthy"' | grep -c . || true)
  printf '\r  %s/%s ready  ' "$ready" "$total"
  if [ "$total" -ge 10 ] && [ "$ready" -eq "$total" ]; then echo; break; fi
  if [ "$(date +%s)" -gt "$deadline" ]; then
    echo; echo "Timed out. Current state:"; printf '%s\n' "$table"; exit 1
  fi
  sleep 10
done
printf '%s\n' "$table" | awk '{ printf "  %-18s %-10s %s\n", $1, $2, $3 }'

# ---------------------------------------------------------------- done
argo_pw="$(kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' | base64 -d)"
graf_pw="$(kubectl -n monitoring get secret grafana-admin -o jsonpath='{.data.admin-password}' | base64 -d)"
cat > "$STATE/credentials.txt" <<EOF
Argo CD   http://argocd.localhost    admin / $argo_pw
Grafana   http://grafana.localhost   admin / $graf_pw
EOF

step "LAUNCHPAD is up"
cat <<EOF
  Portal        http://launchpad.localhost
  Argo CD       http://argocd.localhost      (read-only without login)
  Grafana       http://grafana.localhost     (read-only without login)
  Apps          http://steuerrechner.localhost  http://gambit.localhost  http://ember.localhost

  Admin logins are in $STATE/credentials.txt
EOF
