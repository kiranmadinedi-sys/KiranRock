# Start Backend with Telegram Configuration
# This script starts the backend server with proper Telegram environment variables

Write-Host "Starting KiranRock Trading Platform Backend..." -ForegroundColor Cyan
Write-Host ""

# Set Telegram Bot Token
$env:TELEGRAM_BOT_TOKEN = "8520099950:AAFAAZrQCEK9B6wARjpoYDiqP3zNsaMz52Q"
Write-Host "✓ Telegram Bot Token configured (@KiranTradePro_bot)" -ForegroundColor Green

# Set Telegram Chat ID (default to personal chat, can be overridden)
$env:TELEGRAM_CHAT_ID = "8574952938"  # Personal chat
# $env:TELEGRAM_CHAT_ID = "-5063427459"  # Group chat (uncomment when group is configured)
Write-Host "✓ Telegram Chat ID configured (Personal: 8574952938)" -ForegroundColor Green

Write-Host ""
Write-Host "Starting server..." -ForegroundColor Yellow
Write-Host "Weekly reports scheduled for:" -ForegroundColor Yellow
Write-Host "  - 7:00 AM CST" -ForegroundColor White
Write-Host "  - 2:45 PM CST" -ForegroundColor White
Write-Host ""

# Navigate to backend directory
Set-Location $PSScriptRoot

# Start the server
node src/app.js
