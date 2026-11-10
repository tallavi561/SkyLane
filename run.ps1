# Installs dependencies (if needed) and starts both SkyLane services, each in
# its own PowerShell window so you can see their logs and stop them with Ctrl+C.
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

Ensure-Installed (Join-Path $root "flight-plan-service")
Ensure-Installed (Join-Path $root "traffic-service")

Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$root\flight-plan-service'; npm start"
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$root\traffic-service'; npm start"

Write-Host "flight-plan-service -> http://localhost:4001"
Write-Host "traffic-service     -> http://localhost:4000"
Write-Host "Open http://localhost:4000 in your browser for the map."
