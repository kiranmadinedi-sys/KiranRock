# ================================================================
#  KiranRock Trading Platform - Startup Script
#  Starts: Backend API (port 3001) + Worker + Frontend (port 3000)
#  Also runs one startup stock-signal Telegram delivery pass
#  Schedulers and Telegram reports run in the dedicated worker process
# ================================================================

[CmdletBinding()]
param(
    [switch]$NoPrompt,
    [switch]$NonInteractive
)

$projectRoot  = Split-Path -Parent $MyInvocation.MyCommand.Path
$backendPath  = Join-Path $projectRoot "backend"
$frontendPath = Join-Path $projectRoot "frontend"
$backendEnvPath = Join-Path $backendPath ".env"
$startupStatusPath = Join-Path $projectRoot ".startup-status"

if (-not (Test-Path $backendPath))  { Write-Error "Backend not found: $backendPath";  exit 1 }
if (-not (Test-Path $frontendPath)) { Write-Error "Frontend not found: $frontendPath"; exit 1 }
if (-not (Test-Path $startupStatusPath)) { New-Item -ItemType Directory -Path $startupStatusPath -Force | Out-Null }

function Get-EnvFileValue {
    param(
        [string]$Path,
        [string]$Name
    )

    if (-not (Test-Path $Path)) {
        return $null
    }

    $match = Get-Content $Path | Where-Object {
        $_ -match "^\s*$([regex]::Escape($Name))\s*="
    } | Select-Object -First 1

    if (-not $match) {
        return $null
    }

    $value = ($match -split '=', 2)[1].Trim()
    if ($value.Length -ge 2) {
        if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
            $value = $value.Substring(1, $value.Length - 2)
        }
    }

    return $value
}

function Resolve-SecretValue {
    param(
        [string]$Name
    )

    if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($Name))) {
        return Get-EnvFileValue -Path $backendEnvPath -Name $Name
    }

    return [Environment]::GetEnvironmentVariable($Name)
}

function ConvertTo-PowerShellSingleQuotedLiteral {
    param(
        [AllowNull()]
        [string]$Value
    )

    if ($null -eq $Value) {
        return "''"
    }

    return "'" + $Value.Replace("'", "''") + "'"
}

function Write-StatusFile {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,

        [Parameter(Mandatory = $true)]
        [string]$Status,

        [AllowNull()]
        [string]$Message,

        [AllowNull()]
        [int]$ExitCode
    )

    $payload = [ordered]@{
        status = $Status
        timestamp = (Get-Date).ToString('o')
    }

    if (-not [string]::IsNullOrWhiteSpace($Message)) {
        $payload.message = $Message
    }

    if ($null -ne $ExitCode) {
        $payload.exitCode = $ExitCode
    }

    $payload | ConvertTo-Json -Compress | Set-Content -Path $Path -Encoding UTF8
}

function Read-StatusFile {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    if (-not (Test-Path $Path)) {
        return $null
    }

    try {
        $raw = Get-Content -Path $Path -Raw -ErrorAction Stop
        if ([string]::IsNullOrWhiteSpace($raw)) {
            return $null
        }

        return $raw | ConvertFrom-Json -ErrorAction Stop
    } catch {
        return $null
    }
}

function Get-DescendantProcessIds {
    param(
        [Parameter(Mandatory = $true)]
        [int[]]$ParentIds,

        [Parameter(Mandatory = $true)]
        [System.Collections.Generic.List[object]]$Processes
    )

    $descendantIds = New-Object 'System.Collections.Generic.HashSet[int]'
    $pendingParentIds = [System.Collections.Generic.Queue[int]]::new()

    foreach ($parentId in $ParentIds) {
        $pendingParentIds.Enqueue($parentId)
    }

    while ($pendingParentIds.Count -gt 0) {
        $currentParentId = $pendingParentIds.Dequeue()
        foreach ($process in $Processes) {
            if ($process.ParentProcessId -eq $currentParentId -and $descendantIds.Add([int]$process.ProcessId)) {
                $pendingParentIds.Enqueue([int]$process.ProcessId)
            }
        }
    }

    return @($descendantIds)
}

function Get-AncestorProcessIds {
    param(
        [Parameter(Mandatory = $true)]
        [int[]]$ProcessIds,

        [Parameter(Mandatory = $true)]
        [System.Collections.Generic.List[object]]$Processes,

        [int[]]$StopAtProcessIds = @()
    )

    $ancestorIds = New-Object 'System.Collections.Generic.HashSet[int]'
    $stopAtIds = New-Object 'System.Collections.Generic.HashSet[int]'
    $processById = @{}

    foreach ($stopAtProcessId in $StopAtProcessIds) {
        $null = $stopAtIds.Add([int]$stopAtProcessId)
    }

    foreach ($process in $Processes) {
        $processById[[int]$process.ProcessId] = $process
    }

    foreach ($processId in $ProcessIds) {
        $currentProcessId = [int]$processId

        while ($processById.ContainsKey($currentProcessId)) {
            $parentProcessId = [int]$processById[$currentProcessId].ParentProcessId

            if ($parentProcessId -le 0 -or $stopAtIds.Contains($parentProcessId) -or -not $processById.ContainsKey($parentProcessId)) {
                break
            }

            $parentProcess = $processById[$parentProcessId]
            $parentCommandLine = $parentProcess.CommandLine

            if (-not [string]::IsNullOrWhiteSpace($parentCommandLine) -and $parentCommandLine.ToLowerInvariant().Contains('shellintegration.ps1')) {
                break
            }

            if (-not $ancestorIds.Add($parentProcessId)) {
                break
            }

            $currentProcessId = $parentProcessId
        }
    }

    return @($ancestorIds)
}

function Get-ProjectProcesses {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ProjectRoot,

        [Parameter(Mandatory = $true)]
        [string]$BackendPath,

        [Parameter(Mandatory = $true)]
        [string]$FrontendPath
    )

    $normalizedProjectRoot = $ProjectRoot.ToLowerInvariant()
    $normalizedBackendPath = $BackendPath.ToLowerInvariant()
    $normalizedFrontendPath = $FrontendPath.ToLowerInvariant()

    $allProcesses = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)

    if ($allProcesses.Count -eq 0) {
        return @()
    }

    $candidateProcesses = @($allProcesses | Where-Object {
        $commandLine = $_.CommandLine
        if ([string]::IsNullOrWhiteSpace($commandLine)) {
            return $false
        }

        # Skip VS Code / Claude Code processes — they reference the project path but
        # are not KiranRock services. Must not be killed.
        $procName = [string]$_.Name
        if ($procName.ToLowerInvariant() -eq 'code.exe') { return $false }
        $normalizedCL = $commandLine.ToLowerInvariant()
        if ($normalizedCL -match 'extensionhost|\.vscode\\|shellintegration|claude-code|claude\.exe') {
            return $false
        }

        $normalizedCommandLine = $commandLine.ToLowerInvariant()
        return $normalizedCommandLine.Contains($normalizedProjectRoot) -or
            $normalizedCommandLine.Contains($normalizedBackendPath) -or
            $normalizedCommandLine.Contains($normalizedFrontendPath)
    })

    if ($candidateProcesses.Count -eq 0) {
        $candidateProcesses = @()
    }

    $rootProcessIds = @($candidateProcesses | Where-Object {
        $_.CommandLine -match 'npm\s+start' -or
        $_.CommandLine -match 'npm\s+run\s+start:worker' -or
        $_.CommandLine -match 'npm\s+run\s+run:stock-signals' -or
        $_.CommandLine -match 'npm\s+run\s+dev'
    } | Select-Object -ExpandProperty ProcessId -Unique)

    $listenerProcessIds = @(Get-NetTCPConnection -LocalPort 3000,3001 -State Listen -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty OwningProcess -Unique)

    $serviceProcessIds = @($allProcesses | Where-Object {
        $commandLine = $_.CommandLine
        if ([string]::IsNullOrWhiteSpace($commandLine)) {
            return $false
        }

        $normalizedCommandLine = $commandLine.ToLowerInvariant()
        return $normalizedCommandLine -match '(^|[\s"''])src[\\/]app\.js($|[\s"''])' -or
            $normalizedCommandLine -match '(^|[\s"''])src[\\/]worker\.js($|[\s"''])' -or
            $normalizedCommandLine -match '(^|[\s"''])src[\\/]runstocksignalcycle\.js($|[\s"''])' -or
            $normalizedCommandLine -match 'node_modules[\\/](?:next[\\/]dist[\\/]server[\\/]lib[\\/]start-server\.js)' -or
            $normalizedCommandLine -match 'node_modules[\\/]\.bin[\\/].*next[\\/]dist[\\/]bin[\\/]next(?:\.js)?([\s"'']|$)' -or
            $normalizedCommandLine -match 'node_modules[\\/]next[\\/]dist[\\/]telemetry[\\/]detached-flush\.js([\s"'']|$)' -or
            $normalizedCommandLine -match 'npm[\\/]bin[\\/]npm-cli\.js["'']?\s+run\s+dev($|\s)' -or
            $normalizedCommandLine -match 'npm[\\/]bin[\\/]npm-cli\.js["'']?\s+run\s+run:stock-signals($|\s)'
    } | Select-Object -ExpandProperty ProcessId -Unique)

    $seedProcessIds = @($rootProcessIds + $listenerProcessIds + $serviceProcessIds | Sort-Object -Unique)

    if ($seedProcessIds.Count -eq 0) {
        return @()
    }

    $ancestorProcessIds = Get-AncestorProcessIds -ProcessIds $seedProcessIds -Processes ([System.Collections.Generic.List[object]]$allProcesses) -StopAtProcessIds @($PID)
    $descendantProcessIds = Get-DescendantProcessIds -ParentIds $seedProcessIds -Processes ([System.Collections.Generic.List[object]]$allProcesses)
    $allProjectProcessIds = @($seedProcessIds + $ancestorProcessIds + $descendantProcessIds | Sort-Object -Unique)

    return @($allProcesses | Where-Object { $allProjectProcessIds -contains $_.ProcessId })
}

function Get-ProjectProcessRole {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Process,

        [Parameter(Mandatory = $true)]
        [string]$BackendPath,

        [Parameter(Mandatory = $true)]
        [string]$FrontendPath
    )

    $commandLine = [string]$Process.CommandLine
    if ([string]::IsNullOrWhiteSpace($commandLine)) {
        return 'unknown'
    }

    $normalizedCommandLine = $commandLine.ToLowerInvariant()
    $normalizedBackendPath = $BackendPath.ToLowerInvariant()
    $normalizedFrontendPath = $FrontendPath.ToLowerInvariant()

    if ($normalizedCommandLine -match '(^|[\s"''])src[\\/]worker\.js($|[\s"''])' -or
        $normalizedCommandLine -match '(^|[\s"''])src[\\/]runstocksignalcycle\.js($|[\s"''])' -or
        $normalizedCommandLine -match 'npm[\\/]bin[\\/]npm-cli\.js["'']?\s+run\s+start:worker($|\s)' -or
        $normalizedCommandLine -match 'npm[\\/]bin[\\/]npm-cli\.js["'']?\s+run\s+run:stock-signals($|\s)') {
        return 'worker'
    }

    if ($normalizedCommandLine -match '(^|[\s"''])src[\\/]app\.js($|[\s"''])' -or
        $normalizedCommandLine -match 'npm\s+start($|\s)' -or
        $normalizedCommandLine.Contains($normalizedBackendPath)) {
        return 'backend'
    }

    if ($normalizedCommandLine -match 'node_modules[\\/]next[\\/]' -or
        $normalizedCommandLine -match 'next\s+dev($|\s)' -or
        $normalizedCommandLine -match 'npm[\\/]bin[\\/]npm-cli\.js["'']?\s+run\s+dev($|\s)' -or
        $normalizedCommandLine.Contains($normalizedFrontendPath)) {
        return 'frontend'
    }

    return 'unknown'
}

function Write-ShutdownSummary {
    param(
        [array]$PassSummaries
    )

    if ($null -eq $PassSummaries -or $PassSummaries.Count -eq 0) {
        return
    }

    Write-Host "Shutdown summary:" -ForegroundColor DarkGray

    foreach ($summary in $PassSummaries) {
        $parts = @()
        foreach ($role in @('backend', 'worker', 'frontend', 'unknown')) {
            $stoppedIds = @($summary.StoppedByRole[$role])
            $skippedIds = @($summary.SkippedByRole[$role])

            if ($stoppedIds.Count -gt 0) {
                $parts += "$role stopped=$($stoppedIds -join ',')"
            }

            if ($skippedIds.Count -gt 0) {
                $parts += "$role skipped=$($skippedIds -join ',')"
            }
        }

        if ($parts.Count -eq 0) {
            $parts += 'no processes handled'
        }

        Write-Host ("  Pass {0}: {1}" -f $summary.PassNumber, ($parts -join ' | ')) -ForegroundColor DarkGray
    }
}

function Stop-ProjectProcesses {
    param(
        [AllowNull()]
        [array]$Processes,

        [Parameter(Mandatory = $true)]
        [int]$PassNumber,

        [Parameter(Mandatory = $true)]
        [string]$BackendPath,

        [Parameter(Mandatory = $true)]
        [string]$FrontendPath
    )

    $stoppedByRole = @{
        backend = @()
        worker = @()
        frontend = @()
        unknown = @()
    }

    $skippedByRole = @{
        backend = @()
        worker = @()
        frontend = @()
        unknown = @()
    }

    if ($null -eq $Processes -or $Processes.Count -eq 0) {
        return [pscustomobject]@{
            PassNumber = $PassNumber
            StoppedByRole = $stoppedByRole
            SkippedByRole = $skippedByRole
        }
    }

    $processesToStop = @($Processes | Sort-Object ParentProcessId, ProcessId -Descending)
    Write-Host "Stopping $($processesToStop.Count) existing KiranRock process(es)..." -ForegroundColor Yellow

    foreach ($process in $processesToStop) {
        $role = Get-ProjectProcessRole -Process $process -BackendPath $BackendPath -FrontendPath $FrontendPath

        try {
            Stop-Process -Id $process.ProcessId -Force -ErrorAction Stop
            $stoppedByRole[$role] += [int]$process.ProcessId
        } catch {
            Write-Host "  Skipped PID $($process.ProcessId) ($($process.Name))" -ForegroundColor DarkYellow
            $skippedByRole[$role] += [int]$process.ProcessId
        }
    }

    Start-Sleep -Seconds 2

    return [pscustomobject]@{
        PassNumber = $PassNumber
        StoppedByRole = $stoppedByRole
        SkippedByRole = $skippedByRole
    }
}

Write-Host ""
Write-Host "===============================================" -ForegroundColor Cyan
Write-Host "   KiranRock AI Trading Platform" -ForegroundColor Cyan
Write-Host "   Alpaca Paper Trading | PostgreSQL" -ForegroundColor Cyan
Write-Host "===============================================" -ForegroundColor Cyan
Write-Host ""

# Stop only KiranRock processes from previous runs
$remainingProjectProcesses = @()
$projectProcessesStopped = $false
$shutdownPassSummaries = @()

for ($attempt = 1; $attempt -le 3; $attempt++) {
    $existingProjectProcesses = Get-ProjectProcesses -ProjectRoot $projectRoot -BackendPath $backendPath -FrontendPath $frontendPath

    if ($existingProjectProcesses.Count -eq 0) {
        if ($attempt -eq 1) {
            Write-Host "No existing KiranRock service processes found." -ForegroundColor Gray
        } else {
            Write-Host "Stopped project services." -ForegroundColor Green
            $projectProcessesStopped = $true
        }
        break
    }

    if ($attempt -gt 1) {
        Write-Host "Rechecking for lingering KiranRock processes (pass $attempt/3)..." -ForegroundColor Yellow
    }

    $shutdownPassSummaries += Stop-ProjectProcesses -Processes $existingProjectProcesses -PassNumber $attempt -BackendPath $backendPath -FrontendPath $frontendPath
    $remainingProjectProcesses = $existingProjectProcesses
}

if (-not $projectProcessesStopped -and $remainingProjectProcesses.Count -gt 0) {
    $remainingProjectProcesses = Get-ProjectProcesses -ProjectRoot $projectRoot -BackendPath $backendPath -FrontendPath $frontendPath
    if ($remainingProjectProcesses.Count -gt 0) {
        Write-Host "Warning: $($remainingProjectProcesses.Count) KiranRock process(es) are still running after 3 shutdown passes." -ForegroundColor Yellow
    } else {
        Write-Host "Stopped project services." -ForegroundColor Green
    }
}

Write-ShutdownSummary -PassSummaries $shutdownPassSummaries
Write-Host ""

# ----------------------------------------------------------------
#  Cloudflare Tunnel (getmytbot.com -> localhost:3000)
# ----------------------------------------------------------------
Write-Host "[CF] Ensuring Cloudflare tunnel is running..." -ForegroundColor Cyan
$cfExe    = "C:\Program Files (x86)\cloudflared\cloudflared.exe"
$cfConfig = "C:\Users\kiran\.cloudflared\config.yml"
if (Test-Path $cfExe) {
    $cfRunning = Get-Process -Name "cloudflared" -ErrorAction SilentlyContinue
    if ($cfRunning) {
        Write-Host "      Cloudflare tunnel already running (PID: $($cfRunning.Id))" -ForegroundColor DarkGray
    } else {
        $cfProcess = Start-Process -FilePath $cfExe -ArgumentList "tunnel", "--config", $cfConfig, "run" -WindowStyle Hidden -PassThru
        Write-Host "      Cloudflare tunnel started (PID: $($cfProcess.Id))" -ForegroundColor Green
    }
} else {
    Write-Host "      cloudflared.exe not found at $cfExe - skipping tunnel" -ForegroundColor Yellow
}
Write-Host ""

# Secrets injected into backend environment
$telegramBotToken = Resolve-SecretValue -Name "TELEGRAM_BOT_TOKEN"
$telegramChatId   = Resolve-SecretValue -Name "TELEGRAM_CHAT_ID"
$emailUser        = Resolve-SecretValue -Name "EMAIL_USER"
$emailPassword    = Resolve-SecretValue -Name "EMAIL_PASSWORD"

$missingRequiredSecrets = @(
    @{ Name = "TELEGRAM_BOT_TOKEN"; Value = $telegramBotToken },
    @{ Name = "TELEGRAM_CHAT_ID"; Value = $telegramChatId }
) | Where-Object { [string]::IsNullOrWhiteSpace($_.Value) }

if ($missingRequiredSecrets.Count -gt 0) {
    $missingNames = ($missingRequiredSecrets | ForEach-Object { $_.Name }) -join ', '
    Write-Error "Missing required secrets: $missingNames. Set them in the current environment or $backendEnvPath"
    exit 1
}

$missingOptionalSecrets = @(
    @{ Name = "EMAIL_USER"; Value = $emailUser },
    @{ Name = "EMAIL_PASSWORD"; Value = $emailPassword }
) | Where-Object { [string]::IsNullOrWhiteSpace($_.Value) }

if ($missingOptionalSecrets.Count -gt 0) {
    $missingOptionalNames = ($missingOptionalSecrets | ForEach-Object { $_.Name }) -join ', '
    Write-Host "Warning: optional email secrets missing: $missingOptionalNames. OTP and email alerts may be unavailable." -ForegroundColor Yellow
}

$backendPathLiteral = ConvertTo-PowerShellSingleQuotedLiteral -Value $backendPath
$frontendPathLiteral = ConvertTo-PowerShellSingleQuotedLiteral -Value $frontendPath
$telegramBotTokenLiteral = ConvertTo-PowerShellSingleQuotedLiteral -Value $telegramBotToken
$telegramChatIdLiteral = ConvertTo-PowerShellSingleQuotedLiteral -Value $telegramChatId
$emailUserLiteral = ConvertTo-PowerShellSingleQuotedLiteral -Value $emailUser
$emailPasswordLiteral = ConvertTo-PowerShellSingleQuotedLiteral -Value $emailPassword
$startupStatusPathLiteral = ConvertTo-PowerShellSingleQuotedLiteral -Value $startupStatusPath

# ----------------------------------------------------------------
#  Run Claude Code Stock Analysis (Dynamic, Every 30 Minutes)
# ----------------------------------------------------------------
# NOTE: automate-claude-analysis-dynamic.js is DISABLED.
# It sent 244 stocks × 5 days OHLCV to Claude Opus every 30 minutes (~$18-21/day).
# This work is fully covered by ORACLE (per-stock Claude verdict inside the trading bot)
# and PROPHET (earnings forecasts) — both run within the worker process at no extra cost.
Write-Host "[0/4] Claude dynamic analysis: DISABLED (covered by ORACLE+PROPHET in worker)" -ForegroundColor DarkGray
Write-Host ""

# ----------------------------------------------------------------
#  Run Controlled Backfill of Stock Prices (Background)
# ----------------------------------------------------------------
Write-Host "[0/4] Starting controlled backfill of stock prices (all major US tickers)..." -ForegroundColor Cyan
$backfillScript = Join-Path $backendPath "backfill-stock-prices-controlled.js"
if (Test-Path $backfillScript) {
    Write-Host "      Executing: node backfill-stock-prices-controlled.js" -ForegroundColor Gray
    $backfillProcess = Start-Process node -ArgumentList $backfillScript -WorkingDirectory $backendPath -PassThru
    Write-Host "      Backfill process running (PID: $($backfillProcess.Id))." -ForegroundColor Green
} else {
    Write-Host "      Backfill script not found: $backfillScript" -ForegroundColor Red
}
Write-Host ""

# ----------------------------------------------------------------
#  DB Schema Init (idempotent - safe to run every startup)
# ----------------------------------------------------------------
Write-Host "[0.5/4] Running DB schema init (CREATE IF NOT EXISTS)..." -ForegroundColor Cyan
$initDbScript = Join-Path $backendPath "src\config\initDatabase.js"
if (Test-Path $initDbScript) {
    Push-Location $backendPath
    node src/config/initDatabase.js
    $initExitCode = $LASTEXITCODE
    Pop-Location
    if ($initExitCode -eq 0) {
        Write-Host "      DB schema ready." -ForegroundColor Green
    } else {
        Write-Host "      WARNING: DB init failed (exit $initExitCode) - check DB connection." -ForegroundColor Yellow
    }
} else {
    Write-Host "      initDatabase.js not found - skipping." -ForegroundColor DarkYellow
}
Write-Host ""

# ----------------------------------------------------------------
#  Start Backend
# ----------------------------------------------------------------
Write-Host "[1/4] Starting Backend API on port 3001..." -ForegroundColor Cyan
Write-Host "      API only | schedulers moved to worker process" -ForegroundColor Gray

$backendCommand = "Set-Location -Path $backendPathLiteral; " +
    "`$env:TELEGRAM_BOT_TOKEN = $telegramBotTokenLiteral; " +
    "`$env:TELEGRAM_CHAT_ID   = $telegramChatIdLiteral; " +
    "`$env:EMAIL_USER         = $emailUserLiteral; " +
    "`$env:EMAIL_PASSWORD     = $emailPasswordLiteral; " +
    "`$env:NODE_ENV           = 'development'; " +
    "Write-Host ''; " +
    "Write-Host '=== BACKEND API (port 3001) ===' -ForegroundColor Cyan; " +
    "Write-Host ''; " +
    "npm start"

$backendProcess = Start-Process powershell -ArgumentList "-NoExit", "-Command", $backendCommand -PassThru
Write-Host "      Backend terminal PID: $($backendProcess.Id)" -ForegroundColor DarkGray

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
#  Start Worker
# ----------------------------------------------------------------
Write-Host "[2/4] Starting Worker services..." -ForegroundColor Cyan
Write-Host "      Enhanced AI | Options | Telegram Reports | News Monitoring" -ForegroundColor Gray

$workerCommand = "Set-Location -Path $backendPathLiteral; " +
    "`$env:TELEGRAM_BOT_TOKEN = $telegramBotTokenLiteral; " +
    "`$env:TELEGRAM_CHAT_ID   = $telegramChatIdLiteral; " +
    "`$env:EMAIL_USER         = $emailUserLiteral; " +
    "`$env:EMAIL_PASSWORD     = $emailPasswordLiteral; " +
    "`$env:NODE_ENV           = 'development'; " +
    "Write-Host ''; " +
    "Write-Host '=== WORKER ===' -ForegroundColor Yellow; " +
    "Write-Host ''; " +
    "npm run start:worker"

$workerProcess = Start-Process powershell -ArgumentList "-NoExit", "-Command", $workerCommand -PassThru
Write-Host "      Worker terminal PID:  $($workerProcess.Id)" -ForegroundColor DarkGray
Write-Host ""

# ----------------------------------------------------------------
#  Startup Stock Signal Delivery
# ----------------------------------------------------------------
Write-Host "[3/4] Running startup stock-signal delivery..." -ForegroundColor Cyan
Write-Host "      One-time real Telegram delivery via npm run run:stock-signals" -ForegroundColor Gray

$signalDeliveryCommand = "Set-Location -Path $backendPathLiteral; " +
    "`$env:TELEGRAM_BOT_TOKEN = $telegramBotTokenLiteral; " +
    "`$env:TELEGRAM_CHAT_ID   = $telegramChatIdLiteral; " +
    "`$env:EMAIL_USER         = $emailUserLiteral; " +
    "`$env:EMAIL_PASSWORD     = $emailPasswordLiteral; " +
    "`$env:NODE_ENV           = 'development'; " +
    "Write-Host ''; " +
    "Write-Host '=== STARTUP STOCK SIGNAL DELIVERY ===' -ForegroundColor Green; " +
    "Write-Host ''; " +
    "npm run run:stock-signals"

$signalDeliveryProcess = Start-Process powershell -ArgumentList "-NoExit", "-Command", $signalDeliveryCommand -PassThru
Write-Host "      Delivery terminal PID: $($signalDeliveryProcess.Id)" -ForegroundColor DarkGray
Write-Host ""

# ----------------------------------------------------------------
#  Start Frontend
# ----------------------------------------------------------------
Write-Host "[4/4] Starting Frontend on port 3000..." -ForegroundColor Cyan
Write-Host "      Stable mode | build once, then serve with Next start" -ForegroundColor Gray

$frontendStatusFile = Join-Path $startupStatusPath "frontend-status.json"
if (Test-Path $frontendStatusFile) {
    Remove-Item $frontendStatusFile -Force -ErrorAction SilentlyContinue
}

$frontendStatusFileLiteral = ConvertTo-PowerShellSingleQuotedLiteral -Value $frontendStatusFile

$frontendCommand = "Set-Location -Path $frontendPathLiteral; " +
    "`$statusFile = $frontendStatusFileLiteral; " +
    "New-Item -ItemType Directory -Path $startupStatusPathLiteral -Force | Out-Null; " +
    "@{ status = 'starting'; timestamp = (Get-Date).ToString('o'); message = 'Preparing frontend build' } | ConvertTo-Json -Compress | Set-Content -Path `$statusFile -Encoding UTF8; " +
    "`$env:NODE_ENV           = 'production'; " +
    "Write-Host ''; " +
    "Write-Host '=== FRONTEND BUILD ===' -ForegroundColor Magenta; " +
    "Write-Host ''; " +
    "if (Test-Path '.next') { Remove-Item '.next' -Recurse -Force -ErrorAction SilentlyContinue }; " +
    "npm run build; " +
    "if (`$LASTEXITCODE -ne 0) { @{ status = 'build_failed'; timestamp = (Get-Date).ToString('o'); message = 'Frontend build failed'; exitCode = `$LASTEXITCODE } | ConvertTo-Json -Compress | Set-Content -Path `$statusFile -Encoding UTF8; exit `$LASTEXITCODE }; " +
    "@{ status = 'build_succeeded'; timestamp = (Get-Date).ToString('o'); message = 'Frontend build succeeded, starting server' } | ConvertTo-Json -Compress | Set-Content -Path `$statusFile -Encoding UTF8; " +
    "Write-Host ''; " +
    "Write-Host '=== FRONTEND (port 3000) ===' -ForegroundColor Magenta; " +
    "Write-Host ''; " +
    "npm run start"

$frontendProcess = Start-Process powershell -ArgumentList "-NoExit", "-Command", $frontendCommand -PassThru
Write-Host "      Frontend terminal PID: $($frontendProcess.Id)" -ForegroundColor DarkGray

$frontendReady = $false
$frontendFailure = $null
$frontendBuildSucceeded = $false
$frontendDeadline = (Get-Date).AddSeconds(180)

while ((Get-Date) -lt $frontendDeadline) {
    $status = Read-StatusFile -Path $frontendStatusFile

    if ($status) {
        if ($status.status -eq 'build_failed') {
            $frontendFailure = $status
            break
        }

        if ($status.status -eq 'build_succeeded') {
            $frontendBuildSucceeded = $true
        }
    }

    try {
        $null = Invoke-WebRequest -Uri "http://localhost:3000" -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop
        $frontendReady = $true
        break
    } catch {
        $statusCode = $null

        try {
            if ($_.Exception.Response -and $null -ne $_.Exception.Response.StatusCode) {
                $statusCode = [int]$_.Exception.Response.StatusCode
            }
        } catch {
            $statusCode = $null
        }

        if ($null -ne $statusCode -and $statusCode -ge 200 -and $statusCode -lt 400) {
            $frontendReady = $true
            break
        }

        Start-Sleep -Seconds 2
    }
}

if ($frontendReady) {
    Write-Host "      Frontend is ready!" -ForegroundColor Green
} elseif ($frontendFailure) {
    $frontendFailureMessage = if ($frontendFailure.message) { $frontendFailure.message } else { 'Frontend child process reported a build failure.' }
    $frontendFailureExitCode = if ($null -ne $frontendFailure.exitCode) { [int]$frontendFailure.exitCode } else { 1 }
    Write-Host "      Frontend failed before startup: $frontendFailureMessage" -ForegroundColor Red
    Write-Error "Frontend startup failed in child process. See frontend terminal for build details."
    exit $frontendFailureExitCode
} elseif ($frontendBuildSucceeded) {
    Write-Host "      Frontend build finished, but port 3000 did not become ready within 180 seconds." -ForegroundColor Yellow
    Write-Error "Frontend server did not become ready after a successful build. Check the frontend terminal output."
    exit 1
} else {
    Write-Host "      Frontend did not report build completion within 180 seconds." -ForegroundColor Yellow
    Write-Error "Frontend child process did not report status. Check the frontend terminal output."
    exit 1
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
Write-Host "   Domain:   https://getmytbot.com" -ForegroundColor Green
Write-Host "   Backend:  http://localhost:3001" -ForegroundColor White
Write-Host "   Worker:   background schedulers running in separate terminal" -ForegroundColor White
Write-Host "   Signals:  one startup real-delivery pass in separate terminal" -ForegroundColor White
Write-Host "   Health:   http://localhost:3001/health" -ForegroundColor White
$cfPid = (Get-Process -Name "cloudflared" -ErrorAction SilentlyContinue | Select-Object -First 1).Id
Write-Host "   PIDs:     backend=$($backendProcess.Id) | worker=$($workerProcess.Id) | delivery=$($signalDeliveryProcess.Id) | frontend=$($frontendProcess.Id) | tunnel=$cfPid" -ForegroundColor White
Write-Host "-----------------------------------------------" -ForegroundColor Green
Write-Host "   Telegram: @KiranTradePro_bot" -ForegroundColor White
Write-Host "   Reports:  Mon-Fri 7:00 AM (predictions) + 4:15 PM (AI bot summary) | Sun 8 AM (weekly buy list) + 9 AM (weekly recap)" -ForegroundColor White
Write-Host "-----------------------------------------------" -ForegroundColor Green
Write-Host "   To stop:  rerun this script or stop the KiranRock backend/frontend/worker/delivery terminals" -ForegroundColor Gray
Write-Host "===============================================" -ForegroundColor Green
Write-Host ""

if (-not $NoPrompt -and -not $NonInteractive -and $env:SKIP_BROWSER_PROMPT -ne 'true') {
    $open = Read-Host "Open browser now? (Y/N)"
    if ($open -eq 'Y' -or $open -eq 'y') {
        Start-Process "http://localhost:3000"
    }
}

Write-Host ""
Write-Host "Happy Trading!" -ForegroundColor Magenta
Write-Host ""
