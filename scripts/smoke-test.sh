#!/usr/bin/env bash
# Proves the platform works end to end. Used locally and by the e2e workflow.
set -uo pipefail

fail=0
ok()  { printf '  \033[32mPASS\033[0m %s\n' "$*"; }
bad() { printf '  \033[31mFAIL\033[0m %s\n' "$*"; fail=1; }

http_code() { curl -s -o /dev/null -w '%{http_code}' --max-time 10 -H "Host: $1" "http://127.0.0.1${2:-/}"; }

echo "Argo CD applications"
while read -r name sync health; do
  if [ "$sync" = "Synced" ] && [ "$health" = "Healthy" ]; then ok "$name"; else bad "$name ($sync / $health)"; fi
done < <(kubectl -n argocd get applications -o custom-columns='A:.metadata.name,S:.status.sync.status,H:.status.health.status' --no-headers)

echo "Ingress: every host in the cluster answers through Traefik"
for host in $(kubectl get ingress -A -o jsonpath='{range .items[*]}{.spec.rules[0].host}{"
"}{end}' | sort -u); do
  code=$(http_code "$host")
  case "$code" in 200|302) ok "$host -> $code" ;; *) bad "$host -> $code" ;; esac
done
code=$(http_code launchpad.localhost /api/overview)
[ "$code" = "200" ] && ok "portal API /api/overview -> 200" || bad "portal API /api/overview -> $code"

echo "Observability"
kubectl -n monitoring port-forward svc/kps-prometheus 19090:9090 >/dev/null 2>&1 &
pf1=$!
kubectl -n monitoring port-forward svc/loki 13100:3100 >/dev/null 2>&1 &
pf2=$!
trap 'kill $pf1 $pf2 2>/dev/null' EXIT
sleep 4

# make some traffic, then give Prometheus a scrape interval to see it
for i in $(seq 1 20); do http_code steuerrechner.localhost >/dev/null; done
prom() { curl -s --max-time 10 "http://127.0.0.1:19090/api/v1/query" --data-urlencode "query=$1" | grep -o '"result":\[[^]]*' | grep -q '"value"'; }
for _ in $(seq 1 12); do prom 'traefik_service_requests_total{service=~"steuerrechner-.*"}' && break; sleep 5; done
prom 'traefik_service_requests_total{service=~"steuerrechner-.*"}' && ok "Prometheus sees Traefik request metrics" || bad "no Traefik request metrics"
prom 'up{job="kube-state-metrics"} == 1' && ok "kube-state-metrics is scraped" || bad "kube-state-metrics not scraped"
prom 'argocd_app_info' && ok "Argo CD app metrics are scraped" || bad "no Argo CD metrics"
rules=$(curl -s "http://127.0.0.1:19090/api/v1/rules" | grep -o 'LaunchpadAppDown' | head -1)
[ -n "$rules" ] && ok "LAUNCHPAD alert rules are loaded" || bad "alert rules missing"

for _ in $(seq 1 12); do
  logs=$(curl -s -G --max-time 10 "http://127.0.0.1:13100/loki/api/v1/query_range" --data-urlencode 'query={namespace="kube-system"}' --data-urlencode 'limit=5')
  echo "$logs" | grep -q '"values":\[\[' && break; sleep 5
done
echo "$logs" | grep -q '"values":\[\[' && ok "Loki receives pod logs" || bad "Loki has no logs"

echo
if [ "$fail" -eq 0 ]; then echo "All checks passed."; else echo "Some checks failed."; fi
exit "$fail"
