# Install the `cl` shim on Windows.
#
#   powershell -ExecutionPolicy Bypass -File install.ps1
#
# Writes %USERPROFILE%\bin\cl.cmd and makes sure that directory is on PATH.
# Idempotent: safe to re-run.

$ErrorActionPreference = 'Stop'

$launcher = Join-Path $env:USERPROFILE '.claude\launcher\cl.mjs'
$binDir   = Join-Path $env:USERPROFILE 'bin'
$shim     = Join-Path $binDir 'cl.cmd'

Write-Host ''
Write-Host 'cl — install' -ForegroundColor Cyan
Write-Host ''

# node
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Host '  x node is not on PATH. Install Node 18 or newer first.' -ForegroundColor Red
    exit 1
}
$version = (& node --version)
Write-Host "  + node $version" -ForegroundColor Green

if (-not (Test-Path $launcher)) {
    Write-Host "  x launcher not found at $launcher" -ForegroundColor Red
    exit 1
}
Write-Host "  + launcher $launcher" -ForegroundColor Green

# shim
if (-not (Test-Path $binDir)) { New-Item -ItemType Directory -Path $binDir | Out-Null }

$content = @"
@echo off
node "%USERPROFILE%\.claude\launcher\cl.mjs" %*
"@
Set-Content -Path $shim -Value $content -Encoding ascii
Write-Host "  + shim    $shim" -ForegroundColor Green

# PATH
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$parts = $userPath -split ';' | Where-Object { $_ -ne '' }
$onPath = @($parts | Where-Object { $_.TrimEnd('\') -ieq $binDir.TrimEnd('\') }).Count -gt 0
if ($onPath) {
    Write-Host "  + PATH    already contains $binDir" -ForegroundColor Green
} else {
    [Environment]::SetEnvironmentVariable('Path', (($parts + $binDir) -join ';'), 'User')
    Write-Host "  + PATH    added $binDir (restart your terminal)" -ForegroundColor Yellow
}

# PowerShell function.
#
# This is what actually makes `cl` resolve in PowerShell. A shim in ~\bin is
# useless if that directory is not on PATH, and PATH edits only reach new
# terminals — the function is defined by the profile every session, so it is the
# more reliable of the two. Both are installed.
if (Test-Path $PROFILE) {
    $profileText = Get-Content $PROFILE -Raw
} else {
    New-Item -ItemType File -Path $PROFILE -Force | Out-Null
    $profileText = ''
}

if ($profileText -match 'function\s+cl\b') {
    if ($profileText -match 'cl\.mjs') {
        Write-Host '  + profile function cl already points at cl.mjs' -ForegroundColor Green
    } else {
        Write-Host '  ! profile has a cl function pointing somewhere else' -ForegroundColor Yellow
        Write-Host '            it will shadow the shim. Edit it to:' -ForegroundColor Yellow
        Write-Host '            function cl { node "$env:USERPROFILE\.claude\launcher\cl.mjs" @args }'
    }
} else {
    $fn = 'function cl { node "$env:USERPROFILE\.claude\launcher\cl.mjs" @args }'
    Add-Content -Path $PROFILE -Value "`r`n$fn" -Encoding utf8
    Write-Host "  + profile added cl function to $PROFILE" -ForegroundColor Green
}

Write-Host ''
Write-Host '  open a NEW terminal, then: cl' -ForegroundColor Cyan
Write-Host '  check: cl doctor'
Write-Host ''
