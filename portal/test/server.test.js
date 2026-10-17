import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createApp } from "../src/server.js";
import { createWorld } from "../public/core/fakes.js";

let server, base;

before(async () => {
  const world = createWorld({ owner: "NotDom1n1c" });
  server = createServer(createApp({ github: world.github, kube: world.kube, pollMs: 10 }));
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

test("serves the UI with security headers", async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /LAUNCHPAD/);
  assert.match(res.headers.get("content-security-policy"), /default-src 'self'/);
  assert.equal(res.headers.get("x-frame-options"), "DENY");
});

test("blocks path traversal", async () => {
  const res = await fetch(`${base}/..%2f..%2fpackage.json`);
  assert.notEqual(res.status, 200);
});

test("health and metrics endpoints", async () => {
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
  const text = await (await fetch(`${base}/metrics`)).text();
  assert.match(text, /portal_http_requests_total/);
  assert.match(text, /launchpad_apps_created_total/);
});

test("overview returns apps, platform and links", async () => {
  const o = await (await fetch(`${base}/api/overview`)).json();
  assert.equal(o.apps.length, 4);
  assert.equal(o.links.argocd, "http://argocd.localhost");
  assert.equal(o.canCreate, true);
});

test("create requires JSON (cheap CSRF protection)", async () => {
  const res = await fetch(`${base}/api/apps`, { method: "POST", body: "name=x", headers: { "content-type": "application/x-www-form-urlencoded" } });
  assert.equal(res.status, 415);
});

test("create validates and returns a job", async () => {
  const bad = await fetch(`${base}/api/apps`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Bad Name", template: "static-site" }) });
  assert.equal(bad.status, 400);

  const ok = await fetch(`${base}/api/apps`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "weather-api", template: "node-api" }) });
  assert.equal(ok.status, 202);
  const job = await ok.json();
  const again = await (await fetch(`${base}/api/jobs/${job.id}`)).json();
  assert.equal(again.name, "weather-api");
});

test("unknown API routes are 404 JSON", async () => {
  const res = await fetch(`${base}/api/nope`);
  assert.equal(res.status, 404);
  assert.ok((await res.json()).error);
});
