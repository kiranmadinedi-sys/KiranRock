# ================================================================
#  KiranRock Trading Platform - Startup Script
#  Starts: Backend (port 3001) + Frontend (port 3000)
#  Weekly Telegram reports are built into the backend (auto-loaded)
# ================================================================

$projectRoot  = Split-Path -Parent $MyInvocation.MyCommand.Path
$backendPath  = Join-Path $projectRoot "backend"
$frontendPath = Join-Path $projectRoot "frontend"

if (-not (Test-Path $backendPath))  { Write-Error "Backend not found: $backendPath";  exit 1 }
if (-not (Test-Path $frontendPath)) { Write-Error "Frontend not found: $frontendPath"; exit 1 }

Write-Host ""
Write-Host "===============================================" -ForegroundColor Cyan
Write-Host "   KiranRock AI Trading Platform" -ForegroundColor Cyan
Write-Host "   Alpaca Paper Trading | PostgreSQL" -ForegroundColor Cyan
Write-Host "===============================================" -ForegroundColor Cyan
Write-Host ""

# Kill any existing Node.js processes
$existing = Get-Process node -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "Stopping $($existing.Count) existing Node.js process(es)..." -ForegroundColor Yellow
    $existing | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
    Write-Host "Stopped." -ForegroundColor Green
} else {
    Write-Host "No existing Node.js processes found." -ForegroundColor Gray
}
Write-Host ""

# Secrets injected into backend environment
$telegramBotToken = "8520099950:AAFAAZrQCEK9B6wARjpoYDiqP3zNsaMz52Q"
$telegramChatId   = "8574952938"
$emailUser        = "tradeagent0007@gmail.com"
$emailPassword    = "uclt gvvp vemy opib"

# ----------------------------------------------------------------
#  Start Backend
# ----------------------------------------------------------------
Write-Host "[1/2] Starting Backend on port 3001..." -ForegroundColor Cyan
Write-Host "      AI Bot | Options Scanner | Telegram Reports (Mon/Wed 6 AM)" -ForegroundColor Gray

$backendCommand = "cd '$backendPath'; " +
    "`$env:TELEGRAM_BOT_TOKEN = '$telegramBotToken'; " +
    "`$env:TELEGRAM_CHAT_ID   = '$telegramChatId'; " +
    "`$env:EMAIL_USER         = '$emailUser'; " +
    "`$env:EMAIL_PASSWORD     = '$emailPassword'; " +
    "`$env:NODE_ENV           = 'development'; " +
    "Write-Host ''; " +
    "Write-Host '=== BACKEND (port 3001) ===' -ForegroundColor Cyan; " +
    "Write-Host ''; " +
    "npm start"

Start-Process powershell -ArgumentList "-NoExit", "-Command", $backendCommand

Write-Host "      Waiting 10s for backend to initialize..." -ForegroundColor Gray
Start-Sleep -Seconds 10

try {
    $health = Invoke-RestMethod -Uri "http://localhost:3001/health" -TimeoutSec 5 -ErrorAction Stop
    Write-Host "      Health: $($health.status) | DB: $($health.db) | Provider: $($health.provider)" -ForegroundColor Green
} catch {
    Write-Host "      (Backend still starting - continuing)" -ForegroundColor Yellow
}
Write-Host ""

# ----------------------------------------------------------------
#  Start Frontend
# ----------------------------------------------------------------
Write-Host "[2/2] Starting Frontend on port 3000..." -ForegroundColor Cyan

$frontendCommand = "cd '$frontendPath'; " +
    "Write-Host ''; " +
    "Write-Host '=== FRONTEND (port 3000) ===' -ForegroundColor Magenta; " +
    "Write-Host ''; " +
    "npm run dev"

Start-Process powershell -ArgumentList "-NoExit", "-Command", $frontendCommand

Start-Sleep -Seconds 8

try {
    $null = Invoke-WebRequest -Uri "http://localhost:3000" -TimeoutSec 5 -ErrorAction Stop
    Write-Host "      Frontend is ready!" -ForegroundColor Green
} catch {
    Write-Host "      (Frontend still compiling - ready in a few seconds)" -ForegroundColor Yellow
}
Write-Host ""

# ----------------------------------------------------------------
#  Summary
# ----------------------------------------------------------------
Write-Host "===============================================" -ForegroundColor Green
Write-Host "   ALL SERVICES STARTED" -ForegroundColor Green
Write-Host "===============================================" -ForegroundColor Green
Write-Host "   Local:    http://localhost:3000" -ForegroundColor White
Write-Host "   Network:  http://99.47.183.33:3000" -ForegroundColor White
Write-Host "   Backend:  http://localhost:3001" -ForegroundColor White
Write-Host "   Health:   http://localhost:3001/health" -ForegroundColor White
Write-Host "-----------------------------------------------" -ForegroundColor Green
Write-Host "   Telegram: @KiranTradePro_bot" -ForegroundColor White
Write-Host "   Reports:  Mon & Wed at 6:00 AM EST (built-in)" -ForegroundColor White
Write-Host "-----------------------------------------------" -ForegroundColor Green
Write-Host "   To stop:  Stop-Process -Name node -Force" -ForegroundColor Gray
Write-Host "===============================================" -ForegroundColor Green
Write-Host ""

$open = Read-Host "Open browser now? (Y/N)"
if ($open -eq 'Y' -or $open -eq 'y') {
    Start-Process "http://localhost:3000"
}

Write-Host ""
Write-Host "Happy Trading!" -ForegroundColor Magenta
Write-Host ""
