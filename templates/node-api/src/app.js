// __APP__: a small JSON API, created with LAUNCHPAD.
// No dependencies: plain node:http, so the image stays tiny and has almost nothing to scan.

const started = Date.now();

// request counters for /metrics, keyed by "method route status"
const counters = new Map();

function count(method, route, status) {
  const key = `${method} ${route} ${status}`;
  counters.set(key, (counters.get(key) || 0) + 1);
}

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

// Prometheus text format, read by the ServiceMonitor in deploy/
function metrics() {
  const lines = [
    "# HELP http_requests_total Requests handled, by method, route and status.",
    "# TYPE http_requests_total counter",
  ];
  for (const [key, value] of counters) {
    const [method, route, status] = key.split(" ");
    lines.push(`http_requests_total{method="${method}",route="${route}",status="${status}"} ${value}`);
  }
  lines.push(
    "# HELP app_uptime_seconds Seconds since the process started.",
    "# TYPE app_uptime_seconds gauge",
    `app_uptime_seconds ${((Date.now() - started) / 1000).toFixed(0)}`,
  );
  return lines.join("\n") + "\n";
}

const routes = {
  "/": () => [200, { app: "__APP__", message: "Hello from LAUNCHPAD", docs: ["/healthz", "/metrics", "/api/time"] }],
  "/healthz": () => [200, { status: "ok" }],
  "/api/time": () => [200, { now: new Date().toISOString(), uptimeSeconds: Math.round((Date.now() - started) / 1000) }],
};

export function handler(req, res) {
  const { pathname } = new URL(req.url, "http://localhost");

  if (req.method === "GET" && pathname === "/metrics") {
    count(req.method, pathname, 200);
    res.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
    return res.end(metrics());
  }

  const route = routes[pathname];
  if (req.method !== "GET" || !route) {
    count(req.method, "other", 404);
    return json(res, 404, { error: "not found" });
  }

  const [status, body] = route();
  count(req.method, pathname, status);
  json(res, status, body);
}
