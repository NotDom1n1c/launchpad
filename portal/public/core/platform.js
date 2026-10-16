// The platform logic behind the portal.
// Pure JavaScript with injected clients, so the same code runs
//   - in the cluster (real GitHub + Kubernetes clients),
//   - in tests (fakes),
//   - in the browser for the public demo (fakes).

export const TEMPLATES = [
  {
    id: "static-site",
    repo: "launchpad-template-static",
    name: "Static site",
    summary: "HTML, CSS and JS served by a non-root nginx.",
    stack: ["nginx 1.30", "HTML/CSS"],
  },
  {
    id: "node-api",
    repo: "launchpad-template-node",
    name: "Node API",
    summary: "JSON API with /healthz and Prometheus /metrics, scraped automatically.",
    stack: ["Node 24", "Prometheus"],
  },
];

// Names that would collide with platform namespaces, hosts or root apps
export const RESERVED = new Set([
  "launchpad", "argocd", "grafana", "monitoring", "loki", "alloy", "portal", "platform",
  "platform-config", "apps", "default", "kube-system", "kube-public", "kube-node-lease",
]);

export const STEPS = [
  { id: "repo", label: "Create repository from template" },
  { id: "personalize", label: "Personalize manifests and code" },
  { id: "register", label: "Register with Argo CD (GitOps commit)" },
  { id: "build", label: "CI: test, build, scan, push image" },
  { id: "deploy", label: "Argo CD sync and health check" },
];

export function validateName(name, taken = []) {
  if (!name) return "Give your app a name.";
  if (name.length < 3 || name.length > 30) return "Use 3 to 30 characters.";
  if (!/^[a-z][a-z0-9-]*[a-z0-9]$/.test(name)) return "Lowercase letters, digits and dashes. Start with a letter.";
  if (name.includes("--")) return "No double dashes.";
  if (RESERVED.has(name)) return `"${name}" is reserved by the platform.`;
  if (taken.includes(name)) return `"${name}" already exists.`;
  return null;
}

// Free text ends up in HTML, JSON and YAML, so keep it to safe characters
export function cleanDescription(text) {
  return String(text || "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[<>&"'`\\{}$]/g, "")
    .trim()
    .slice(0, 120) || "Created with LAUNCHPAD";
}

export function applicationManifest({ name, template, description, owner, gitopsOwner = owner }) {
  return `# Registered on the LAUNCHPAD platform. Argo CD deploys whatever ${name}/deploy says.
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: ${name}
  namespace: argocd
  labels:
    launchpad.dev/tenant: "true"
    launchpad.dev/template: ${template}
  annotations:
    launchpad.dev/repo: https://github.com/${owner}/${name}
    launchpad.dev/description: "${description}"
  finalizers:
    - resources-finalizer.argocd.argoproj.io
spec:
  project: tenants
  source:
    repoURL: https://github.com/${owner}/${name}.git
    targetRevision: main
    path: deploy
  destination:
    server: https://kubernetes.default.svc
    namespace: ${name}
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
    syncOptions:
      - CreateNamespace=true
    retry:
      limit: 10
      backoff: { duration: 15s, factor: 2, maxDuration: 3m }
`;
}

// Turn an Argo CD Application object into what the UI needs
export function summarizeApp(app) {
  const meta = app.metadata || {};
  const labels = meta.labels || {};
  const notes = meta.annotations || {};
  const status = app.status || {};
  const image = (status.summary?.images || [])[0] || "";
  const op = status.operationState || {};
  return {
    name: meta.name,
    tenant: labels["launchpad.dev/tenant"] === "true",
    template: labels["launchpad.dev/template"] || null,
    description: notes["launchpad.dev/description"] || "",
    repo: notes["launchpad.dev/repo"] || null,
    health: status.health?.status || "Unknown",
    sync: status.sync?.status || "Unknown",
    revision: (status.sync?.revision || "").slice(0, 7),
    image,
    tag: image.includes(":") ? image.split(":").pop() : "",
    url: (status.summary?.externalURLs || [])[0] || (labels["launchpad.dev/tenant"] === "true" ? `http://${meta.name}.localhost` : null),
    deployedAt: op.finishedAt || status.reconciledAt || meta.creationTimestamp || null,
    message: status.conditions?.[0]?.message || op.message || "",
  };
}

export function createPlatform({
  github,
  kube,
  owner,
  gitopsRepo = "launchpad",
  pollMs = 5000,
  timeoutMs = 15 * 60 * 1000,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = () => Date.now(),
  onEvent = () => {},
}) {
  const jobs = new Map();
  let jobSeq = 0;

  async function listApps() {
    const items = await kube.listApplications();
    return items.map(summarizeApp);
  }

  async function overview() {
    let apps = [];
    let cluster = { connected: true, message: "" };
    try {
      apps = await listApps();
    } catch (err) {
      cluster = { connected: false, message: String(err.message || err) };
    }
    const tenants = apps.filter((a) => a.tenant).sort((a, b) => a.name.localeCompare(b.name));
    const platform = apps.filter((a) => !a.tenant).sort((a, b) => a.name.localeCompare(b.name));
    return {
      cluster,
      owner,
      gitopsRepo,
      canCreate: Boolean(github?.ready),
      apps: tenants,
      platform,
      jobs: [...jobs.values()].filter((j) => j.status === "running" || now() - j.finishedAt < 10 * 60 * 1000),
      stats: {
        apps: tenants.length,
        healthy: tenants.filter((a) => a.health === "Healthy").length,
        synced: tenants.filter((a) => a.sync === "Synced").length,
        platformHealthy: platform.every((a) => a.health === "Healthy"),
      },
    };
  }

  function newJob(name, template) {
    const job = {
      id: `job-${++jobSeq}-${name}`,
      name,
      template,
      status: "running",
      startedAt: now(),
      finishedAt: null,
      error: null,
      url: `http://${name}.localhost`,
      links: { repo: `https://github.com/${owner}/${name}` },
      steps: STEPS.map((s) => ({ ...s, state: "pending", detail: "" })),
    };
    jobs.set(job.id, job);
    return job;
  }

  async function step(job, id, fn) {
    const s = job.steps.find((x) => x.id === id);
    s.state = "running";
    s.startedAt = now();
    try {
      const detail = await fn((text) => { s.detail = text; });
      s.state = "done";
      if (detail) s.detail = detail;
    } catch (err) {
      s.state = "failed";
      s.detail = String(err.message || err);
      throw err;
    } finally {
      s.finishedAt = now();
    }
  }

  async function waitFor(check, what) {
    const end = now() + timeoutMs;
    for (;;) {
      const result = await check();
      if (result) return result;
      if (now() > end) throw new Error(`Timed out waiting for ${what}`);
      await sleep(pollMs);
    }
  }

  async function run(job, { name, template, description }) {
    const tpl = TEMPLATES.find((t) => t.id === template);
    const lowerOwner = owner.toLowerCase();

    await step(job, "repo", async () => {
      await github.generateFromTemplate(tpl.repo, name, description);
      await waitFor(() => github.branchExists(name, "main"), "the new repository");
      return `github.com/${owner}/${name}`;
    });

    await step(job, "personalize", async () => {
      const files = await github.readTextFiles(name, "main");
      const changed = [];
      for (const f of files) {
        if (!/__APP__|__OWNER__|__DESCRIPTION__/.test(f.content)) continue;
        changed.push({
          path: f.path,
          content: f.content
            .replaceAll("__APP__", name)
            .replaceAll("__OWNER__", lowerOwner)
            .replaceAll("__DESCRIPTION__", description),
        });
      }
      await github.commitFiles(name, "main", changed, `Personalize ${name} for LAUNCHPAD`);
      return `${changed.length} files updated in one commit`;
    });

    await step(job, "register", async () => {
      const path = `gitops/apps/${name}.yaml`;
      await github.putFile(gitopsRepo, path, applicationManifest({ name, template, description, owner }), `platform: register ${name}`);
      await kube.refresh("apps").catch(() => {});
      job.links.argocd = name;
      return `${gitopsRepo}/${path}`;
    });

    await step(job, "build", async (progress) => {
      const runInfo = await waitFor(async () => {
        const r = await github.latestRun(name);
        if (r) {
          job.links.pipeline = r.url;
          progress(r.status === "completed" ? r.conclusion : r.status.replace("_", " "));
        }
        return r && r.status === "completed" ? r : null;
      }, "the first pipeline run");
      if (runInfo.conclusion !== "success") throw new Error(`Pipeline ${runInfo.conclusion}. Open the run for details.`);
      return "image pushed, tag committed to deploy/";
    });

    await step(job, "deploy", async (progress) => {
      await waitFor(async () => {
        await kube.refresh(name).catch(() => {});
        const app = await kube.getApplication(name).catch(() => null);
        if (!app) { progress("waiting for Argo CD to pick up the app"); return null; }
        const s = summarizeApp(app);
        progress(`${s.sync} / ${s.health}${s.tag ? ` (${s.tag})` : ""}`);
        return s.sync === "Synced" && s.health === "Healthy" && s.tag && s.tag !== "latest" ? s : null;
      }, "Argo CD to report the app healthy");
      return `live at ${job.url}`;
    });
  }

  async function createApp(input) {
    if (!github?.ready) throw Object.assign(new Error("No GitHub token configured for the portal."), { status: 503 });
    const name = String(input?.name || "").trim();
    const template = String(input?.template || "");
    const description = cleanDescription(input?.description);

    const running = [...jobs.values()].filter((j) => j.status === "running").map((j) => j.name);
    let taken = running;
    try { taken = taken.concat((await listApps()).map((a) => a.name)); } catch { /* cluster down: GitHub check below still protects */ }
    const problem = validateName(name, taken);
    if (problem) throw Object.assign(new Error(problem), { status: 400 });
    if (!TEMPLATES.some((t) => t.id === template)) throw Object.assign(new Error("Unknown template."), { status: 400 });
    if (await github.repoExists(name)) throw Object.assign(new Error(`github.com/${owner}/${name} already exists.`), { status: 409 });

    const job = newJob(name, template);
    onEvent("job_started", job);
    run(job, { name, template, description })
      .then(() => { job.status = "done"; onEvent("job_done", job); })
      .catch((err) => { job.status = "failed"; job.error = String(err.message || err); onEvent("job_failed", job); })
      .finally(() => { job.finishedAt = now(); });
    return job;
  }

  async function syncApp(name) {
    await kube.refresh(name, "hard");
    return { ok: true };
  }

  async function removeApp(name) {
    const app = (await listApps()).find((a) => a.name === name);
    if (!app || !app.tenant) throw Object.assign(new Error("Only apps created on the platform can be removed."), { status: 404 });
    await github.deleteFile(gitopsRepo, `gitops/apps/${name}.yaml`, `platform: remove ${name}`);
    await kube.refresh("apps").catch(() => {});
    return { ok: true, note: `Argo CD removes ${name} from the cluster. The repository stays on GitHub.` };
  }

  return {
    templates: TEMPLATES,
    overview,
    createApp,
    getJob: (id) => jobs.get(id) || null,
    syncApp,
    removeApp,
  };
}
