# __APP__

__DESCRIPTION__

A Node.js JSON API with `/healthz` and Prometheus `/metrics`, created with [LAUNCHPAD](https://github.com/__OWNER__/launchpad).

| | |
|---|---|
| Live (local cluster) | http://__APP__.localhost |
| Pipeline | `.github/workflows/launchpad.yml` |
| Kubernetes manifests | `deploy/` (Argo CD watches this folder) |

## How a change goes live

1. Edit `src/app.js`, run `npm test` and push to `main`.
2. GitHub Actions tests it, builds the image, smoke-tests the container and scans it with Trivy.
3. The image goes to `ghcr.io/__OWNER__/__APP__` and the pipeline writes the new tag into `deploy/kustomization.yaml`.
4. Argo CD sees the commit and rolls out the new version.

The pipeline commits to `main` after every deploy, so run `git pull` before your next push.
