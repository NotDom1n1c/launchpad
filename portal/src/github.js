// Minimal GitHub REST client: only the calls the platform needs.

const TEXT_FILE = /\.(md|ya?ml|json|js|mjs|html|css|txt|conf)$|(^|\/)(Dockerfile|\.dockerignore)$/;

export function createGitHub({ token, owner, api = "https://api.github.com", fetchImpl = fetch }) {
  async function call(method, path, body) {
    const res = await fetchImpl(api + path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "launchpad-portal",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 404) return null;
    const data = res.status === 204 ? null : await res.json().catch(() => null);
    if (!res.ok) {
      const err = new Error(`GitHub ${method} ${path}: ${res.status} ${data?.message || ""}`.trim());
      err.status = res.status;
      throw err;
    }
    return data ?? {};
  }

  const repo = (name) => `/repos/${owner}/${name}`;

  return {
    ready: Boolean(token),

    async repoExists(name) {
      return Boolean(await call("GET", repo(name)));
    },

    async generateFromTemplate(templateRepo, name, description) {
      return call("POST", `${repo(templateRepo)}/generate`, { owner, name, description, private: false });
    },

    async branchExists(name, branch) {
      return Boolean(await call("GET", `${repo(name)}/branches/${branch}`));
    },

    async readTextFiles(name, ref) {
      const tree = await call("GET", `${repo(name)}/git/trees/${ref}?recursive=1`);
      const blobs = (tree?.tree || []).filter((e) => e.type === "blob" && TEXT_FILE.test(e.path) && e.size < 200_000);
      return Promise.all(
        blobs.map(async (e) => {
          const blob = await call("GET", `${repo(name)}/git/blobs/${e.sha}`);
          return { path: e.path, content: Buffer.from(blob.content, "base64").toString("utf8") };
        }),
      );
    },

    // Several files in ONE commit (Git Data API), so the pipeline runs once
    async commitFiles(name, branch, files, message) {
      if (!files.length) return null;
      const ref = await call("GET", `${repo(name)}/git/ref/heads/${branch}`);
      const parent = await call("GET", `${repo(name)}/git/commits/${ref.object.sha}`);
      const tree = await call("POST", `${repo(name)}/git/trees`, {
        base_tree: parent.tree.sha,
        tree: files.map((f) => ({ path: f.path, mode: "100644", type: "blob", content: f.content })),
      });
      const commit = await call("POST", `${repo(name)}/git/commits`, { message, tree: tree.sha, parents: [parent.sha] });
      await call("PATCH", `${repo(name)}/git/refs/heads/${branch}`, { sha: commit.sha });
      return commit.sha;
    },

    async putFile(name, path, content, message) {
      const existing = await call("GET", `${repo(name)}/contents/${path}`);
      return call("PUT", `${repo(name)}/contents/${path}`, {
        message,
        content: Buffer.from(content, "utf8").toString("base64"),
        ...(existing?.sha ? { sha: existing.sha } : {}),
      });
    },

    async deleteFile(name, path, message) {
      const existing = await call("GET", `${repo(name)}/contents/${path}`);
      if (!existing) return null;
      return call("DELETE", `${repo(name)}/contents/${path}`, { message, sha: existing.sha });
    },

    async latestRun(name, headSha) {
      const filter = headSha ? `&head_sha=${headSha}` : "";
      const data = await call("GET", `${repo(name)}/actions/runs?per_page=1${filter}`);
      const run = data?.workflow_runs?.[0];
      return run ? { status: run.status, conclusion: run.conclusion, url: run.html_url } : null;
    },
  };
}
