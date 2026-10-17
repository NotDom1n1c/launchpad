// What the real GitHub Actions run prints, replayed on the simulated clock.
// Offsets line up with RUN_QUEUED_MS / RUN_FAIL_MS / RUN_TOTAL_MS in core/fakes.js.

export function pipelineLines({ name, template, owner, tag, commit, error }) {
  const image = `ghcr.io/${owner.toLowerCase()}/${name}`;
  const node = template === "node-api";
  const base = node ? "node:24-alpine" : "nginxinc/nginx-unprivileged:1.30-alpine";
  const L = (t, text, kind = "") => ({ t, text, kind });

  const lines = [
    L(0, `Push ${commit.slice(0, 7)} to main triggered workflow "launchpad"`, "head"),
    L(200, "Waiting for a GitHub-hosted runner (ubuntu-latest)…", "muted"),
    L(2500, "▸ Job test", "head"),
    L(2650, "Run actions/checkout@3d3c42e5 # v7.0.1"),
    L(2900, "Personalized yet? → ready=true"),
  ];

  if (node) {
    lines.push(L(3200, "Run actions/setup-node # v7.1.0 → node v24"));
    lines.push(L(3600, "$ node --test"));
    if (error) {
      lines.push(L(4300, `✖ test/app.test.js`, "bad"));
      lines.push(L(4500, `  ${error}`, "bad"));
      // a file that does not even load fails every test; otherwise only the one that broke
      const all = /^(\w*Error|.*must export)/.test(error);
      lines.push(L(4800, all ? "# tests 4  # pass 0  # fail 4" : "# tests 4  # pass 3  # fail 1", "bad"));
      lines.push(L(5000, "Error: Process completed with exit code 1. Nothing was built or deployed.", "bad"));
      return lines;
    }
    lines.push(L(4100, "✔ health check answers ok (12ms)", "ok"));
    lines.push(L(4250, "✔ root names the app (3ms)", "ok"));
    lines.push(L(4400, "✔ unknown routes are 404 (2ms)", "ok"));
    lines.push(L(4550, "✔ metrics count requests in Prometheus format (4ms)", "ok"));
    lines.push(L(4700, "# tests 4  # pass 4  # fail 0", "ok"));
  } else {
    lines.push(L(3400, "Check the site (python): every local link must exist"));
    lines.push(L(4300, "all local links resolve", "ok"));
  }

  lines.push(
    L(5200, "▸ Job deliver", "head"),
    L(5400, `$ docker build -t ${image}:${tag} .`),
    L(6000, `  => [1/2] FROM docker.io/${base}`, "muted"),
    L(6900, `  => [2/2] COPY ${node ? "src ./src" : ". /usr/share/nginx/html"}`, "muted"),
    L(7500, `  => naming to ${image}:${tag}  done`, "muted"),
    L(7900, "Smoke test the container"),
    L(8500, `  GET / -> 200`, "ok"),
    L(8800, "Security scan (Trivy 0.76.0)"),
    L(10200, `  ${image}:${tag} (alpine 3.22)`, "muted"),
    L(10300, "  Total: 0 (HIGH: 0, CRITICAL: 0)", "ok"),
    L(10700, `$ docker push ${image}:${tag}`),
    L(11800, `  ${tag}: digest: sha256:${(commit + commit).slice(0, 32)}… size: 1782`, "muted"),
    L(12200, "Deploy (GitOps)"),
    L(12500, `  sed -i "s/newTag: .*/newTag: ${tag}/" deploy/kustomization.yaml`, "muted"),
    L(13200, `  [main ${commit.slice(7, 14)}] deploy: ${tag} [skip ci]`, "muted"),
    L(14000, `✓ Deployed ${tag}. Argo CD rolls it out within a minute.`, "ok"),
  );
  return lines;
}

// the lines that are visible `elapsed` ms after the run started
export function visibleLines(lines, elapsed) {
  return lines.filter((l) => l.t <= elapsed);
}
