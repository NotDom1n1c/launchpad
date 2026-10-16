// LAUNCHPAD portal: static UI + a small JSON API in front of GitHub and Argo CD.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { createPlatform } from "../public/core/platform.js";
import { createWorld } from "../public/core/fakes.js";
import { createGitHub } from "./github.js";
import { createKube } from "./kube.js";

const PUBLIC = fileURLToPath(new URL("../public/", import.meta.url));
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json" };
const HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "content-security-policy": "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
};

function readToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  const file = process.env.GITHUB_TOKEN_FILE || "/var/run/secrets/launchpad/token";
  return existsSync(file) ? readFileSync(file, "utf8").trim() : "";
}

export function createApp(options = {}) {
  const demo = options.demo ?? process.env.LAUNCHPAD_DEMO === "1";
  const owner = options.owner || process.env.GITHUB_OWNER || "NotDom1n1c";
  const links = {
    argocd: process.env.ARGOCD_URL || "http://argocd.localhost",
    grafana: process.env.GRAFANA_URL || "http://grafana.localhost",
    github: `https://github.com/${owner}`,
  };

  const metrics = { requests: new Map(), created: 0, failed: 0 };
  const onEvent = (type) => { if (type === "job_done") metrics.created++; if (type === "job_failed") metrics.failed++; };

  let clients;
  if (options.github && options.kube) clients = { github: options.github, kube: options.kube };
  else if (demo) clients = createWorld({ owner, speed: 1 });
  else clients = { github: createGitHub({ token: readToken(), owner }), kube: createKube() };

  const platform = createPlatform({
    ...clients,
    owner,
    gitopsRepo: process.env.GITOPS_REPO || "launchpad",
    pollMs: options.pollMs ?? (demo ? 1000 : 5000),
    onEvent,
  });

  function send(res, status, body, headers = {}) {
    const isJson = typeof body !== "string" && !Buffer.isBuffer(body);
    res.writeHead(status, { ...HEADERS, ...(isJson ? { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } : {}), ...headers });
    res.end(isJson ? JSON.stringify(body) : body);
  }

  async function readJson(req) {
    if (!String(req.headers["content-type"] || "").startsWith("application/json")) {
      // Browsers cannot send JSON cross-site without a CORS preflight, which we never allow.
      throw Object.assign(new Error("Send JSON."), { status: 415 });
    }
    let raw = "";
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 10_000) throw Object.assign(new Error("Body too large."), { status: 413 });
    }
    try { return JSON.parse(raw || "{}"); } catch { throw Object.assign(new Error("Invalid JSON."), { status: 400 }); }
  }

  function promMetrics() {
    const out = ["# TYPE portal_http_requests_total counter"];
    for (const [k, v] of metrics.requests) {
      const [method, route, code] = k.split(" ");
      out.push(`portal_http_requests_total{method="${method}",route="${route}",code="${code}"} ${v}`);
    }
    out.push("# TYPE launchpad_apps_created_total counter", `launchpad_apps_created_total ${metrics.created}`);
    out.push("# TYPE launchpad_app_creations_failed_total counter", `launchpad_app_creations_failed_total ${metrics.failed}`);
    return out.join("\n") + "\n";
  }

  async function api(req, res, path) {
    const m = req.method;
    if (m === "GET" && path === "/api/overview") return send(res, 200, { ...(await platform.overview()), links, demo });
    if (m === "GET" && path === "/api/templates") return send(res, 200, platform.templates);
    if (m === "POST" && path === "/api/apps") return send(res, 202, await platform.createApp(await readJson(req)));

    let match;
    if (m === "GET" && (match = path.match(/^\/api\/jobs\/([\w-]+)$/))) {
      const job = platform.getJob(match[1]);
      return job ? send(res, 200, job) : send(res, 404, { error: "No such job." });
    }
    if (m === "POST" && (match = path.match(/^\/api\/apps\/([a-z0-9-]+)\/sync$/))) {
      await readJson(req);
      return send(res, 200, await platform.syncApp(match[1]));
    }
    if (m === "DELETE" && (match = path.match(/^\/api\/apps\/([a-z0-9-]+)$/))) {
      await readJson(req);
      return send(res, 200, await platform.removeApp(match[1]));
    }
    return send(res, 404, { error: "Not found." });
  }

  async function serveStatic(res, path) {
    const file = normalize(join(PUBLIC, path === "/" ? "index.html" : path));
    if (!file.startsWith(normalize(PUBLIC))) return send(res, 403, "Forbidden", { "content-type": "text/plain" });
    try {
      const body = await readFile(file);
      send(res, 200, body, { "content-type": TYPES[extname(file)] || "application/octet-stream", "cache-control": "no-cache" });
    } catch {
      send(res, 404, "Not found", { "content-type": "text/plain" });
    }
  }

  return async function handler(req, res) {
    const path = new URL(req.url, "http://portal").pathname;
    const route = path.startsWith("/api/jobs/") ? "/api/jobs/:id" : path.startsWith("/api/") ? path.replace(/\/[a-z0-9-]+\/(sync)$/, "/:name/$1") : path.startsWith("/api") ? path : "static";
    res.on("finish", () => {
      const key = `${req.method} ${route} ${res.statusCode}`;
      metrics.requests.set(key, (metrics.requests.get(key) || 0) + 1);
    });
    try {
      if (path === "/healthz") return send(res, 200, { status: "ok" });
      if (path === "/metrics") return send(res, 200, promMetrics(), { "content-type": "text/plain; version=0.0.4" });
      if (path.startsWith("/api/")) return await api(req, res, path);
      if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, { error: "Method not allowed." });
      return await serveStatic(res, path);
    } catch (err) {
      const status = err.status && err.status < 600 ? err.status : 500;
      if (status >= 500) console.error(err);
      return send(res, status, { error: String(err.message || err) });
    }
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 8080);
  const server = createServer(createApp());
  server.listen(port, () => console.log(`LAUNCHPAD portal on :${port}${process.env.LAUNCHPAD_DEMO === "1" ? " (demo mode)" : ""}`));
  process.on("SIGTERM", () => server.close(() => process.exit(0)));
}
