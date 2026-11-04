# Installs the voice server for the current Windows user and starts it at every logon.
# Rerun after an update; config, device tokens and queued jobs are kept.
param(
  [Parameter(Mandatory)] [string] $WhisperDirectory,
  [Parameter(Mandatory)] [string] $Model,
  [Parameter(Mandatory)] [string] $Ffmpeg,
  [string] $T3Command = "t3",
  [int] $Port = 4791,
  [string] $TunnelName = "t3-voice",
  [string] $PublicUrl = "https://t3-voice.dev.gweiermann.de",
  [string] $Prompt = ""
)
$ErrorActionPreference = "Stop"

$taskName = "T3VoiceServer"
$home_ = Join-Path $env:USERPROFILE ".t3-voice"
$app = Join-Path $home_ "app"
$configPath = Join-Path $home_ "config.json"
New-Item -ItemType Directory -Force $app | Out-Null

if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $taskName
  # Stopping the task ends only its console host, so the service itself goes by its port.
  if (Test-Path $configPath) {
    $installedPort = (Get-Content -Raw $configPath | ConvertFrom-Json).port
    Get-NetTCPConnection -LocalPort $installedPort -State Listen -ErrorAction SilentlyContinue |
      ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
  }
}
Copy-Item -Recurse -Force (Join-Path $PSScriptRoot "..\src") $app
Copy-Item -Force (Join-Path $PSScriptRoot "..\package.json") $app

if (-not (Test-Path $configPath)) {
  $config = [ordered]@{
    port        = $Port
    tokenHashes = @()
    publicUrl   = $PublicUrl
    tunnelName  = $TunnelName
    whisperCli  = Join-Path $WhisperDirectory "whisper-cli.exe"
    whisperCwd  = $WhisperDirectory
    whisperArgs = @("-mc", "0", "-bs", "5")
    model       = $Model
    ffmpeg      = $Ffmpeg
    t3Command   = $T3Command
    prompt      = $Prompt
  }
  # .NET writes without the BOM that Set-Content adds, which JSON.parse rejects.
  [IO.File]::WriteAllText($configPath, ($config | ConvertTo-Json))
}

$node = (Get-Command node).Source
$log = Join-Path $home_ "service.log"
$launcher = Join-Path $home_ "run.cmd"
# A launcher file, because conhost mangles a quoted command line.
[IO.File]::WriteAllText($launcher, "@`"$node`" `"$app\src\main.ts`" >> `"$log`" 2>&1`r`n")
$action = New-ScheduledTaskAction -Execute "conhost.exe" -Argument "--headless `"$launcher`"" -WorkingDirectory $app
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $taskName
Write-Output "Running. Pair a phone with: node `"$app\src\main.ts`" pair"
