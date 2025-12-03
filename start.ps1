# Trading Platform Startup Script
# Run this script to start both backend and frontend servers

Write-Host "Starting Advanced Trading Platform..." -ForegroundColor Green
Write-Host ""

# Start Backend Server
Write-Host "Starting Backend Server on Port 3001..." -ForegroundColor Cyan
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd C:\SecondProject\backend; npm start"

# Wait 3 seconds for backend to initialize
Start-Sleep -Seconds 3

# Start Frontend Server
Write-Host "Starting Frontend Server on Port 3000..." -ForegroundColor Cyan
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd C:\SecondProject\frontend; npm run dev"

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
