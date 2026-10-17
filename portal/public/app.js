// LAUNCHPAD portal UI. Talks to /api, or (public demo) to the same platform code running on fakes in the browser.

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const params = new URLSearchParams(location.search);
const BROWSER_DEMO = location.hostname.endsWith("github.io") || params.has("demo") || location.protocol === "file:";

// Apps whose GitHub repos really exist; apps a visitor creates in the demo only exist in their browser
const REAL_REPOS = new Set(["steuerrechner", "gambit", "ember", "hello-api"]);
let playground = null; // demo only: lets visitors open, inspect and edit their apps

// ------------------------------------------------------------------ api
async function makeApi() {
  if (!BROWSER_DEMO) {
    const call = async (method, path, body) => {
      const res = await fetch(path, {
        method,
        headers: body !== undefined ? { "content-type": "application/json" } : {},
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      return data;
    };
    return {
      overview: () => call("GET", "/api/overview"),
      templates: () => call("GET", "/api/templates"),
      create: (input) => call("POST", "/api/apps", input),
      job: (id) => call("GET", `/api/jobs/${id}`),
      sync: (name) => call("POST", `/api/apps/${name}/sync`, {}),
      remove: (name) => call("DELETE", `/api/apps/${name}`, {}),
    };
  }

  const [{ createPlatform }, { createWorld }, pg] = await Promise.all([
    import("./core/platform.js"), import("./core/fakes.js"), import("./demo/playground.js"),
  ]);
  const world = createWorld({ owner: "NotDom1n1c", speed: 1, templateFiles: pg.templateLoader() });
  playground = pg.initPlayground({ world, owner: "NotDom1n1c", getState: () => state, toast, refresh: () => refresh() });
  const platform = createPlatform({ ...world, owner: "NotDom1n1c", pollMs: 700 });
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const links = { argocd: "https://github.com/NotDom1n1c/launchpad#screenshots", grafana: "https://github.com/NotDom1n1c/launchpad#screenshots", github: "https://github.com/NotDom1n1c" };
  return {
    overview: async () => ({ ...(await platform.overview()), links, demo: true }),
    templates: async () => platform.templates,
    create: async (input) => clone(await platform.createApp(input)),
    job: async (id) => clone(platform.getJob(id)),
    sync: (name) => platform.syncApp(name),
    remove: (name) => platform.removeApp(name),
  };
}

// ------------------------------------------------------------------ helpers
function ago(iso) {
  if (!iso) return "-";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

let toastTimer;
function toast(text) {
  const el = $("#toast");
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 3800);
}

// ------------------------------------------------------------------ state
let api;
let state = { apps: [], platform: [], jobs: [], links: {}, owner: "NotDom1n1c", canCreate: false, demo: BROWSER_DEMO };
let templates = [];
let activeJob = null;
let refreshTimer;

// ------------------------------------------------------------------ render: overview
function renderOverview() {
  const { stats = {}, cluster = {}, links = {}, demo } = state;

  const c = $("#cluster");
  const live = cluster.connected;
  c.innerHTML = `<i class="dot dot--${live ? "ok" : "bad"}"></i><span>${demo ? "demo · simulated cluster" : live ? "k3d-launchpad · live" : "cluster unreachable"}</span>`;
  c.title = cluster.message || "";

  $("#s-apps").textContent = stats.apps ?? "-";
  const healthy = $("#s-healthy");
  healthy.textContent = stats.apps ? `${stats.healthy}/${stats.apps}` : "-";
  healthy.className = "stat__n " + (stats.apps && stats.healthy === stats.apps ? "is-ok" : "");
  $("#s-synced").textContent = stats.apps ? `${stats.synced}/${stats.apps}` : "-";
  const p = $("#s-platform");
  p.textContent = !live ? "offline" : stats.platformHealthy ? "OK" : "busy";
  p.className = "stat__n " + (!live ? "is-bad" : stats.platformHealthy ? "is-ok" : "");

  $("#platform").innerHTML = state.platform
    .map((a) => `<li title="${esc(a.sync)} / ${esc(a.health)}"><i class="dot dot--${esc(a.health)}"></i>${esc(a.name)}</li>`)
    .join("") || `<li><i class="dot"></i>no data</li>`;

  for (const k of ["argocd", "grafana", "github"]) if (links[k]) $(`#link-${k}`).href = links[k];
  $("#gitops-link").href = `https://github.com/${state.owner}/${state.gitopsRepo || "launchpad"}`;
  $("#gitops-link").textContent = `${state.owner}/${state.gitopsRepo || "launchpad"}`;

  const btn = $("#new-app");
  btn.disabled = !state.canCreate;
  btn.title = state.canCreate ? "" : "The portal has no GitHub token. Start the platform with launchpad.ps1 up while logged in with gh.";
}

// ------------------------------------------------------------------ render: cards
function appCard(a) {
  const links = state.links || {};
  const realRepo = !state.demo || REAL_REPOS.has(a.name);
  const grafana = state.demo ? links.grafana : `${links.grafana}/d/launchpad-apps/launchpad-apps?var-app=${encodeURIComponent(a.name)}`;
  const argo = state.demo ? links.argocd : `${links.argocd}/applications/argocd/${encodeURIComponent(a.name)}`;
  const tpl = templates.find((t) => t.id === a.template);
  return `
  <article class="card" data-app="${esc(a.name)}">
    <div class="card__top">
      <i class="dot dot--${esc(a.health)}"></i>
      <h3 class="card__name">${esc(a.name)}</h3>
      <span class="pill pill--${esc(a.health)}">${esc(a.health)}</span>
    </div>
    <p class="card__desc">${esc(a.description)}</p>
    <dl class="meta">
      <dt>Image</dt><dd title="${esc(a.image)}">${esc(a.tag || "-")}</dd>
      <dt>Sync</dt><dd class="sync--${esc(a.sync)}">${esc(a.sync)}${a.revision ? ` @ ${esc(a.revision)}` : ""}</dd>
      <dt>Deployed</dt><dd>${esc(ago(a.deployedAt))}</dd>
      <dt>Template</dt><dd>${esc(tpl ? tpl.name : a.template || "-")}</dd>
    </dl>
    <div class="card__actions">
      ${state.demo
        ? `<button type="button" class="is-primary" data-pg="${esc(a.name)}:preview">Open</button>`
        : `<a class="is-primary" href="${esc(a.url || "#")}" target="_blank" rel="noopener">Open</a>`}
      ${realRepo && a.repo ? `<a href="${esc(a.repo)}" target="_blank" rel="noopener">Repo</a>` : `<button type="button" data-pg="${esc(a.name)}:files">Files</button>`}
      ${realRepo && a.repo ? `<a href="${esc(a.repo)}/actions" target="_blank" rel="noopener">Pipeline</a>` : `<button type="button" data-pg="${esc(a.name)}:pipeline">Pipeline</button>`}
      ${state.demo ? `<button type="button" data-pg="${esc(a.name)}:edit">Edit</button>` : ""}
      <a href="${esc(grafana)}" target="_blank" rel="noopener">Metrics &amp; logs</a>
      <a href="${esc(argo)}" target="_blank" rel="noopener">Argo CD</a>
      <button type="button" data-sync="${esc(a.name)}">Sync</button>
      <button type="button" class="is-danger" data-remove="${esc(a.name)}" title="Remove from the platform (the repo stays)">Remove</button>
    </div>
  </article>`;
}

function jobCard(j) {
  const current = j.steps.find((s) => s.state === "running" || s.state === "failed") || j.steps[j.steps.length - 1];
  return `
  <article class="card card--job" data-job="${esc(j.id)}">
    <div class="card__top">
      <i class="dot dot--${esc(j.status)}"></i>
      <h3 class="card__name">${esc(j.name)}</h3>
      <span class="pill pill--${esc(j.status)}">${j.status === "running" ? "launching" : esc(j.status)}</span>
    </div>
    <div class="mini-steps">${j.steps.map((s) => `<span class="is-${esc(s.state)}" title="${esc(s.label)}"></span>`).join("")}</div>
    <p class="card__desc">${esc(j.status === "failed" ? j.error : current.label)}${current.detail && j.status !== "failed" ? ` <span class="muted">· ${esc(current.detail)}</span>` : ""}</p>
    <div class="card__actions"><button type="button" class="is-primary" data-show-job="${esc(j.id)}">Show progress</button></div>
  </article>`;
}

function renderApps() {
  const appNames = new Set(state.apps.map((a) => a.name));
  // a finished job's app shows as a normal card, so only keep jobs that are still interesting
  const jobs = state.jobs.filter((j) => j.status !== "done" || !appNames.has(j.name));
  const launching = new Set(jobs.filter((j) => j.status === "running").map((j) => j.name));
  const apps = state.apps.filter((a) => !launching.has(a.name));
  $("#apps").innerHTML = jobs.map(jobCard).join("") + apps.map(appCard).join("");
  $("#empty").hidden = apps.length + jobs.length > 0;
}

async function refresh() {
  clearTimeout(refreshTimer);
  try {
    state = { ...state, ...(await api.overview()) };
    renderOverview();
    renderApps();
  } catch (err) {
    state.cluster = { connected: false, message: err.message };
    renderOverview();
  }
  const busy = state.jobs.some((j) => j.status === "running") || state.apps.some((a) => a.health !== "Healthy");
  playground?.tick();
  refreshTimer = setTimeout(refresh, busy ? 2000 : 6000);
}

// ------------------------------------------------------------------ drawer: form
function openDrawer() {
  $("#scrim").hidden = false;
  $("#drawer").hidden = false;
  if (!activeJob) showForm();
  setTimeout(() => (activeJob ? $("#drawer-close") : $("#f-name")).focus(), 30);
}

function closeDrawer() {
  $("#scrim").hidden = true;
  $("#drawer").hidden = true;
  $("#new-app").focus();
}

function showForm() {
  activeJob = null;
  $("#drawer-title").textContent = "New app";
  $("#form").hidden = false;
  $("#job").hidden = true;
  $("#form").reset();
  $("#form-error").hidden = true;
  const first = document.querySelector('input[name="template"]');
  if (first) first.checked = true;
  updatePreview();
}

function renderTemplates() {
  $("#templates").innerHTML = templates.map((t, i) => `
    <label class="tpl">
      <input type="radio" name="template" value="${esc(t.id)}" ${i === 0 ? "checked" : ""}>
      <span class="tpl__box">
        <span class="tpl__name">${esc(t.name)}</span>
        <span class="tpl__sum">${esc(t.summary)}</span>
        <span class="tpl__stack">${t.stack.map((s) => `<i>${esc(s)}</i>`).join("")}</span>
      </span>
    </label>`).join("");
}

function nameProblem(name) {
  const taken = [...state.apps.map((a) => a.name), ...state.jobs.map((j) => j.name)];
  const reserved = ["launchpad", "argocd", "grafana", "monitoring", "loki", "alloy", "portal", "platform", "platform-config", "apps", "default"];
  if (!name) return null;
  if (name.length < 3) return "At least 3 characters.";
  if (!/^[a-z][a-z0-9-]*[a-z0-9]$/.test(name)) return "Lowercase letters, digits and dashes. Start with a letter, end with a letter or digit.";
  if (name.includes("--")) return "No double dashes.";
  if (reserved.includes(name)) return `"${name}" is reserved by the platform.`;
  if (taken.includes(name)) return `"${name}" already exists.`;
  return null;
}

function updatePreview() {
  const name = $("#f-name").value.trim();
  const owner = state.owner || "NotDom1n1c";
  const shown = name || "your-app";
  $("#p-repo").textContent = `github.com/${owner}/${shown}`;
  $("#p-image").textContent = `ghcr.io/${owner.toLowerCase()}/${shown}`;
  $("#p-url").textContent = `http://${shown}.localhost`;
  const problem = nameProblem(name);
  const hint = $("#f-name-hint");
  hint.textContent = problem || "Lowercase, digits and dashes. Becomes repo, namespace and URL.";
  hint.classList.toggle("is-error", Boolean(problem));
  $("#f-name").setAttribute("aria-invalid", problem ? "true" : "false");
  $("#launch").disabled = !name || Boolean(problem);
}

async function submit(e) {
  e.preventDefault();
  const input = {
    name: $("#f-name").value.trim(),
    template: document.querySelector('input[name="template"]:checked')?.value,
    description: $("#f-desc").value.trim(),
  };
  $("#launch").disabled = true;
  $("#launch").textContent = "Launching…";
  try {
    const job = await api.create(input);
    showJob(job);
    refresh();
  } catch (err) {
    const box = $("#form-error");
    box.textContent = err.message;
    box.hidden = false;
  } finally {
    $("#launch").textContent = "Launch";
    updatePreview();
  }
}

// ------------------------------------------------------------------ drawer: job progress
let jobTimer;
function showJob(job) {
  activeJob = job;
  $("#drawer-title").textContent = "Launching";
  $("#form").hidden = true;
  $("#job").hidden = false;
  renderJob(job);
  pollJob();
}

function fmtDuration(s) {
  if (!s.startedAt) return "";
  const end = s.finishedAt || Date.now();
  const sec = Math.max(0, Math.round((end - s.startedAt) / 1000));
  return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m ${sec % 60}s`;
}

function renderJob(job) {
  $("#drawer-title").textContent = job.status === "done" ? "Launched" : job.status === "failed" ? "Launch failed" : "Launching";
  $("#job-name").textContent = job.name;
  const st = $("#job-status");
  st.textContent = job.status === "running" ? "running" : job.status;
  st.className = `pill pill--${job.status}`;

  $("#steps").innerHTML = job.steps.map((s, i) => `
    <li class="is-${esc(s.state)}">
      <span class="ico">${s.state === "done" ? "&#10003;" : s.state === "failed" ? "!" : i + 1}</span>
      <div><b>${esc(s.label)} <span class="t">${esc(fmtDuration(s))}</span></b>${s.detail ? `<small>${esc(s.detail)}</small>` : ""}</div>
    </li>`).join("");

  const l = job.links || {};
  const links = state.links || {};
  const parts = [];
  if (l.repo && !state.demo) parts.push(`<a href="${esc(l.repo)}" target="_blank" rel="noopener">Repository</a>`);
  if (l.pipeline && !state.demo) parts.push(`<a href="${esc(l.pipeline)}" target="_blank" rel="noopener">Pipeline run</a>`);
  if (l.argocd && !state.demo) parts.push(`<a href="${esc(links.argocd)}/applications/argocd/${esc(l.argocd)}" target="_blank" rel="noopener">Argo CD</a>`);
  $("#job-links").innerHTML = parts.join("");

  const done = job.status !== "running";
  $("#job-done").hidden = !done;
  const open = $("#job-open");
  open.hidden = job.status !== "done";
  open.href = state.demo ? "#" : job.url;
  open.textContent = "Open the app";
  if (job.status === "failed") $("#job-another").textContent = "Try again";

  // demo: the real pipeline output, streamed while the build runs
  const log = $("#job-log");
  if (playground) {
    playground.jobLog(job).then((html) => { log.hidden = !html; log.innerHTML = html; log.scrollTop = log.scrollHeight; });
  } else {
    log.hidden = true;
  }
}

async function pollJob() {
  clearTimeout(jobTimer);
  if (!activeJob) return;
  try {
    const job = await api.job(activeJob.id);
    if (job) {
      const was = activeJob.status;
      activeJob = job;
      if (!$("#drawer").hidden) renderJob(job);
      if (was === "running" && job.status === "done") toast(`${job.name} is live.`);
      if (was === "running" && job.status === "failed") toast(`${job.name} failed: ${job.error}`);
      if (job.status !== "running") return refresh();
    }
  } catch { /* keep polling */ }
  jobTimer = setTimeout(pollJob, 1000);
}

// ------------------------------------------------------------------ events
document.addEventListener("click", async (e) => {
  const t = e.target.closest("button, a");
  if (!t) return;

  if (t.dataset.sync) {
    t.disabled = true;
    try { await api.sync(t.dataset.sync); toast(`Asked Argo CD to re-check ${t.dataset.sync} against Git.`); }
    catch (err) { toast(err.message); }
    t.disabled = false;
    refresh();
  }

  if (t.dataset.remove) {
    const name = t.dataset.remove;
    if (!confirm(`Remove ${name} from the platform?\n\nThis deletes gitops/apps/${name}.yaml. Argo CD then removes the app from the cluster. The GitHub repository stays.`)) return;
    try { const r = await api.remove(name); toast(r.note || `${name} removed.`); }
    catch (err) { toast(err.message); }
    refresh();
  }

  if (t.dataset.pg && playground) {
    const [name, tab] = t.dataset.pg.split(":");
    playground.open(name, tab);
  }

  if (t.dataset.showJob) {
    const job = state.jobs.find((j) => j.id === t.dataset.showJob);
    if (job) { openDrawer(); showJob(job); }
  }
});

$("#new-app").addEventListener("click", () => { if (activeJob && activeJob.status !== "running") showForm(); openDrawer(); });
$("#drawer-close").addEventListener("click", closeDrawer);
$("#scrim").addEventListener("click", closeDrawer);
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("#drawer").hidden) closeDrawer(); });
$("#f-name").addEventListener("input", (e) => {
  const clean = e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  if (clean !== e.target.value) e.target.value = clean;
  updatePreview();
});
$("#form").addEventListener("submit", submit);
$("#job-another").addEventListener("click", showForm);
$("#job-open").addEventListener("click", (e) => {
  if (!playground || !activeJob) return;
  e.preventDefault();
  closeDrawer();
  playground.open(activeJob.name, "preview");
});

// ------------------------------------------------------------------ start
(async function start() {
  api = await makeApi();
  if (BROWSER_DEMO) $("#demo-banner").hidden = false;
  try { templates = await api.templates(); } catch { templates = []; }
  renderTemplates();
  await refresh();
  if (params.has("new")) openDrawer();
})();
