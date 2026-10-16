import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { handler } from "../src/app.js";

let server, base;

before(async () => {
  server = createServer(handler);
  await new Promise((done) => server.listen(0, done));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

test("health check answers ok", async () => {
  const res = await fetch(`${base}/healthz`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: "ok" });
});

test("root names the app", async () => {
  const body = await (await fetch(`${base}/`)).json();
  assert.equal(body.app, "__APP__");
});

test("unknown routes are 404", async () => {
  const res = await fetch(`${base}/nope`);
  assert.equal(res.status, 404);
});

test("metrics count requests in Prometheus format", async () => {
  await fetch(`${base}/api/time`);
  const text = await (await fetch(`${base}/metrics`)).text();
  assert.match(text, /# TYPE http_requests_total counter/);
  assert.match(text, /http_requests_total\{method="GET",route="\/api\/time",status="200"\} \d+/);
});
