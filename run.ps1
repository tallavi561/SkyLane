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

Ensure-Installed (Join-Path $root "drone-fleet-service")
Ensure-Installed (Join-Path $root "order-service")

Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$root\drone-fleet-service'; npm start"
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$root\order-service'; npm start"

Write-Host "drone-fleet-service -> http://localhost:4001"
Write-Host "order-service       -> http://localhost:4000"
Write-Host "Open http://localhost:4000 in your browser for the map."
