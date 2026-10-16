#!/usr/bin/env bash
# One-time setup inside WSL (Ubuntu): Docker Engine, k3d, kubectl, helm.
# Docker Engine instead of Docker Desktop: free, no GUI, nothing running when WSL is off.
set -euo pipefail

K3D_VERSION=v5.9.0
KUBECTL_VERSION=v1.36.5
HELM_VERSION=v4.3.1

need() { ! command -v "$1" >/dev/null 2>&1; }
SUDO=""; [ "$(id -u)" -ne 0 ] && SUDO="sudo"

if need docker; then
  echo "==> Docker Engine"
  curl -fsSL https://get.docker.com | $SUDO sh
  [ -n "$SUDO" ] && $SUDO usermod -aG docker "$USER" || true
fi
$SUDO systemctl enable --now docker >/dev/null 2>&1 || $SUDO service docker start

if need k3d; then
  echo "==> k3d $K3D_VERSION"
  curl -fsSL https://raw.githubusercontent.com/k3d-io/k3d/main/install.sh | $SUDO env TAG=$K3D_VERSION bash
fi

if need kubectl; then
  echo "==> kubectl $KUBECTL_VERSION"
  curl -fsSLo /tmp/kubectl "https://dl.k8s.io/release/$KUBECTL_VERSION/bin/linux/amd64/kubectl"
  $SUDO install -m 0755 /tmp/kubectl /usr/local/bin/kubectl
fi

if need helm; then
  echo "==> helm $HELM_VERSION"
  curl -fsSL "https://get.helm.sh/helm-$HELM_VERSION-linux-amd64.tar.gz" | tar -xz -C /tmp
  $SUDO install -m 0755 /tmp/linux-amd64/helm /usr/local/bin/helm
fi

docker version --format 'docker {{.Server.Version}}'
k3d version | head -1
kubectl version --client | head -1
helm version --short
