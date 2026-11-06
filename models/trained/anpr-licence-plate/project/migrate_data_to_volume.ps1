<#
.SYNOPSIS
  Move the ANPR churn folders (data/) off the Windows bind mount into the named
  volume drisyam_trinetra-anpr-data. Idempotent: every stage can be re-run.

.DESCRIPTION
  Why: on a Windows bind mount one small-file write costs ~26 ms and walking
  data/review (34k files) took 377 s; inside a volume the same is 74 ms / 13 ms
  per 300 files. Code + models stay on the bind mount; only data/ moves.

  Stages (run from anywhere; paths are derived from this file's location):
    (default)      1. docker volume create <Volume>
                   2. full copy host data/ -> volume with a throwaway alpine
                      (cp -pR; ~40k small files over the bind mount = ~20 min)
                   3. per-folder file counts host vs volume
    -DeltaOnly     copy only files that are newer/missing in the volume (cp -a -u)
                   --cheap; run it right before -Switch to shrink the gap
    -Switch        py_compile worker.py (never recreate onto a broken edit), then
                   docker compose up -d --no-deps anpr-worker anpr-trainer trinetra-ai
                   (the compose file already mounts the volume), a post-switch
                   delta pass (the worker no longer writes to the host, so this
                   closes the gap for good), docker inspect of the mounts, counts
    -Finalize      ONLY after -Switch verified: rename host data/ ->
                   data_host_backup_<date>/ and create empty data/ + export/
    -CountsOnly    just the comparison table

  NEVER does: docker compose down, delete anything on the host, touch the
  `name:` pins in docker-compose.yml. If counts do not match, STOP and look;
  do not -Finalize.

.EXAMPLE
  .\migrate_data_to_volume.ps1                 # create + copy + counts (background it: 10-25 min)
  .\migrate_data_to_volume.ps1 -DeltaOnly      # catch up
  .\migrate_data_to_volume.ps1 -Switch         # recreate the three services onto the volume
  .\migrate_data_to_volume.ps1 -Finalize       # rename the host copy
#>
[CmdletBinding()]
param(
  [switch]$CountsOnly,
  [switch]$DeltaOnly,
  [switch]$Switch,
  [switch]$Finalize,
  [string]$Volume = "drisyam_trinetra-anpr-data",
  [string]$BackupDate = (Get-Date -Format "yyyy-MM-dd")
)

$ErrorActionPreference = "Stop"
$Here     = Split-Path -Parent $MyInvocation.MyCommand.Path
$HostData = Join-Path $Here "data"
$Backup   = Join-Path $Here ("data_host_backup_" + $BackupDate)
$Export   = Join-Path $Here "export"
$Repo     = (Resolve-Path (Join-Path $Here "..\..\..")).Path
# Folders the worker / trainer / reports write into, plus whatever else is on the host.
$Known    = @("records", "review", "confirmed", "outbox", "train", "reports", "tmp",
              "crops", "frames", "labelled", "eval", "contact", "dryrun")

function Write-Step([string]$msg) { Write-Host ("[{0}] {1}" -f (Get-Date -Format "HH:mm:ss"), $msg) }

function Get-Folders([string]$root) {
  $names = @($Known)
  if (Test-Path $root) {
    foreach ($d in (Get-ChildItem $root -Directory -Force)) { if ($names -notcontains $d.Name) { $names += $d.Name } }
  }
  return $names
}

function Get-HostCounts([string]$root, [string[]]$folders) {
  $out = @{}
  foreach ($f in $folders) {
    $p = Join-Path $root $f
    if (Test-Path $p) { $out[$f] = (Get-ChildItem $p -Recurse -File -Force | Measure-Object).Count } else { $out[$f] = 0 }
  }
  return $out
}

function Get-VolumeCounts([string[]]$folders) {
  # Single quotes: PowerShell must NOT expand $d / $(...) --the shell inside alpine does.
  $list = ($folders -join " ")
  $sh = 'for d in ' + $list + '; do if [ -d /to/$d ]; then echo $d $(find /to/$d -type f | wc -l); else echo $d 0; fi; done'
  $raw = docker run --rm -v "${Volume}:/to:ro" alpine sh -c $sh
  if ($LASTEXITCODE -ne 0) { throw "docker run (count) failed with exit $LASTEXITCODE" }
  $out = @{}
  foreach ($line in $raw) {
    $parts = ($line -split "\s+") | Where-Object { $_ -ne "" }
    if ($parts.Count -ge 2) { $out[$parts[0]] = [int]$parts[1] }
  }
  return $out
}

function Compare-Counts([string]$hostRoot) {
  $folders = Get-Folders $hostRoot
  Write-Step "counting host ($hostRoot) ..."
  $h = Get-HostCounts $hostRoot $folders
  Write-Step "counting volume ($Volume) ..."
  $v = Get-VolumeCounts $folders
  $ok = $true
  $rows = @()
  foreach ($f in $folders) {
    $hc = $h[$f]; $vc = 0; if ($v.ContainsKey($f)) { $vc = $v[$f] }
    $status = "ok"
    if ($vc -lt $hc) { $status = "MISSING " + ($hc - $vc); $ok = $false }
    elseif ($vc -gt $hc) { $status = "+" + ($vc - $hc) + " newer in volume" }
    $rows += [pscustomobject]@{ folder = $f; host = $hc; volume = $vc; status = $status }
  }
  $rows | Format-Table -AutoSize | Out-String | Write-Host
  $ht = ($h.Values | Measure-Object -Sum).Sum; $vt = ($v.Values | Measure-Object -Sum).Sum
  Write-Step ("total host {0}  volume {1}  -> {2}" -f $ht, $vt, $(if ($ok) { "volume has every host file" } else { "VOLUME IS SHORT --do not switch/finalize" }))
  return $ok
}

function Invoke-Copy([switch]$Update) {
  if (-not (Test-Path $HostData)) { throw "host data folder not found: $HostData" }
  # -pR, NOT -a: busybox `cp -a` also preserves hard links by inode, and the
  # Windows bind mount recycles inode numbers for files created while the copy
  # runs -> "cp: can't create link ... No such file or directory" (44 review
  # files on the 2026-08-28 run). -u = only files missing or newer in the volume.
  $flags = "-pR"; if ($Update) { $flags = "-pR -u" }
  $sw = [Diagnostics.Stopwatch]::StartNew()
  Write-Step ("cp {0} host data/ -> {1} (alpine, sequential; the bind mount is the slow side) ..." -f $flags, $Volume)
  docker run --rm -v "${HostData}:/from:ro" -v "${Volume}:/to" alpine sh -c "cp $flags /from/. /to/"
  if ($LASTEXITCODE -ne 0) { throw "copy failed with exit $LASTEXITCODE" }
  Write-Step ("copy done in {0:N0} s" -f $sw.Elapsed.TotalSeconds)
}

function Ensure-Volume {
  $existing = docker volume ls --format "{{.Name}}" | Where-Object { $_ -eq $Volume }
  if ($existing) { Write-Step "volume $Volume exists" }
  else { docker volume create $Volume | Out-Null; Write-Step "created volume $Volume" }
}

# -----------------------------------------------------------------------------
Write-Step "repo $Repo"
Write-Step "host data $HostData"

if ($CountsOnly) {
  $root = $HostData; if (-not (Test-Path (Join-Path $HostData "records")) -and (Test-Path $Backup)) { $root = $Backup }
  $ok = Compare-Counts $root
  if (-not $ok) { exit 1 } else { exit 0 }
}

if ($Finalize) {
  if (Test-Path $Backup) { Write-Step "backup already exists: $Backup"; }
  else {
    $mounts = docker inspect trinetra-anpr-worker --format '{{range .Mounts}}{{.Type}} {{.Name}} -> {{.Destination}}{{println}}{{end}}'
    if (-not ($mounts | Where-Object { $_ -match "volume\s+$Volume\s+->\s+/srv/anpr/data" })) {
      throw "anpr-worker does not have $Volume at /srv/anpr/data yet --run -Switch first"
    }
    $ok = Compare-Counts $HostData
    if (-not $ok) { throw "volume is short of host files --NOT renaming" }
    Rename-Item -Path $HostData -NewName (Split-Path -Leaf $Backup)
    Write-Step "renamed data/ -> $(Split-Path -Leaf $Backup)"
  }
  if (-not (Test-Path $HostData)) { New-Item -ItemType Directory -Path $HostData | Out-Null; Write-Step "created empty data/ (so nothing else breaks)" }
  if (-not (Test-Path $Export))   { New-Item -ItemType Directory -Path $Export   | Out-Null; Write-Step "created export/" }
  Write-Step "finalized. Host backup: $Backup"
  exit 0
}

Ensure-Volume

if ($Switch) {
  Write-Step "py_compile worker.py / auto_retrain.py / export_records.py in the running worker (bind mount = current host files)"
  docker exec -w /srv/anpr trinetra-anpr-worker python -m py_compile worker.py auto_retrain.py export_records.py retention.py
  if ($LASTEXITCODE -ne 0) { throw "worker source does not compile --another agent is mid-edit; retry -Switch later" }
  Invoke-Copy -Update
  Write-Step "docker compose up -d --no-deps anpr-worker anpr-trainer trinetra-ai"
  Push-Location $Repo
  try {
    docker compose up -d --no-deps anpr-worker anpr-trainer trinetra-ai
    if ($LASTEXITCODE -ne 0) { throw "compose up failed with exit $LASTEXITCODE" }
  } finally { Pop-Location }
  Write-Step "post-switch delta (host is frozen now; the worker writes into the volume)"
  Invoke-Copy -Update
  foreach ($c in @("trinetra-anpr-worker", "trinetra-anpr-trainer", "trinetra-ai")) {
    Write-Host "--- $c mounts ---"
    docker inspect $c --format '{{range .Mounts}}{{.Type}} {{if .Name}}{{.Name}}{{else}}{{.Source}}{{end}} -> {{.Destination}}{{println}}{{end}}'
  }
  $ok = Compare-Counts $HostData
  if (-not $ok) { Write-Step "counts short --investigate before -Finalize"; exit 1 }
  Write-Step "switched. Verify new records land in the volume, then run -Finalize."
  exit 0
}

if ($DeltaOnly) { Invoke-Copy -Update } else { Invoke-Copy }
$ok = Compare-Counts $HostData
if (-not $ok) { exit 1 } else { exit 0 }
