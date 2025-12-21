# Trading Platform Startup Script
# Run this script to start both backend and frontend servers

# Resolve project root and app paths relative to this script
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$backendPath = Join-Path $projectRoot "backend"
$frontendPath = Join-Path $projectRoot "frontend"

# Verify directories exist
if (-not (Test-Path $backendPath)) { Write-Error "Backend path not found: $backendPath"; exit 1 }
if (-not (Test-Path $frontendPath)) { Write-Error "Frontend path not found: $frontendPath"; exit 1 }

Write-Host "Starting Advanced Trading Platform..." -ForegroundColor Green
Write-Host ""

# Start Backend Server with Configuration
Write-Host "Starting Backend Server on Port 3001..." -ForegroundColor Cyan
Write-Host "  - Telegram Bot: @KiranTradePro_bot" -ForegroundColor Gray
Write-Host "  - Weekly Reports: 7:00 AM & 2:45 PM CST" -ForegroundColor Gray
Write-Host "  - Email OTP Verification Enabled" -ForegroundColor Gray

# Configure email for OTP (update with your credentials)
$emailUser = "tradeagent0007@gmail.com"
$emailPassword = "uclt gvvp vemy opib"

$backendCommand = "cd `"$backendPath`"; `$env:TELEGRAM_BOT_TOKEN = '8520099950:AAFAAZrQCEK9B6wARjpoYDiqP3zNsaMz52Q'; `$env:TELEGRAM_CHAT_ID = '8574952938'; `$env:EMAIL_USER = '$emailUser'; `$env:EMAIL_PASSWORD = '$emailPassword'; npm start"
Start-Process powershell -ArgumentList "-NoExit", "-Command", $backendCommand

# Wait 3 seconds for backend to initialize
Start-Sleep -Seconds 3

# Start Frontend Server
Write-Host "Starting Frontend Server on Port 3000..." -ForegroundColor Cyan
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd `"$frontendPath`"; npm run dev"

# Wait for frontend to start
Start-Sleep -Seconds 5

Write-Host ""
Write-Host "Servers Started Successfully!" -ForegroundColor Green
Write-Host ""
Write-Host "Backend API: http://localhost:3001" -ForegroundColor Yellow
Write-Host "Frontend App: http://localhost:3000" -ForegroundColor Yellow
Write-Host ""
Write-Host "Press Ctrl+C in each terminal to stop the servers" -ForegroundColor Gray
Write-Host ""

# Optional: Open browser automatically
$response = Read-Host "Open browser automatically? (Y/N)"
if ($response -eq 'Y' -or $response -eq 'y') {
    Start-Process "http://localhost:3000"
    Write-Host "Opening browser..." -ForegroundColor Green
}

Write-Host ""
Write-Host "Trading Platform is ready! Happy trading!" -ForegroundColor Magenta
