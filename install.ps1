# Thin wrapper so the PowerShell habit works. The real installer is
# install.mjs — cross-platform, and it resolves this checkout's location
# itself.
#
#   powershell -ExecutionPolicy Bypass -File install.ps1

$ErrorActionPreference = 'Stop'

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host 'x node is not on PATH. Install Node 18 or newer first.' -ForegroundColor Red
    exit 1
}

& node (Join-Path $PSScriptRoot 'install.mjs') @args

# PowerShell resolves a function before PATH, so a leftover `cl` function from
# an older install silently shadows the shim. Point it out rather than let it
# win quietly.
if (Test-Path $PROFILE) {
    $text = Get-Content $PROFILE -Raw
    if ($text -match 'function\s+cl\b' -and $text -notmatch [regex]::Escape($PSScriptRoot)) {
        Write-Host ''
        Write-Host '  ! your PowerShell profile defines a cl function pointing elsewhere.' -ForegroundColor Yellow
        Write-Host '    It shadows the shim. Replace it with:' -ForegroundColor Yellow
        Write-Host "    function cl { node `"$PSScriptRoot\cl.mjs`" @args }"
    }
}
