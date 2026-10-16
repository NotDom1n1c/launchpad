// Minimal Kubernetes API client for Argo CD Applications.
// In the cluster it uses the pod's ServiceAccount; outside, point KUBE_API_URL at `kubectl proxy`.
import { readFileSync, existsSync } from "node:fs";
import https from "node:https";
import http from "node:http";

const SA = "/var/run/secrets/kubernetes.io/serviceaccount";
const APPS = "/apis/argoproj.io/v1alpha1/namespaces/argocd/applications";

export function createKube({ apiUrl = process.env.KUBE_API_URL } = {}) {
  let base, agent, token;
  if (apiUrl) {
    base = new URL(apiUrl);
  } else if (existsSync(`${SA}/token`)) {
    base = new URL(`https://${process.env.KUBERNETES_SERVICE_HOST}:${process.env.KUBERNETES_SERVICE_PORT}`);
    agent = new https.Agent({ ca: readFileSync(`${SA}/ca.crt`) });
  } else {
    base = null;
  }

  function call(method, path, body, contentType = "application/json") {
    if (!base) return Promise.reject(new Error("Not connected to a cluster (no ServiceAccount and no KUBE_API_URL)."));
    if (!apiUrl) token = readFileSync(`${SA}/token`, "utf8"); // re-read: Kubernetes rotates it
    const url = new URL(path, base);
    const lib = url.protocol === "https:" ? https : http;
    const payload = body ? JSON.stringify(body) : null;
    return new Promise((resolve, reject) => {
      const req = lib.request(url, {
        method,
        agent,
        timeout: 8000,
        headers: {
          accept: "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(payload ? { "content-type": contentType, "content-length": Buffer.byteLength(payload) } : {}),
        },
      }, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          if (res.statusCode === 404) return resolve(null);
          if (res.statusCode >= 400) return reject(new Error(`Kubernetes ${method} ${path}: ${res.statusCode}`));
          try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); }
        });
      });
      req.on("timeout", () => req.destroy(new Error("Kubernetes API timed out")));
      req.on("error", reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  return {
    async listApplications() {
      return (await call("GET", APPS))?.items || [];
    },
    async getApplication(name) {
      return call("GET", `${APPS}/${name}`);
    },
    // Ask Argo CD to look at Git now instead of waiting for the next poll
    async refresh(name, type = "normal") {
      return call("PATCH", `${APPS}/${name}`, { metadata: { annotations: { "argocd.argoproj.io/refresh": type } } }, "application/merge-patch+json");
    },
  };
}
