output "templates" {
  description = "Template repositories the portal creates new apps from"
  value       = { for k, r in github_repository.template : k => r.html_url }
}

output "platform_repo" {
  value = github_repository.platform.html_url
}

output "demo_url" {
  value = github_repository_pages.demo.html_url
}
