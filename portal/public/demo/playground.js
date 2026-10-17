// The public playground: everything a visitor creates on the demo really "runs" in their browser.
// Static sites render from the real template files, Node APIs run the real template code,
// and edits go through the (simulated) pipeline before the new version shows up.

import { pipelineLines, visibleLines } from "./pipeline-log.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const TEMPLATES = {
  "launchpad-template-static": {
    dir: "static-site",
    files: ["index.html", "style.css", "Dockerfile", ".dockerignore", "README.md", "deploy/deployment.yaml", "deploy/service.yaml",
      "deploy/ingress.yaml", "deploy/kustomization.yaml", ".github/workflows/launchpad.yml"],
  },
  "launchpad-template-node": {
    dir: "node-api",
    files: ["src/app.js", "src/server.js", "test/app.test.js", "package.json", "Dockerfile", ".dockerignore", "README.md",
      "deploy/deployment.yaml", "deploy/service.yaml", "deploy/ingress.yaml", "deploy/servicemonitor.yaml",
      "deploy/kustomization.yaml", ".github/workflows/launchpad.yml"],
  },
};
const REPO_OF = { "static-site": "launchpad-template-static", "node-api": "launchpad-template-node" };

// Real apps that also live on GitHub Pages: the preview shows the real thing
const REAL = {
  steuerrechner: "https://notdom1n1c.github.io/steuerrechner/",
  gambit: "https://notdom1n1c.github.io/gambit/",
  ember: "https://notdom1n1c.github.io/ember/",
};

// GitHub Pages hides dot-files, so the build publishes ".github" as "_github"
const published = (p) => p.split("/").map((seg) => (seg.startsWith(".") ? "_" + seg.slice(1) : seg)).join("/");

export function templateLoader(base = "templates") {
  const cache = new Map();
  return async (templateRepo) => {
    const t = TEMPLATES[templateRepo];
    if (!t) throw new Error(`unknown template ${templateRepo}`);
    if (!cache.has(templateRepo)) {
      cache.set(templateRepo, Promise.all(t.files.map(async (path) => {
        const res = await fetch(`${base}/${t.dir}/${published(path)}`);
        if (!res.ok) throw new Error(`template file ${path}: HTTP ${res.status}`);
        return { path, content: await res.text() };
      })));
    }
    return (await cache.get(templateRepo)).map((f) => ({ ...f }));
  };
}

function personalize(files, { name, owner, description }) {
  return files.map((f) => f.path.startsWith(".github/") ? { ...f } : ({
    path: f.path,
    content: f.content.replaceAll("__APP__", name).replaceAll("__OWNER__", owner.toLowerCase()).replaceAll("__DESCRIPTION__", description),
  }));
}

// ------------------------------------------------------------------ running the Node template in the browser
const modules = new Map(); // code -> module
async function loadHandler(code) {
  if (!modules.has(code)) {
    const url = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
    modules.set(code, import(url).finally(() => URL.revokeObjectURL(url)));
  }
  const mod = await modules.get(code);
  if (typeof mod.handler !== "function") throw new Error("src/app.js must export a function called handler");
  return mod.handler;
}

function call(handler, path, method = "GET") {
  return new Promise((resolve) => {
    const res = {
      status: 200, headers: {},
      writeHead(status, headers = {}) { this.status = status; this.headers = headers; },
      end(body = "") { resolve({ status: this.status, headers: this.headers, body: String(body) }); },
    };
    try { handler({ method, url: path }, res); } catch (err) { resolve({ status: 500, headers: {}, body: `Error: ${err.message}` }); }
    setTimeout(() => resolve({ status: 504, headers: {}, body: "No response within 2 s" }), 2000);
  });
}

// the same four checks as test/app.test.js in the template
async function runNodeTests(code, name) {
  let handler;
  try { handler = await loadHandler(code); } catch (err) { return `${err.name || "Error"}: ${err.message}`; }
  const health = await call(handler, "/healthz");
  if (health.status !== 200) return `health check answers ok: expected 200, got ${health.status}`;
  try { if (JSON.parse(health.body).status !== "ok") return 'health check answers ok: expected {"status":"ok"}'; } catch { return "health check answers ok: body is not JSON"; }
  const root = await call(handler, "/");
  try { if (JSON.parse(root.body).app !== name) return `root names the app: expected app "${name}"`; } catch { return "root names the app: body is not JSON"; }
  const nope = await call(handler, "/nope");
  if (nope.status !== 404) return `unknown routes are 404: got ${nope.status}`;
  await call(handler, "/api/time");
  const metrics = await call(handler, "/metrics");
  if (!/# TYPE http_requests_total counter/.test(metrics.body)) return "metrics count requests in Prometheus format: missing http_requests_total";
  return null;
}

// ------------------------------------------------------------------ panel
export function initPlayground({ world, owner, getState, toast, refresh }) {
  const loader = templateLoader();
  const snapshots = new Map(); // `${name}@${tag}` -> files that tag was built from
  let current = null; // { name, tab }
  let timer = null;

  document.body.insertAdjacentHTML("beforeend", `
    <div class="scrim" id="pg-scrim" hidden></div>
    <aside class="panel" id="pg" aria-labelledby="pg-name" hidden>
      <div class="panel__head">
        <i class="dot" id="pg-dot"></i>
        <h2 id="pg-name"></h2>
        <span class="pill" id="pg-health"></span>
        <code class="panel__tag" id="pg-tag"></code>
        <button class="icon-btn" id="pg-close" type="button" aria-label="Close">
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>
        </button>
      </div>
      <div class="tabs" role="tablist">
        <button role="tab" data-tab="preview">Preview</button>
        <button role="tab" data-tab="pipeline">Pipeline</button>
        <button role="tab" data-tab="files">Files</button>
        <button role="tab" data-tab="edit">Edit &amp; push</button>
      </div>
      <div class="panel__body" id="pg-body"></div>
    </aside>`);

  const $ = (s) => document.querySelector(s);
  const close = () => { $("#pg").hidden = true; $("#pg-scrim").hidden = true; current = null; clearTimeout(timer); };
  $("#pg-close").addEventListener("click", close);
  $("#pg-scrim").addEventListener("click", close);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && current) close(); });
  $("#pg .tabs").addEventListener("click", (e) => { const t = e.target.closest("[data-tab]"); if (t && current) show(current.name, t.dataset.tab); });

  const info = (name) => getState().apps.find((a) => a.name === name) || getState().jobs.find((j) => j.name === name);

  // files of a repo; apps that were seeded (not created in this browser) get theirs generated once
  async function filesOf(name) {
    const repo = world.repos.get(name);
    if (repo.files.length) return repo.files;
    const a = info(name);
    let files = personalize(await loader(REPO_OF[a.template]), { name, owner, description: a.description || "" });
    if (REAL[name]) files = files.filter((f) => !["index.html", "style.css", "README.md"].includes(f.path)); // their own code lives in their repo
    const k = files.find((f) => f.path === "deploy/kustomization.yaml");
    if (k && a.tag) k.content = k.content.replace(/newTag: .*/, `newTag: ${a.tag}`);
    repo.files = files;
    if (a.tag) snapshots.set(`${name}@${a.tag}`, files.map((f) => ({ ...f })));
    return files;
  }

  // the files of the version that is LIVE right now (not the one still in the pipeline)
  async function liveFiles(name) {
    const a = info(name);
    const files = await filesOf(name);
    return snapshots.get(`${name}@${a?.tag}`) || files;
  }

  async function open(name, tab = "preview") {
    $("#pg").hidden = false;
    $("#pg-scrim").hidden = false;
    await show(name, tab);
    $("#pg-close").focus();
  }

  function head(name) {
    const a = info(name) || {};
    const health = a.health || (a.status === "running" ? "Progressing" : "Unknown");
    $("#pg-name").textContent = name;
    $("#pg-dot").className = `dot dot--${health}`;
    $("#pg-health").className = `pill pill--${health}`;
    $("#pg-health").textContent = health;
    $("#pg-tag").textContent = a.tag && a.tag !== "latest" ? a.tag : "";
    for (const b of document.querySelectorAll("#pg .tabs [data-tab]")) b.setAttribute("aria-selected", String(b.dataset.tab === current.tab));
  }

  async function show(name, tab) {
    clearTimeout(timer);
    current = { name, tab };
    head(name);
    const body = $("#pg-body");
    try {
      if (tab === "preview") await renderPreview(name, body);
      if (tab === "pipeline") await renderPipeline(name, body);
      if (tab === "files") await renderFiles(name, body);
      if (tab === "edit") await renderEdit(name, body);
    } catch (err) {
      body.innerHTML = `<p class="pg-note pg-note--bad">${esc(err.message)}</p>`;
    }
  }

  // ---------------------------------------------------------------- preview
  async function renderPreview(name, body) {
    const a = info(name);
    if (REAL[name]) {
      body.innerHTML = `
        <p class="pg-note">This one is real: the same app, served from GitHub Pages. On the cluster it runs at <code>http://${esc(name)}.localhost</code>.
          <a href="${REAL[name]}" target="_blank" rel="noopener">Open in a new tab</a></p>
        <div class="browser"><div class="browser__bar"><span></span><span></span><span></span><code>${esc(REAL[name])}</code></div>
          <iframe class="browser__view" src="${REAL[name]}" title="${esc(name)}" loading="lazy"></iframe></div>`;
      return;
    }
    if (!a?.tag || a.tag === "latest") {
      body.innerHTML = `<p class="pg-note">Not deployed yet. The first pipeline run is still going, see the Pipeline tab.</p>`;
      timer = setTimeout(() => current?.tab === "preview" && show(name, "preview"), 1500);
      return;
    }
    const files = await liveFiles(name);
    const url = `http://${name}.localhost`;
    if (a.template === "node-api") return renderApi(name, body, files, url);

    const html = files.find((f) => f.path === "index.html")?.content || "";
    const css = files.find((f) => f.path === "style.css")?.content || "";
    const doc = html.replace(/<link[^>]+href="style\.css"[^>]*>/, `<style>${css}</style>`);
    body.innerHTML = `
      <div class="browser"><div class="browser__bar"><span></span><span></span><span></span><code>${esc(url)}</code><i>${esc(a.tag)}</i></div>
        <iframe class="browser__view" sandbox title="${esc(name)}"></iframe></div>
      <p class="pg-note">Rendered from the files in the image <code>${esc(a.tag)}</code>. Change it in <b>Edit &amp; push</b> and watch the new version roll out.</p>`;
    body.querySelector("iframe").srcdoc = doc;
  }

  async function renderApi(name, body, files, url) {
    const a = info(name);
    const code = files.find((f) => f.path === "src/app.js")?.content || "";
    body.innerHTML = `
      <p class="pg-note">This API runs the real <code>src/app.js</code> of image <code>${esc(a.tag)}</code>, right here in your browser. Send a request:</p>
      <div class="api">
        <div class="api__bar">
          <span class="api__method">GET</span><code>${esc(url)}</code>
          <input id="api-path" value="/api/time" spellcheck="false" aria-label="Path">
          <button class="btn btn--primary" id="api-send" type="button">Send</button>
        </div>
        <div class="api__quick">${["/", "/healthz", "/api/time", "/metrics", "/nope"].map((p) => `<button type="button" data-path="${p}">${p}</button>`).join("")}</div>
        <pre class="api__out" id="api-out">Response appears here.</pre>
      </div>`;
    const send = async () => {
      const path = body.querySelector("#api-path").value.trim() || "/";
      const out = body.querySelector("#api-out");
      try {
        const handler = await loadHandler(code);
        const r = await call(handler, path.startsWith("/") ? path : `/${path}`);
        let text = r.body;
        try { text = JSON.stringify(JSON.parse(r.body), null, 2); } catch { /* not JSON */ }
        out.className = `api__out ${r.status < 400 ? "is-ok" : "is-bad"}`;
        out.textContent = `HTTP ${r.status}  ${r.headers["content-type"] || ""}\n\n${text}`;
      } catch (err) {
        out.className = "api__out is-bad";
        out.textContent = String(err.message || err);
      }
    };
    body.querySelector("#api-send").addEventListener("click", send);
    body.querySelector("#api-path").addEventListener("keydown", (e) => { if (e.key === "Enter") send(); });
    body.querySelector(".api__quick").addEventListener("click", (e) => {
      const b = e.target.closest("[data-path]");
      if (b) { body.querySelector("#api-path").value = b.dataset.path; send(); }
    });
    send();
  }

  // ---------------------------------------------------------------- pipeline
  async function renderPipeline(name, body) {
    const a = info(name);
    const run = await world.github.latestRun(name);
    let lines, state, elapsed;
    if (run) {
      elapsed = Date.now() - run.startedAt;
      lines = visibleLines(pipelineLines({ name, template: a.template, owner, tag: run.tag, commit: run.commit, error: run.error }), elapsed);
      state = run.status === "completed" ? run.conclusion : run.status;
    } else {
      // seeded app: show its last (successful) run
      const commit = (a.revision || "0000000") + "c0ffee1d00d";
      lines = pipelineLines({ name, template: a.template, owner, tag: a.tag, commit, error: null });
      state = "success";
    }
    const argo = [];
    if (run && run.conclusion === "success") {
      argo.push(`Argo CD: new commit on main, syncing ${run.tag}`);
      if (a.tag === run.tag && a.health === "Progressing") argo.push("Argo CD: rolling out, waiting for the new pod to be ready…");
      if (a.tag === run.tag && a.health === "Healthy") argo.push(`Argo CD: ${run.tag} is live, app Healthy`);
    }
    body.innerHTML = `
      <div class="run">
        <span class="pill pill--${state === "success" ? "done" : state === "failure" ? "failed" : "running"}">${esc(state.replace("_", " "))}</span>
        <span class="muted small">${run ? `commit ${esc(run.commit.slice(0, 7))} · ${Math.round(Math.min(elapsed, 14000) / 1000)} s` : "last run"}</span>
      </div>
      <pre class="log">${lines.map((l) => `<span class="log__l log__l--${l.kind}">${esc(l.text)}</span>`).join("\n")}${
        argo.length ? "\n" + argo.map((t) => `<span class="log__l log__l--argo">${esc(t)}</span>`).join("\n") : ""}</pre>
      <p class="pg-note">Same steps as <code>.github/workflows/launchpad.yml</code> in the repo. On the real platform this is a GitHub Actions run.</p>`;
    const log = body.querySelector(".log");
    log.scrollTop = log.scrollHeight;
    const busy = run && (run.status !== "completed" || (run.conclusion === "success" && !(a.tag === run.tag && a.health === "Healthy")));
    if (busy) timer = setTimeout(() => current?.tab === "pipeline" && show(name, "pipeline"), 600);
  }

  // ---------------------------------------------------------------- files
  async function renderFiles(name, body, selected) {
    const files = await filesOf(name);
    const pick = files.find((f) => f.path === selected) || files.find((f) => f.path === "deploy/kustomization.yaml") || files[0];
    body.innerHTML = `
      <p class="pg-note">What the platform generated for <code>${esc(name)}</code> from the template${REAL[name] ? " (its own source code lives in the real repo)" : ""}.
        <code>deploy/</code> is what Argo CD applies; the pipeline rewrites <code>newTag</code> after every build.</p>
      <div class="files">
        <ul class="files__list">${files.map((f) => `<li><button type="button" data-file="${esc(f.path)}" aria-current="${f.path === pick.path}">${esc(f.path)}</button></li>`).join("")}</ul>
        <pre class="files__view"><code>${esc(pick.content)}</code></pre>
      </div>`;
    body.querySelector(".files__list").addEventListener("click", (e) => {
      const b = e.target.closest("[data-file]");
      if (b) renderFiles(name, body, b.dataset.file);
    });
  }

  // ---------------------------------------------------------------- edit & push
  async function renderEdit(name, body) {
    const a = info(name);
    if (REAL[name]) {
      body.innerHTML = `<p class="pg-note">${esc(name)} is a real project, its code lives in <a href="https://github.com/${owner}/${name}" target="_blank" rel="noopener">github.com/${owner}/${name}</a>.
        Create your own app with <b>New app</b> to edit and push here, or try <b>hello-api</b>.</p>`;
      return;
    }
    const files = await filesOf(name);
    const path = a.template === "node-api" ? "src/app.js" : "index.html";
    const file = files.find((f) => f.path === path);
    const run = await world.github.latestRun(name);
    const busy = run && run.status !== "completed";
    body.innerHTML = `
      <label class="field">
        <span class="field__label"><code>${esc(path)}</code></span>
        <textarea class="editor" id="ed-code" spellcheck="false">${esc(file.content)}</textarea>
      </label>
      <label class="field">
        <span class="field__label">Commit message</span>
        <input id="ed-msg" maxlength="72" value="${a.template === "node-api" ? "Add an endpoint" : "Update the start page"}">
      </label>
      <button class="btn btn--primary" id="ed-push" type="button" ${busy ? "disabled" : ""}>${busy ? "A pipeline is still running…" : "Commit &amp; push to main"}</button>
      <p class="pg-note">${a.template === "node-api"
        ? 'Try adding a route, e.g. <code>"/api/hello": () =&gt; [200, { hi: "there" }],</code> inside <code>routes</code>. Break it and the tests will stop the release.'
        : "Change the headline or the text, then push. The new version appears in Preview once Argo CD has rolled it out."}</p>`;
    body.querySelector("#ed-push").addEventListener("click", async () => {
      const content = body.querySelector("#ed-code").value;
      if (content.length > 60000) return toast("That file is too big for the demo (60 KB max).");
      const btn = body.querySelector("#ed-push");
      btn.disabled = true;
      btn.textContent = "Pushing…";
      if (a.template === "node-api") world.repos.get(name).nextRunFails = await runNodeTests(content, name);
      // keep what is live now, so Preview shows it until the new version is rolled out
      const liveKey = `${name}@${info(name).tag}`;
      if (!snapshots.has(liveKey)) snapshots.set(liveKey, (await filesOf(name)).map((f) => ({ ...f })));
      const commit = await world.github.commitFiles(name, "main", [{ path, content }], body.querySelector("#ed-msg").value);
      const updated = (await filesOf(name)).map((f) => ({ ...f }));
      const k = updated.find((f) => f.path === "deploy/kustomization.yaml");
      if (k) k.content = k.content.replace(/newTag: .*/, `newTag: sha-${commit.slice(0, 7)}`);
      snapshots.set(`${name}@sha-${commit.slice(0, 7)}`, updated);
      toast(`Pushed ${commit.slice(0, 7)}. The pipeline is running.`);
      refresh();
      show(name, "pipeline");
    });
  }

  // live log inside the "New app" drawer
  async function jobLog(job) {
    const build = job.steps.find((s) => s.id === "build");
    if (build.state === "pending") return "";
    const run = await world.github.latestRun(job.name);
    if (!run) return "";
    const lines = visibleLines(pipelineLines({ name: job.name, template: job.template, owner, tag: run.tag, commit: run.commit, error: run.error }), Date.now() - run.startedAt);
    return lines.slice(-7).map((l) => `<span class="log__l log__l--${l.kind}">${esc(l.text)}</span>`).join("\n");
  }

  // keep the panel header in sync while it is open
  function tick() { if (current) head(current.name); }

  return { open, jobLog, tick, isOpen: () => Boolean(current) };
}
