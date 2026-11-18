# Installs dependencies (if needed) and starts all three SkyLane services,
# each in its own tab of a single Windows Terminal window (or its own PowerShell
# window if Windows Terminal isn't installed) so you can see their logs and stop
# them with Ctrl+C.
#
# Usage:
#   .\run.ps1

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot

function Ensure-Installed($dir) {
    if (-not (Test-Path (Join-Path $dir "node_modules"))) {
        Write-Host "Installing dependencies in $dir..."
        Push-Location $dir
        npm install
        Pop-Location
    }
}

Ensure-Installed (Join-Path $root "drone-fleet-service")
Ensure-Installed (Join-Path $root "pricing-service")
Ensure-Installed (Join-Path $root "order-service")

$services = "drone-fleet-service", "pricing-service", "order-service"

# MoSes rejects logs and heartbeats without an API key. Take it from this shell or from the
# user environment variable MOSES_API_KEY and set it inside each tab: a tab opened by an
# already-running Windows Terminal does not reliably inherit this script's environment.
$mosesKey = $env:MOSES_API_KEY
if (-not $mosesKey) { $mosesKey = [Environment]::GetEnvironmentVariable("MOSES_API_KEY", "User") }
$tabEnv = ""
if ($mosesKey) {
    $tabEnv = "`$env:MOSES_API_KEY = '$($mosesKey.Replace("'", "''"))'; "
}
else {
    Write-Host "MOSES_API_KEY is not set - MoSes will reject this app's logs and heartbeats." -ForegroundColor Yellow
    Write-Host "Create a key in MoSes (Settings -> Environments and keys), then:" -ForegroundColor Yellow
    Write-Host "  [Environment]::SetEnvironmentVariable('MOSES_API_KEY', 'msk_...', 'User')" -ForegroundColor Yellow
}

# Prefer Windows Terminal: one window with a tab per service.
$wt = (Get-Command wt.exe -ErrorAction SilentlyContinue).Source
if (-not $wt) {
    $candidate = Join-Path $env:LOCALAPPDATA "Microsoft\WindowsApps\wt.exe"
    if (Test-Path $candidate) { $wt = $candidate }
}

if ($wt) {
    $tabs = foreach ($name in $services) {
        # -EncodedCommand keeps quotes and ';' (Windows Terminal's own separator) out of the command line.
        $encoded = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes("${tabEnv}npm start"))
        "new-tab --title `"$name`" --suppressApplicationTitle -d `"$root\$name`" powershell -NoExit -EncodedCommand $encoded"
    }
    # " ; " separates Windows Terminal sub-commands; "-w new" puts them all in one new window.
    Start-Process $wt -ArgumentList ("-w new " + ($tabs -join " ; "))
}
else {
    # No Windows Terminal: fall back to a separate PowerShell window per service.
    foreach ($name in $services) {
        Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$root\$name'; ${tabEnv}npm start"
    }
}

Write-Host "drone-fleet-service -> http://localhost:4001"
Write-Host "pricing-service     -> http://localhost:4002"
Write-Host "order-service       -> http://localhost:4000"
Write-Host "Open http://localhost:4000 in your browser for the map."
