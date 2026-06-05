# Start Backend with Telegram Configuration
# This script starts the backend server with proper Telegram environment variables

Write-Host "Starting KiranRock Trading Platform Backend..." -ForegroundColor Cyan
Write-Host ""

$backendEnvPath = Join-Path $PSScriptRoot ".env"

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

# Set Telegram Bot Token
$env:TELEGRAM_BOT_TOKEN = Resolve-SecretValue -Name "TELEGRAM_BOT_TOKEN"
Write-Host "✓ Telegram Bot Token configured (@KiranTradePro_bot)" -ForegroundColor Green

# Set Telegram Chat ID (default to personal chat, can be overridden)
$env:TELEGRAM_CHAT_ID = Resolve-SecretValue -Name "TELEGRAM_CHAT_ID"

if ([string]::IsNullOrWhiteSpace($env:TELEGRAM_BOT_TOKEN) -or [string]::IsNullOrWhiteSpace($env:TELEGRAM_CHAT_ID)) {
	Write-Error "Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID. Set them in the current environment or $backendEnvPath"
	exit 1
}

Write-Host "✓ Telegram Chat ID configured from environment" -ForegroundColor Green

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
