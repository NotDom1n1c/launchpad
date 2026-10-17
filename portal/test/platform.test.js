import { test } from "node:test";
import assert from "node:assert/strict";
import { createPlatform, validateName, cleanDescription, applicationManifest, summarizeApp } from "../public/core/platform.js";
import { createWorld } from "../public/core/fakes.js";

// A clock we control, so the simulated pipeline "takes" seconds without waiting
function fakeClock() {
  let t = Date.parse("2026-10-17T10:00:00Z");
  return { now: () => t, sleep: async (ms) => { t += ms; } };
}

function setup() {
  const clock = fakeClock();
  const world = createWorld({ owner: "NotDom1n1c", now: clock.now });
  const platform = createPlatform({ ...world, owner: "NotDom1n1c", pollMs: 500, ...clock });
  return { platform, world, clock };
}

async function finish(platform, id) {
  for (let i = 0; i < 1000; i++) {
    const job = platform.getJob(id);
    if (job.status !== "running") return job;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error("job never finished");
}

test("names: valid, reserved, taken and malformed", () => {
  assert.equal(validateName("weather-api"), null);
  assert.match(validateName("ab"), /3 to 30/);
  assert.match(validateName("Weather"), /Lowercase/);
  assert.match(validateName("-api"), /Lowercase/);
  assert.match(validateName("api-"), /Lowercase/);
  assert.match(validateName("my--api"), /double/);
  assert.match(validateName("grafana"), /reserved/);
  assert.match(validateName("gambit", ["gambit"]), /already exists/);
});

test("descriptions cannot break HTML, JSON or YAML", () => {
  assert.equal(cleanDescription('<script>alert("x")</script>'), "scriptalert(x)/script");
  assert.equal(cleanDescription("line\nbreak"), "line break");
  assert.equal(cleanDescription(""), "Created with LAUNCHPAD");
  assert.equal(cleanDescription("x".repeat(500)).length, 120);
});

test("Argo CD Application manifest points at the app repo and the tenants project", () => {
  const yaml = applicationManifest({ name: "demo", template: "node-api", description: "hi", owner: "NotDom1n1c" });
  assert.match(yaml, /name: demo/);
  assert.match(yaml, /project: tenants/);
  assert.match(yaml, /repoURL: https:\/\/github.com\/NotDom1n1c\/demo.git/);
  assert.match(yaml, /path: deploy/);
  assert.match(yaml, /namespace: demo/);
});

test("summarizeApp reads health, sync and image tag", () => {
  const s = summarizeApp({
    metadata: { name: "x", labels: { "launchpad.dev/tenant": "true" }, annotations: {} },
    status: { health: { status: "Healthy" }, sync: { status: "Synced", revision: "abcdef123456" }, summary: { images: ["ghcr.io/a/x:sha-1234567"] } },
  });
  assert.equal(s.tag, "sha-1234567");
  assert.equal(s.revision, "abcdef1");
  assert.equal(s.url, "http://x.localhost");
});

test("overview lists tenant apps separately from platform apps", async () => {
  const { platform } = setup();
  const o = await platform.overview();
  assert.deepEqual(o.apps.map((a) => a.name), ["ember", "gambit", "hello-api", "steuerrechner"]);
  assert.ok(o.platform.some((a) => a.name === "monitoring"));
  assert.equal(o.stats.apps, 4);
  assert.equal(o.stats.healthy, 4);
});

test("creating an app walks all five steps and ends healthy", async () => {
  const { platform } = setup();
  const job = await platform.createApp({ name: "weather-api", template: "node-api", description: "Weather <b>now</b>" });
  assert.equal(job.status, "running");
  const done = await finish(platform, job.id);
  assert.equal(done.status, "done", done.error);
  assert.deepEqual(done.steps.map((s) => s.state), ["done", "done", "done", "done", "done"]);
  const o = await platform.overview();
  const app = o.apps.find((a) => a.name === "weather-api");
  assert.equal(app.health, "Healthy");
  assert.equal(app.description, "Weather bnow/b");
  assert.match(app.tag, /^sha-/);
});

test("personalize replaces every placeholder", async () => {
  const { platform, world } = setup();
  const job = await platform.createApp({ name: "shop", template: "static-site" });
  await finish(platform, job.id);
  const files = await world.github.readTextFiles("shop");
  for (const f of files) assert.doesNotMatch(f.content, /__APP__|__OWNER__|__DESCRIPTION__/, f.path);
  assert.match(files.find((f) => f.path === "deploy/kustomization.yaml").content, /ghcr.io\/notdom1n1c\/shop/);
});

test("refuses duplicates, reserved names and unknown templates", async () => {
  const { platform } = setup();
  await assert.rejects(platform.createApp({ name: "gambit", template: "static-site" }), /already exists/);
  await assert.rejects(platform.createApp({ name: "argocd", template: "static-site" }), /reserved/);
  await assert.rejects(platform.createApp({ name: "fine-name", template: "php" }), /Unknown template/);
});

test("a failing pipeline fails the job with a clear message", async () => {
  const { platform, world } = setup();
  world.github.latestRun = async () => ({ status: "completed", conclusion: "failure", url: "https://x" });
  const job = await platform.createApp({ name: "broken", template: "static-site" });
  const done = await finish(platform, job.id);
  assert.equal(done.status, "failed");
  assert.match(done.error, /Pipeline failure/);
  assert.equal(done.steps.find((s) => s.id === "build").state, "failed");
  assert.equal(done.steps.find((s) => s.id === "deploy").state, "pending");
});

test("remove only works for tenant apps", async () => {
  const { platform } = setup();
  await assert.rejects(platform.removeApp("monitoring"), /Only apps created/);
  const r = await platform.removeApp("ember");
  assert.equal(r.ok, true);
  const o = await platform.overview();
  assert.ok(!o.apps.some((a) => a.name === "ember"));
});

test("without a GitHub token the portal is read-only", async () => {
  const { world } = setup();
  const platform = createPlatform({ ...world, github: { ...world.github, ready: false }, owner: "NotDom1n1c" });
  assert.equal((await platform.overview()).canCreate, false);
  await assert.rejects(platform.createApp({ name: "x-app", template: "static-site" }), /No GitHub token/);
});

test("a push to a live app rolls out a new version, a failing one keeps the old", async () => {
  const { platform, world, clock } = setup();
  const before = (await platform.overview()).apps.find((a) => a.name === "hello-api").tag;

  const commit = await world.github.commitFiles("hello-api", "main", [{ path: "src/app.js", content: "// v2" }]);
  await clock.sleep(16000); // pipeline done, Argo CD rolling out
  let app = (await platform.overview()).apps.find((a) => a.name === "hello-api");
  assert.equal(app.health, "Progressing");
  await clock.sleep(5000);
  app = (await platform.overview()).apps.find((a) => a.name === "hello-api");
  assert.equal(app.health, "Healthy");
  assert.equal(app.tag, `sha-${commit.slice(0, 7)}`);
  assert.notEqual(app.tag, before);

  world.repos.get("hello-api").nextRunFails = "SyntaxError: Unexpected token";
  await world.github.commitFiles("hello-api", "main", [{ path: "src/app.js", content: "broken(" }]);
  await clock.sleep(30000);
  const run = await world.github.latestRun("hello-api");
  assert.equal(run.conclusion, "failure");
  app = (await platform.overview()).apps.find((a) => a.name === "hello-api");
  assert.equal(app.tag, `sha-${commit.slice(0, 7)}`, "the old version keeps running");
  assert.equal(app.health, "Healthy");
});

test("personalizing never rewrites the pipeline (its guard looks for the placeholder)", async () => {
  const clock = fakeClock();
  const workflow = 'if grep -rqs "__APP__" deploy/; then skip; fi';
  const world = createWorld({
    owner: "NotDom1n1c", now: clock.now,
    templateFiles: async () => [
      { path: "deploy/ingress.yaml", content: "host: __APP__.localhost" },
      { path: ".github/workflows/launchpad.yml", content: workflow },
    ],
  });
  const platform = createPlatform({ ...world, owner: "NotDom1n1c", pollMs: 500, ...clock });
  const job = await platform.createApp({ name: "learn-code", template: "static-site" });
  await finish(platform, job.id);
  const files = await world.github.readTextFiles("learn-code");
  assert.equal(files.find((f) => f.path === ".github/workflows/launchpad.yml").content, workflow);
  assert.equal(files.find((f) => f.path === "deploy/ingress.yaml").content, "host: learn-code.localhost");
});
