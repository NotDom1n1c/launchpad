<#
  LAUNCHPAD control script for Windows.

    .\launchpad.ps1 setup    one-time: WSL distro "launchpad" + Docker Engine, k3d, kubectl, helm
    .\launchpad.ps1 up       build the whole platform (cluster, Argo CD, everything from Git)
    .\launchpad.ps1 stop     pause it and give all RAM back to Windows
    .\launchpad.ps1 start    resume after stop (about 1 minute)
    .\launchpad.ps1 status   apps, sync and health
    .\launchpad.ps1 smoke    run the end-to-end checks
    .\launchpad.ps1 chaos    break an app on purpose:  .\launchpad.ps1 chaos gambit
    .\launchpad.ps1 open     open the portal in the browser
    .\launchpad.ps1 down     delete the cluster (Git keeps everything, "up" rebuilds it)
    .\launchpad.ps1 remove   delete the cluster AND the WSL distro (frees all disk space)

  Optional: $env:DISCORD_WEBHOOK = "https://discord.com/api/webhooks/..." before "up" for alerts.
#>
param(
  [Parameter(Position = 0)][ValidateSet('setup', 'up', 'stop', 'start', 'status', 'smoke', 'chaos', 'open', 'down', 'remove', 'help')]
  [string]$Command = 'help',
  [Parameter(Position = 1)][string]$App = 'gambit'
)
$ErrorActionPreference = 'Stop'
$Distro = 'launchpad'

# Repo path as WSL sees it (C:\x\y -> /mnt/c/x/y)
$Repo = $PSScriptRoot
$WslRepo = '/mnt/' + $Repo.Substring(0, 1).ToLower() + ($Repo.Substring(2) -replace '\\', '/')

function In-Wsl([string]$Script) {
  wsl.exe -d $Distro -u root --cd "$WslRepo" -- bash -lc $Script
  if ($LASTEXITCODE -ne 0) { throw "failed: $Script" }
}

function Test-Distro {
  $list = (wsl.exe -l -q) -replace "`0", '' | ForEach-Object { $_.Trim() }
  return $list -contains $Distro
}

switch ($Command) {
  'setup' {
    if (-not (Test-Distro)) {
      Write-Host '==> Creating WSL distro "launchpad" (Ubuntu 24.04)' -ForegroundColor DarkYellow
      wsl.exe --install Ubuntu-24.04 --name $Distro --no-launch
      if ($LASTEXITCODE -ne 0) { throw 'WSL install failed. Did you reboot after installing WSL?' }
    }
    In-Wsl 'bash scripts/setup-wsl.sh'
    Write-Host "`nSetup done. Next: .\launchpad.ps1 up" -ForegroundColor Green
  }
  'up' {
    # The portal creates repos with your GitHub CLI login. The token goes into a cluster secret, never into Git.
    $env:GITHUB_TOKEN = (gh auth token 2>$null)
    $env:WSLENV = 'GITHUB_TOKEN/u:GHCR_TOKEN/u:DISCORD_WEBHOOK/u'
    In-Wsl 'bash scripts/up.sh'
  }
  'stop' {
    In-Wsl 'k3d cluster stop launchpad'
    wsl.exe --shutdown
    Write-Host 'Stopped. WSL is shut down, RAM is free again.' -ForegroundColor Green
  }
  'start' {
    In-Wsl 'systemctl start docker 2>/dev/null || service docker start; k3d cluster start launchpad && kubectl config use-context k3d-launchpad >/dev/null'
    Write-Host 'Started. Apps are back in about a minute: http://launchpad.localhost' -ForegroundColor Green
  }
  'status' { In-Wsl "kubectl -n argocd get applications -o custom-columns='APP:.metadata.name,SYNC:.status.sync.status,HEALTH:.status.health.status,REVISION:.status.sync.revision'" }
  'smoke'  { In-Wsl 'bash scripts/smoke-test.sh' }
  'chaos'  { In-Wsl "bash scripts/chaos.sh $App" }
  'open'   { Start-Process 'http://launchpad.localhost' }
  'down'   { In-Wsl 'bash scripts/down.sh' }
  'remove' {
    if (Test-Distro) { wsl.exe --unregister $Distro }
    Write-Host 'Removed the cluster and the WSL distro. The code stays on GitHub.' -ForegroundColor Green
  }
  default { (Get-Content $PSCommandPath -TotalCount 17 | Select-Object -Skip 1) -join "`n" | Write-Host }
}
