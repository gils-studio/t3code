# Replaces the installed T3 Code desktop app on this PC with a fork build, once no agent is working.
# Run it detached (see README): it stops the app every Claude session runs in.
param(
  [Parameter(Mandatory = $true)] [string] $Installer,
  [string] $NotifyThread = "",
  [int] $QuietChecks = 4,
  [int] $CheckSeconds = 30,
  [int] $MaxWaitHours = 8
)
$ErrorActionPreference = "Stop"

$AppDir = Join-Path $env:LOCALAPPDATA "Programs\t3code"
$Exe = Join-Path $AppDir "T3 Code (Beta).exe"
$UserData = Join-Path $env:USERPROFILE ".t3\userdata"
$Db = Join-Path $UserData "statev2.sqlite"
$RuntimeFile = Join-Path $UserData "server-runtime.json"
$Work = Join-Path $env:USERPROFILE ".t3\fork-switch"
$Stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$Backup = Join-Path $Work "backup-$Stamp"
$Log = Join-Path $Work "switch.log"
New-Item -ItemType Directory -Force $Work | Out-Null

function Log([string] $Text) {
  $line = "$(Get-Date -Format s) $Text"
  Add-Content -Path $Log -Value $line -Encoding utf8
}

function Get-AppProcesses {
  @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $Exe })
}

# Read-only query of the live database: runs still working.
$QueryScript = Join-Path $Work "running-runs.mjs"
@'
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(process.argv[2], { readOnly: true });
const row = db.prepare("select count(*) as n from orchestration_v2_projection_runs where status in ('running','starting','queued','preparing','waiting')").get();
console.log(row.n);
'@ | Set-Content -Path $QueryScript -Encoding utf8

function Get-BusyRuns {
  $out = & node --no-warnings $QueryScript $Db 2>$null
  if ($LASTEXITCODE -ne 0) { return 999 }
  return [int]($out | Select-Object -Last 1)
}

function Test-VoiceLive {
  $live = Join-Path $env:USERPROFILE ".t3-voice\live"
  (Test-Path $live) -and @(Get-ChildItem $live -Force -ErrorAction SilentlyContinue).Count -gt 0
}

function Read-Runtime {
  try { Get-Content $RuntimeFile -Raw | ConvertFrom-Json } catch { $null }
}

# The app exe is a GUI binary: `&` neither waits for it nor sets $LASTEXITCODE, so use Start-Process.
function Send-Wake([string] $Message) {
  if (-not $NotifyThread) { return }
  $serverEntry = Join-Path $AppDir "resources\server.asar\apps\server\dist\bin.mjs"
  $outFile = Join-Path $Work "thread-send.out"
  $errFile = Join-Path $Work "thread-send.err"
  for ($i = 0; $i -lt 5; $i++) {
    $env:ELECTRON_RUN_AS_NODE = "1"
    $p = Start-Process -FilePath $Exe -ArgumentList @("`"$serverEntry`"", "thread", "send", $NotifyThread, "`"$Message`"") `
      -NoNewWindow -Wait -PassThru -RedirectStandardOutput $outFile -RedirectStandardError $errFile
    Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
    Log "thread send exit=$($p.ExitCode) $(Get-Content $outFile -Raw) $(Get-Content $errFile -Raw)"
    if ($p.ExitCode -eq 0) { return }
    Start-Sleep -Seconds 15
  }
}

function Start-App {
  Start-Process -FilePath $Exe -WorkingDirectory $AppDir
}

# A server started after $Since that answers HTTP. Migrations on a large database can take minutes.
function Wait-Server([datetime] $Since) {
  $deadline = (Get-Date).AddMinutes(15)
  while ((Get-Date) -lt $deadline) {
    $rt = Read-Runtime
    if ($rt -and ([datetime]$rt.startedAt).ToUniversalTime() -gt $Since.ToUniversalTime()) {
      try {
        Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 -Uri "$($rt.origin)/" | Out-Null
        return $rt
      } catch {}
    }
    Start-Sleep -Seconds 5
  }
  return $null
}

function Stop-App {
  $procs = Get-AppProcesses
  Log "stopping $($procs.Count) app processes"
  foreach ($p in $procs) {
    $proc = Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue
    if ($proc -and $proc.MainWindowHandle -ne 0) { [void]$proc.CloseMainWindow() }
  }
  $deadline = (Get-Date).AddSeconds(30)
  while ((Get-Date) -lt $deadline -and (Get-AppProcesses).Count -gt 0) { Start-Sleep -Seconds 2 }
  foreach ($p in Get-AppProcesses) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 3
  if ((Get-AppProcesses).Count -gt 0) { throw "app processes still running" }
}

Log "start installer=$Installer notify=$NotifyThread"
if (-not (Test-Path $Installer)) { Log "installer missing"; exit 1 }

# 1. Wait until no agent run is active and nobody is recording a voice message.
$quiet = 0
$giveUp = (Get-Date).AddHours($MaxWaitHours)
while ($quiet -lt $QuietChecks) {
  if ((Get-Date) -gt $giveUp) { Log "gave up: never quiet for long enough"; exit 2 }
  $busy = Get-BusyRuns
  if ($busy -eq 0 -and -not (Test-VoiceLive)) { $quiet++ } else { $quiet = 0 }
  Start-Sleep -Seconds $CheckSeconds
}
$old = Read-Runtime
Log "quiet; old server pid=$($old.pid) version=$($old.serverVersion)"

# 2. Stop the app, back up the install and the database files.
Stop-App
New-Item -ItemType Directory -Force $Backup | Out-Null
robocopy $AppDir (Join-Path $Backup "app") /E /NFL /NDL /NJH /NJS /NP | Out-Null
foreach ($f in @("statev2.sqlite", "statev2.sqlite-wal", "statev2.sqlite-shm", "settings.json", "desktop-settings.json")) {
  $src = Join-Path $UserData $f
  if (Test-Path $src) { Copy-Item $src (Join-Path $Backup $f) }
}
Log "backup at $Backup"

# 3. Install the fork build over the same per-user install (same appId).
try {
  $p = Start-Process -FilePath $Installer -ArgumentList "/S" -Wait -PassThru
  Log "installer exit=$($p.ExitCode)"
  if ($p.ExitCode -ne 0) { throw "installer failed" }
  # Fork builds carry no update feed; never let an upstream feed replace them.
  Remove-Item (Join-Path $AppDir "resources\app-update.yml") -ErrorAction SilentlyContinue

  # 4. Autostart at logon.
  Set-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" -Name "T3 Code" -Value "`"$Exe`""
  Log "autostart set"

  # 5. Start it and wait for the new server.
  $startedAt = Get-Date
  Start-App
  $rt = Wait-Server -Since $startedAt
  if (-not $rt) { throw "new server never came up" }
  Log "new server pid=$($rt.pid) version=$($rt.serverVersion) origin=$($rt.origin)"
  Set-Content -Path (Join-Path $Work "done") -Value "$Stamp $($rt.serverVersion)" -Encoding utf8
  Send-Wake "[Fork-Umstieg] Die Fork-Desktop-App laeuft (Server $($rt.serverVersion), PID $($rt.pid)). Log: $Log. Bitte verifizieren und Nils berichten."
  Log "done"
} catch {
  Log "FAILED: $($_.Exception.Message); rolling back"
  try { Stop-App } catch { Log "rollback stop: $($_.Exception.Message)" }
  robocopy (Join-Path $Backup "app") $AppDir /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
  # The fork may have migrated the database forward; the old app needs the old file.
  foreach ($f in @("statev2.sqlite", "statev2.sqlite-wal", "statev2.sqlite-shm")) {
    $saved = Join-Path $Backup $f
    if (Test-Path $saved) { Copy-Item $saved (Join-Path $UserData $f) -Force }
  }
  $startedAt = Get-Date
  Start-App
  $rt = Wait-Server -Since $startedAt
  Log "rollback server pid=$($rt.pid) version=$($rt.serverVersion)"
  Send-Wake "[Fork-Umstieg] FEHLGESCHLAGEN, alte Version wiederhergestellt ($($rt.serverVersion)). Log: $Log"
  exit 3
}
