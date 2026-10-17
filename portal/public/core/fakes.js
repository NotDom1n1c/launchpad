// In-memory GitHub + Kubernetes that behave like the real ones, only faster.
// Used by the unit tests, `npm run demo`, and the public browser demo (the playground).

const min = 60 * 1000;

// pipeline timing (scaled by `speed`): queued -> running -> image pushed + tag committed
export const RUN_QUEUED_MS = 2500;
export const RUN_TOTAL_MS = 14000;
const PICKUP_MS = 1500; // Argo CD notices the tag commit
const ROLLOUT_MS = 4500; // new pod ready
export const RUN_FAIL_MS = 5000; // a failing test step ends the run here

export function sha(seed) {
  let h = 2166136261;
  for (const c of String(seed)) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return (h >>> 0).toString(16).padStart(8, "0") + "c0ffee1";
}

function app({ name, tenant, template, description, owner, health = "Healthy", sync = "Synced", tag, at }) {
  const image = tenant && tag ? `ghcr.io/${owner.toLowerCase()}/${name}:${tag}` : "";
  const labels = tenant ? { "launchpad.dev/tenant": "true", "launchpad.dev/template": template } : {};
  const annotations = tenant ? { "launchpad.dev/repo": `https://github.com/${owner}/${name}`, "launchpad.dev/description": description } : {};
  return {
    metadata: { name, labels, annotations, creationTimestamp: new Date(at).toISOString() },
    live: { image }, // stands in for the Deployment's container image
    status: {
      health: { status: health },
      sync: { status: sync, revision: sha(name + tag) },
      summary: tenant ? { externalURLs: [`http://${name}.localhost`] } : {},
      operationState: { finishedAt: new Date(at).toISOString() },
    },
  };
}

const STUB_FILES = (templateRepo) => [
  { path: "README.md", content: "# __APP__\n\n__DESCRIPTION__\n" },
  { path: "deploy/kustomization.yaml", content: "newName: ghcr.io/__OWNER__/__APP__\nnewTag: latest\n" },
  { path: "deploy/ingress.yaml", content: "host: __APP__.localhost\n" },
  { path: templateRepo.endsWith("node") ? "src/app.js" : "index.html", content: "__APP__\n" },
  { path: ".github/workflows/launchpad.yml", content: "name: launchpad\n" },
];

export function createWorld({ owner = "NotDom1n1c", now = () => Date.now(), speed = 1, templateFiles = null } = {}) {
  const t = now();
  const apps = new Map(); // platform apps (static)
  const registered = new Map(); // tenant apps: name -> { template, description, at }
  const repos = new Map(); // name -> { files, version, runStartedAt, runCommit, runTag, liveTag, liveAt }
  const s = (ms) => ms / speed;

  for (const [name, mins] of [["platform", 300], ["apps", 300], ["monitoring", 296], ["loki", 296], ["alloy", 294], ["platform-config", 294], ["portal", 41]]) {
    apps.set(name, app({ name, tenant: false, owner, at: t - mins * min }));
  }
  const seed = [
    ["steuerrechner", "static-site", "Swiss income tax calculator for five cantons", "sha-e9b16ea", 26],
    ["gambit", "static-site", "Chess platform with its own engine, bots and puzzles", "sha-bd2e60d", 3 * 60],
    ["ember", "static-site", "Browser image editor built on Canvas", "sha-8b87cb7", 2 * 24 * 60],
    ["hello-api", "node-api", "Demo JSON API created through the LAUNCHPAD portal", "sha-e3d817e", 50],
  ];
  for (const [name, template, description, tag, mins] of seed) {
    registered.set(name, { template, description, at: t - mins * min });
    repos.set(name, { files: [], version: 1, liveTag: tag, liveAt: t - mins * min });
  }
  repos.set("launchpad", { files: [], version: 1 });

  const github = {
    ready: true,
    async repoExists(name) { return repos.has(name); },
    async generateFromTemplate(templateRepo, name) {
      const files = templateFiles ? await templateFiles(templateRepo) : STUB_FILES(templateRepo);
      repos.set(name, { createdAt: now(), version: 0, files: files.map((f) => ({ ...f })) });
    },
    async branchExists(name) { const r = repos.get(name); return Boolean(r && now() - (r.createdAt || 0) > s(1200)); },
    async readTextFiles(name) { return repos.get(name)?.files || []; },
    // a push: update files, start the pipeline for this commit
    async commitFiles(name, _branch, files) {
      const r = repos.get(name);
      for (const f of files) {
        const existing = r.files.find((x) => x.path === f.path);
        if (existing) existing.content = f.content; else r.files.push({ ...f });
      }
      r.version += 1;
      r.runCommit = sha(`${name}#${r.version}#${now()}`);
      r.runTag = `sha-${r.runCommit.slice(0, 7)}`;
      r.runStartedAt = now();
      r.runFailed = r.nextRunFails || null; // set by the playground when the code would not pass the tests
      r.nextRunFails = null;
      r.tagCommitted = false;
      return r.runCommit;
    },
    async putFile(_repo, path, content) {
      const name = path.split("/").pop().replace(/\.yaml$/, "");
      const template = /launchpad\.dev\/template: (\S+)/.exec(content)?.[1];
      const description = /launchpad\.dev\/description: "([^"]*)"/.exec(content)?.[1] || "";
      registered.set(name, { template, description, at: now() });
    },
    async deleteFile(_repo, path) {
      registered.delete(path.split("/").pop().replace(/\.yaml$/, ""));
    },
    async latestRun(name, headSha) {
      const r = repos.get(name);
      if (!r?.runStartedAt || (headSha && headSha !== r.runCommit)) return null;
      const age = now() - r.runStartedAt;
      const base = { url: `https://github.com/${owner}/${name}/actions`, startedAt: r.runStartedAt, commit: r.runCommit, tag: r.runTag, error: r.runFailed };
      if (age < s(RUN_QUEUED_MS)) return { ...base, status: "queued", conclusion: null };
      if (r.runFailed) {
        return age < s(RUN_FAIL_MS) ? { ...base, status: "in_progress", conclusion: null } : { ...base, status: "completed", conclusion: "failure" };
      }
      if (age < s(RUN_TOTAL_MS)) return { ...base, status: "in_progress", conclusion: null };
      return { ...base, status: "completed", conclusion: "success", finishedAt: r.runStartedAt + s(RUN_TOTAL_MS) };
    },
  };

  // What Argo CD would report for a tenant app right now
  function tenantState(name) {
    const reg = registered.get(name);
    const r = repos.get(name);
    const now_ = now();
    const builtAt = r.runStartedAt && !r.runFailed ? r.runStartedAt + s(RUN_TOTAL_MS) : null;
    let health, sync = "Synced";

    // the pipeline's last step commits the new tag into deploy/ (that is what Argo CD syncs)
    if (builtAt && now_ >= builtAt && !r.tagCommitted) {
      const k = r.files.find((f) => f.path === "deploy/kustomization.yaml");
      if (k) k.content = k.content.replace(/newTag: .*/, `newTag: ${r.runTag}`);
      r.tagCommitted = true;
    }

    if (builtAt && now_ >= builtAt + s(PICKUP_MS) + s(ROLLOUT_MS)) {
      r.liveTag = r.runTag; // rollout finished: the new version is live
      r.liveAt = builtAt + s(PICKUP_MS) + s(ROLLOUT_MS);
    }
    let tag = r.liveTag;
    if (builtAt && now_ >= builtAt + s(PICKUP_MS) && now_ < builtAt + s(PICKUP_MS) + s(ROLLOUT_MS)) {
      tag = r.runTag;
      health = "Progressing";
    } else if (r.liveTag) {
      health = "Healthy";
    } else if (now_ - reg.at > s(PICKUP_MS)) {
      health = "Progressing"; // registered, waiting for the first image
    } else {
      health = "Missing";
      sync = "OutOfSync";
    }
    return app({ name, tenant: true, template: reg.template, description: reg.description, owner, health, sync, tag: tag || "latest", at: r.liveAt || reg.at });
  }

  function all() {
    return [...apps.values(), ...[...registered.keys()].map(tenantState)];
  }

  const kube = {
    async listApplications() { return all(); },
    async getApplication(name) { return registered.has(name) ? tenantState(name) : apps.get(name) || null; },
    async deploymentImages() {
      return Object.fromEntries(all().filter((a) => a.live.image).map((a) => [a.metadata.name, a.live.image]));
    },
    async refresh() { return true; },
  };

  return { github, kube, owner, repos, registered };
}
