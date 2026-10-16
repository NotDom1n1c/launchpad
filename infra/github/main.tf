# The GitHub side of LAUNCHPAD, as code:
#   - the platform repo itself (description, topics, GitHub Pages demo)
#   - one template repository per golden-path template
#
#   cd infra/github
#   $env:GITHUB_TOKEN = gh auth token     # or: export GITHUB_TOKEN=$(gh auth token)
#   tofu init && tofu apply
#
# Template CONTENT lives in templates/ in this repo and is published by scripts/publish-templates.sh.

terraform {
  required_version = ">= 1.8"
  required_providers {
    github = {
      source  = "integrations/github"
      version = "~> 6.13"
    }
  }
}

provider "github" {
  owner = var.owner
}

locals {
  common_topics = ["launchpad", "kubernetes", "gitops", "argocd", "platform-engineering"]

  templates = {
    static = {
      description = "LAUNCHPAD golden path: static site on non-root nginx, with CI pipeline, Trivy scan and Argo CD manifests."
      topics      = ["template", "nginx", "static-site"]
    }
    node = {
      description = "LAUNCHPAD golden path: Node.js API with /healthz and Prometheus /metrics, CI pipeline and Argo CD manifests."
      topics      = ["template", "nodejs", "prometheus"]
    }
  }
}

resource "github_repository" "template" {
  for_each = local.templates

  name        = "launchpad-template-${each.key}"
  description = each.value.description
  visibility  = "public"
  is_template = true
  topics      = concat(local.common_topics, each.value.topics)

  has_issues           = false
  has_wiki             = false
  has_projects         = false
  has_downloads        = false
  vulnerability_alerts = true

  allow_merge_commit     = false
  delete_branch_on_merge = true
}

# The platform repo was created by hand first; tofu adopts it instead of creating a new one.
import {
  to = github_repository.platform
  id = "launchpad"
}

resource "github_repository" "platform" {
  name         = "launchpad"
  description  = "Self-service developer platform: one click creates a repo, CI pipeline and GitOps deployment on Kubernetes (k3d, Argo CD, Prometheus, Grafana, Loki)."
  homepage_url = "https://${lower(var.owner)}.github.io/launchpad/"
  visibility   = "public"
  topics       = concat(local.common_topics, ["k3d", "prometheus", "grafana", "loki", "opentofu", "internal-developer-platform"])

  has_issues           = true
  has_wiki             = false
  has_projects         = false
  has_downloads        = false
  vulnerability_alerts = true

  allow_merge_commit     = false
  delete_branch_on_merge = true

  # The interactive portal demo is deployed by .github/workflows/pages.yml
  pages {
    build_type = "workflow"
  }
}
