// In-memory GitHub + Kubernetes that behave like the real ones, only faster.
// Used by the unit tests, `npm run demo`, and the public browser demo.

const min = 60 * 1000;

function sha(seed) {
  let h = 2166136261;
  for (const c of String(seed)) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return (h >>> 0).toString(16).padStart(8, "0") + "c0ffee1";
}

function app({ name, tenant, template, description, owner, health = "Healthy", sync = "Synced", tag, at }) {
  const labels = tenant ? { "launchpad.dev/tenant": "true", "launchpad.dev/template": template } : {};
  const annotations = tenant ? { "launchpad.dev/repo": `https://github.com/${owner}/${name}`, "launchpad.dev/description": description } : {};
  return {
    metadata: { name, labels, annotations, creationTimestamp: new Date(at).toISOString() },
    status: {
      health: { status: health },
      sync: { status: sync, revision: sha(name + tag) },
      summary: tenant
        ? { images: tag ? [`ghcr.io/${owner.toLowerCase()}/${name}:${tag}`] : [], externalURLs: [`http://${name}.localhost`] }
        : {},
      operationState: { finishedAt: new Date(at).toISOString() },
    },
  };
}

export function createWorld({ owner = "NotDom1n1c", now = () => Date.now(), speed = 1 } = {}) {
  const t = now();
  const apps = new Map();
  const add = (a) => apps.set(a.metadata.name, a);

  for (const [name, mins] of [["platform", 300], ["apps", 300], ["monitoring", 296], ["loki", 296], ["alloy", 294], ["platform-config", 294], ["portal", 41]]) {
    add(app({ name, tenant: false, owner, at: t - mins * min }));
  }
  add(app({ name: "steuerrechner", tenant: true, template: "static-site", owner, description: "Swiss income tax calculator for five cantons", tag: "sha-79aefb7", at: t - 26 * min }));
  add(app({ name: "gambit", tenant: true, template: "static-site", owner, description: "Chess platform with its own engine, bots and puzzles", tag: "sha-8160b63", at: t - 3 * 60 * min }));
  add(app({ name: "ember", tenant: true, template: "static-site", owner, description: "Browser image editor built on Canvas", tag: "sha-de5cf6f", at: t - 2 * 24 * 60 * min }));

  // repos that exist on "GitHub", and when their first pipeline started
  const repos = new Map([...apps.keys()].map((n) => [n, { files: [], runStartedAt: null }]));
  repos.set("launchpad", { files: [], runStartedAt: null });
  const registered = new Map(); // name -> { template, description, at }

  const s = (ms) => ms / speed; // scaled durations

  const github = {
    ready: true,
    async repoExists(name) { return repos.has(name); },
    async generateFromTemplate(templateRepo, name) {
      repos.set(name, {
        createdAt: now(),
        runStartedAt: null,
        files: [
          { path: "README.md", content: "# __APP__\n\n__DESCRIPTION__\n" },
          { path: "deploy/kustomization.yaml", content: "newName: ghcr.io/__OWNER__/__APP__\nnewTag: latest\n" },
          { path: "deploy/ingress.yaml", content: "host: __APP__.localhost\n" },
          { path: templateRepo.endsWith("node") ? "src/app.js" : "index.html", content: "__APP__\n" },
          { path: ".github/workflows/launchpad.yml", content: "name: launchpad\n" },
        ],
      });
    },
    async branchExists(name) { const r = repos.get(name); return Boolean(r && now() - (r.createdAt || 0) > s(1200)); },
    async readTextFiles(name) { return repos.get(name).files; },
    async commitFiles(name, _branch, files) {
      const r = repos.get(name);
      for (const f of files) r.files.find((x) => x.path === f.path).content = f.content;
      r.runStartedAt = now(); // a push starts the pipeline
    },
    async putFile(_repo, path, content) {
      const name = path.split("/").pop().replace(/\.yaml$/, "");
      const template = /launchpad\.dev\/template: (\S+)/.exec(content)?.[1];
      const description = /launchpad\.dev\/description: "([^"]*)"/.exec(content)?.[1] || "";
      registered.set(name, { template, description, at: now() });
    },
    async deleteFile(_repo, path) {
      const name = path.split("/").pop().replace(/\.yaml$/, "");
      registered.delete(name);
      apps.delete(name);
    },
    async latestRun(name) {
      const r = repos.get(name);
      if (!r?.runStartedAt) return null;
      const age = now() - r.runStartedAt;
      const url = `https://github.com/${owner}/${name}/actions`;
      if (age < s(2500)) return { status: "queued", conclusion: null, url };
      if (age < s(14000)) return { status: "in_progress", conclusion: null, url };
      return { status: "completed", conclusion: "success", url, finishedAt: r.runStartedAt + s(14000) };
    },
  };

  function tenantState(name) {
    const reg = registered.get(name);
    if (!reg) return null;
    const run = repos.get(name);
    const built = run?.runStartedAt && now() - run.runStartedAt > s(14000);
    const sinceBuild = built ? now() - (run.runStartedAt + s(14000)) : 0;
    let health = "Missing", sync = "OutOfSync", tag = "latest";
    if (now() - reg.at > s(1500)) { health = "Progressing"; sync = "Synced"; }
    if (built && sinceBuild > s(1500)) { tag = `sha-${sha(name).slice(0, 7)}`; health = "Progressing"; }
    if (built && sinceBuild > s(4500)) health = "Healthy";
    return app({ name, tenant: true, template: reg.template, description: reg.description, owner, health, sync, tag, at: built ? run.runStartedAt + s(14000) + s(4500) : reg.at });
  }

  const kube = {
    async listApplications() {
      for (const name of registered.keys()) apps.set(name, tenantState(name));
      return [...apps.values()];
    },
    async getApplication(name) {
      if (registered.has(name)) apps.set(name, tenantState(name));
      return apps.get(name) || null;
    },
    async refresh() { return true; },
  };

  return { github, kube, owner };
}
