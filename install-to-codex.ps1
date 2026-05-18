param(
    [switch]$ApplyConfig
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$sourceCodex = Join-Path $repoRoot ".codex"
$targetCodex = Join-Path $HOME ".codex"
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"

if (-not (Test-Path -LiteralPath $sourceCodex)) {
    throw "Missing source folder: $sourceCodex"
}

New-Item -ItemType Directory -Path $targetCodex -Force | Out-Null

foreach ($name in @("skills", "agents", "prompts", "rules")) {
    $src = Join-Path $sourceCodex $name
    $dst = Join-Path $targetCodex $name
    if (Test-Path -LiteralPath $src) {
        if (Test-Path -LiteralPath $dst) {
            Rename-Item -LiteralPath $dst -NewName "$name.backup-$stamp"
        }
        Copy-Item -LiteralPath $src -Destination $targetCodex -Recurse -Force
        Write-Host "Copied $name"
    }
}

foreach ($name in @("AGENTS.md", "hooks.json")) {
    $src = Join-Path $sourceCodex $name
    $dst = Join-Path $targetCodex $name
    if (Test-Path -LiteralPath $src) {
        if (Test-Path -LiteralPath $dst) {
            Copy-Item -LiteralPath $dst -Destination "$dst.backup-$stamp" -Force
        }
        Copy-Item -LiteralPath $src -Destination $dst -Force
        Write-Host "Copied $name"
    }
}

if ($ApplyConfig) {
    $src = Join-Path $sourceCodex "config.example.toml"
    $dst = Join-Path $targetCodex "config.toml"
    if (-not (Test-Path -LiteralPath $src)) {
        throw "Missing config example: $src"
    }
    if (Test-Path -LiteralPath $dst) {
        Copy-Item -LiteralPath $dst -Destination "$dst.backup-$stamp" -Force
    }
    Copy-Item -LiteralPath $src -Destination $dst -Force
    Write-Host "Copied config.toml from config.example.toml"
}

Write-Host "Done. Restart Codex after installing these settings."
