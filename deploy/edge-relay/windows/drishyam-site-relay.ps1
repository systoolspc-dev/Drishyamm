# ============================================================================
#  Drishyam SITE RELAY  -  one script, any site, any NVR brand.
#
#  Runs on an always-on Windows PC on the SAME network as the NVR. It pulls each
#  camera from the NVR and pushes it OUT to the Drishyam cloud over TLS
#  (rtsps://103.109.7.36:8555). Outbound only: no static IP, no port forwarding,
#  works behind any router / CGNAT. Cameras then work in Drishyam from anywhere.
#
#  FIRST TIME (once, in an ADMINISTRATOR PowerShell, in this folder):
#      powershell -ExecutionPolicy Bypass -File .\drishyam-site-relay.ps1 -Install
#    -> asks for a site name and the NVR password (typed hidden, stored encrypted),
#       finds the NVR brand + working channels, installs a self-repairing Windows
#       task (runs at boot, re-checks every 3 min), starts streaming, and prints
#       the exact camera list to add in Drishyam.
#
#  OTHER COMMANDS (admin PowerShell):
#      -Test        check the NVR and list working channels, change nothing
#      -Status      show which streams are running + last log lines
#      -Log         last 15 lines of every stream's log (password hidden) - send this to Drishyam
#      -Uninstall   stop everything and remove the task
#      -Reset       forget saved settings (site name, password, channels) and re-run -Install
#      -TestBackfill  show which minutes the cloud is missing and what the NVR has for them, change nothing
#
#  After a restart, shutdown or power cut the relay starts again by itself (no login needed) as soon
#  as Windows is up. Install turns off sleep, lid-close sleep and Fast Startup. For power cuts, set
#  the PC's BIOS "Restore on AC Power Loss" (or "AC Recovery") to Power On so the PC switches itself on.
#
#  MISSED FOOTAGE: while this PC or its internet is down nothing reaches the cloud, but the NVR keeps
#  recording to its own disk. Once the relay is back, a background worker asks the cloud which minutes
#  are missing, copies exactly those minutes from the NVR's recordings (one camera at a time, only while
#  live video is healthy) and uploads them over HTTPS with their original time, so they appear in
#  Drishyam playback where they belong. Hikvision / Prama NVRs. Footage the NVR itself did not record
#  (for example the NVR also lost power) cannot be recovered.
#  Needs: Windows 10/11 or Server 2016+, internet upload ~2-4 Mbps per camera
#  (main stream) or ~0.5 Mbps (sub stream), ffmpeg (installed automatically).
# ============================================================================
param([switch]$Install, [switch]$Uninstall, [switch]$Test, [switch]$Status, [switch]$Log, [switch]$Reset, [switch]$Force,
      [switch]$TestBackfill, [switch]$BackfillWorker)

# ============================ SITE CONFIG ===================================
$NvrIp       = '192.168.1.50'      # NVR / DVR IP on the local network
$NvrUser     = 'admin'             # NVR login (password is asked once, never stored in this file)
$RtspPort    = 554                 # NVR RTSP port (almost always 554)
$Brand       = 'auto'              # auto | hikvision | dahua | cpplus | uniview
$MaxChannels = 16                  # probe channels 1..N (set to the NVR's channel count)
$OnlyChannels = @()                # e.g. @(4) or @(1,3,4): send ONLY these channels (empty = every working one)
$SubStream   = $false              # $true = smaller sub stream: far less load on the NVR and the upload
$Transcode   = $false              # $true = convert to H.264 on this PC (for H.265 cameras). Uses the graphics
                                   #   chip (NVIDIA/Intel/AMD) if there is one, else the processor.
$TranscodeHeight = 720             # picture height when converting (720 = HD). Sub streams keep their size.
$TranscodeFps    = 15              # frames per second when converting
$KeyFrameKick = $true              # Hikvision/Prama: ask the NVR for a key frame when a stream starts, so
                                   #   H.265+ cameras send their codec setup at once (tested at install)
$Backfill        = $true           # after an outage, upload the footage the cloud missed from the NVR's own
                                   #   recordings (Hikvision / Prama NVRs)
$BackfillHours   = 24              # how far back to look for missed footage
$BackfillMaxMbps = 4               # upload speed cap for missed footage, so live video always comes first
$Cloud       = '103.109.7.36:8555' # Drishyam cloud relay endpoint (leave as is)
$Api         = 'https://demo.indyatools.com'   # Drishyam web address for missed-footage uploads (leave as is)
# ===========================================================================

$ErrorActionPreference = 'Stop'
$RelayVersion = '2026.10.26'
$TaskName = 'DrishyamSiteRelay'
$Root     = Join-Path $env:ProgramData 'DrishyamRelay'
$State    = Join-Path $Root 'relay.json'
$Logs     = Join-Path $Root 'logs'
$BfDir    = Join-Path $Root 'backfill'
$BfQueue  = Join-Path $BfDir 'queue'          # pulled from the NVR, not yet confirmed by the cloud
$BfSkip   = Join-Path $BfDir 'skip.txt'       # minutes the NVR has no footage for (not asked again)
$BfLog    = Join-Path $Logs 'backfill.log'
$BfChunkSec      = 60                         # one file per minute: small uploads, resumable, under proxy limits
$BfLiveStableSec = 120                        # a camera's live push must be up this long before its catch-up runs
$Inv      = [Globalization.CultureInfo]::InvariantCulture

function Say($m, $c = 'Gray') { Write-Host $m -ForegroundColor $c }
function Is-Admin { ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) }

# ---------- encrypted storage (DPAPI, machine scope; folder locked to Admins + SYSTEM) ----------
Add-Type -AssemblyName System.Security
function Protect($s)   { [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($s), $null, 'LocalMachine')) }
function Unprotect($b) { [Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($b), $null, 'LocalMachine')) }
function Load-State    { if (Test-Path $State) { Get-Content $State -Raw | ConvertFrom-Json } else { $null } }
function Save-State($o) {
  New-Item -ItemType Directory -Force -Path $Root, $Logs | Out-Null
  & icacls $Root /inheritance:r /grant:r '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-18:(OI)(CI)F' | Out-Null   # Administrators + SYSTEM only
  $o | ConvertTo-Json -Depth 4 | Set-Content -Path $State -Encoding UTF8
}

# ---------- ffmpeg ----------
function Find-FFmpeg($st) {
  if ($st -and $st.ffmpeg -and (Test-Path $st.ffmpeg)) { return $st.ffmpeg }
  $look = {
    $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')
    $c = (Get-Command ffmpeg -ErrorAction SilentlyContinue).Source
    if ($c) { return $c }
    # common places: a manual unzip, our own folder, winget links and winget package folders
    $cands = @('C:\ffmpeg\bin\ffmpeg.exe', "$Root\ffmpeg\bin\ffmpeg.exe", "$env:ProgramFiles\WinGet\Links\ffmpeg.exe", "$env:LOCALAPPDATA\Microsoft\WinGet\Links\ffmpeg.exe")
    foreach ($x in $cands) { if (Test-Path $x) { return $x } }
    foreach ($dir in @("$env:ProgramFiles\WinGet\Packages", "$env:LOCALAPPDATA\Microsoft\WinGet\Packages", 'C:\ffmpeg')) {
      if (Test-Path $dir) { $hit = Get-ChildItem $dir -Recurse -Filter ffmpeg.exe -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName; if ($hit) { return $hit } }
    }
    return $null
  }
  $f = & $look
  if (-not $f) {
    # the Essentials build (~90 MB) is all the relay needs; the full build is ~200 MB
    Say 'Installing ffmpeg Essentials (one time, about 90 MB - this can take a few minutes, please wait)...' Yellow
    winget install --id Gyan.FFmpeg.Essentials -e --scope machine --accept-package-agreements --accept-source-agreements
    $f = & $look
  }
  if (-not $f) { throw 'ffmpeg not found. Download "ffmpeg-release-essentials.zip" from gyan.dev, unzip it so that C:\ffmpeg\bin\ffmpeg.exe exists, then run this again.' }
  Say "      ffmpeg: $f" DarkGray
  return $f
}

# ---------- RTSP paths per brand ----------
function Src-Url($brand, $ch, $sub, $user, $pass) {
  $u = [uri]::EscapeDataString($user); $p = [uri]::EscapeDataString($pass)
  $s = if ($sub) { 1 } else { 0 }
  switch ($brand) {
    'hikvision' { $path = '/Streaming/Channels/{0}{1}' -f $ch, $(if ($sub) { '02' } else { '01' }) }
    'uniview'   { $path = "/unicast/c$ch/s$s/live" }
    default     { $path = "/cam/realmonitor?channel=$ch&subtype=$s" }      # dahua, cpplus, imou
  }
  return "rtsp://${u}:${p}@${NvrIp}:${RtspPort}$path"
}

# Probe a list of channels, at most 4 at a time (weak NVRs jam when hit with many pulls at once).
function Probe($ff, $brand, $channels, $pass) {
  $res = @{}
  for ($i = 0; $i -lt $channels.Count; $i += 4) {
    $batch = $channels[$i..([Math]::Min($i + 3, $channels.Count - 1))]
    $jobs = foreach ($ch in $batch) {
      $tmp = [IO.Path]::GetTempFileName()
      $url = Src-Url $brand $ch $SubStream $NvrUser $pass
      # short socket timeout + small probe: a live channel answers in ~2 s, an empty one gives up in ~5 s
      $pr = Start-Process $ff -ArgumentList "-nostdin -rtsp_transport tcp -timeout 5000000 -analyzeduration 1000000 -probesize 500000 -i `"$url`" -frames:v 1 -f null -" -WindowStyle Hidden -PassThru -RedirectStandardError $tmp
      @{ ch = $ch; pr = $pr; tmp = $tmp }
    }
    foreach ($j in $jobs) {
      if (-not $j.pr.WaitForExit(8000)) { try { $j.pr.Kill() } catch {} }
      $err = Get-Content $j.tmp -Raw -ErrorAction SilentlyContinue; Remove-Item $j.tmp -ErrorAction SilentlyContinue
      if ($err -match 'Video:\s*([a-z0-9]+)') { $res[$j.ch] = 'ok:' + $Matches[1] }
      elseif ($err -match '401|Unauthorized') { $res[$j.ch] = 'auth' }
      else { $res[$j.ch] = 'no' }
    }
    if ($res.Values -contains 'auth') { break }     # stop at once on a wrong password: NVRs lock accounts after a few failures
  }
  return $res
}

function Detect($ff, $pass) {
  Say "`n[1/3] Checking the NVR at $NvrIp ..." Cyan
  if (-not (Test-Connection $NvrIp -Count 2 -Quiet)) { throw "NVR $NvrIp does not answer. Is this PC on the same network as the NVR?" }
  $tcp = Test-NetConnection $NvrIp -Port $RtspPort -WarningAction SilentlyContinue
  if (-not $tcp.TcpTestSucceeded) { throw "NVR answers but RTSP port $RtspPort is closed. Enable RTSP on the NVR." }
  Say "      NVR reachable, RTSP port $RtspPort open." Green

  $brands = if ($Brand -eq 'auto') { @('hikvision', 'dahua', 'uniview') } else { @($Brand) }
  $found = $null
  foreach ($b in $brands) {
    $r = Probe $ff $b @(1) $pass
    if ($r[1] -eq 'auth') { throw 'The NVR rejected the username/password. Check them (and that the account is not locked), then run -Reset and -Install.' }
    if ($r[1] -like 'ok:*') { $found = $b; Say ("      Brand format: {0}  (video {1})" -f $b, $r[1].Substring(3)) Green; break }
  }
  if (-not $found) { throw 'Could not read camera 1 in any known format. Send Drishyam the NVR brand and model.' }

  $list = if ($OnlyChannels.Count) { @($OnlyChannels | ForEach-Object { [int]$_ }) } else { @(1..$MaxChannels) }
  Say "`n[2/3] Finding working channels ($($list -join ','), 4 at a time, about $([Math]::Ceiling($list.Count / 4) * 8) seconds at most) ..." Cyan
  $r = Probe $ff $found $list $pass
  $ok = @($r.Keys | Where-Object { $r[$_] -like 'ok:*' } | Sort-Object)
  foreach ($ch in $list) {
    $v = $r[$ch]; if ($v -like 'ok:*') { Say ("      ch {0,-3} OK ({1})" -f $ch, $v.Substring(3)) Green } elseif ($v) { Say ("      ch {0,-3} no video" -f $ch) DarkGray }
  }
  if (-not $ok.Count) { throw 'No channel returned video.' }
  return @{ brand = $found; channels = $ok }
}

function Kick-Url($ch, $sub) { "http://$NvrIp/ISAPI/Streaming/channels/{0}{1}/requestKeyFrame" -f $ch, $(if ($sub) { '02' } else { '01' }) }

# One test request at install time. Only if the NVR answers 200 do the stream loops use it, so a
# model without this command (or a digest-auth mismatch) never produces repeated failed logins.
function Test-Kick($ch, $pass) {
  try {
    $cred = New-Object System.Management.Automation.PSCredential($NvrUser, (ConvertTo-SecureString $pass -AsPlainText -Force))
    $r = Invoke-WebRequest -Uri (Kick-Url $ch $SubStream) -Method Put -Credential $cred -UseBasicParsing -TimeoutSec 8
    return ($r.StatusCode -eq 200)
  } catch { return $false }
}

# Camera names as set on the NVR (Hikvision / Prama ISAPI). One request per list and no retries, so a
# digest-auth mismatch can never lock the account. Returns @{ <channel> = '<name>' } (empty if unknown).
function Get-ChannelNames($pass) {
  $names = @{}
  $cred = New-Object System.Management.Automation.PSCredential($NvrUser, (ConvertTo-SecureString $pass -AsPlainText -Force))
  foreach ($u in '/ISAPI/ContentMgmt/InputProxy/channels', '/ISAPI/System/Video/inputs/channels') {
    try {
      $r = Invoke-WebRequest -Uri "http://$NvrIp$u" -Credential $cred -UseBasicParsing -TimeoutSec 8
      $txt = if ($r.Content -is [byte[]]) { [Text.Encoding]::UTF8.GetString($r.Content) } else { [string]$r.Content }
      [xml]$x = $txt.Trim()
      foreach ($c in @($x.DocumentElement.ChildNodes)) {
        $id = 0; [void][int]::TryParse([string]$c.id, [ref]$id)
        $nm = ([string]$c.name).Trim()
        if ($id -gt 0 -and $nm -and -not $names.ContainsKey($id)) { $names[$id] = $nm }
      }
    } catch {}
  }
  return $names
}

function Mask($line) { $line -replace '//[^/@\s]+@', '//***@' }     # never print the NVR password

# Pick the fastest working H.264 encoder on this PC with a 1-second test encode.
function Pick-Encoder($ff) {
  foreach ($e in 'h264_nvenc', 'h264_qsv', 'h264_amf', 'libx264') {
    $pf = if ($e -eq 'h264_qsv') { 'nv12' } else { 'yuv420p' }
    $pr = Start-Process $ff -ArgumentList "-nostdin -hide_banner -loglevel error -f lavfi -i testsrc2=size=1280x720:rate=15 -t 1 -pix_fmt $pf -c:v $e -f null -" -WindowStyle Hidden -PassThru
    if (-not $pr.WaitForExit(20000)) { try { $pr.Kill() } catch {}; continue }
    if ($pr.ExitCode -eq 0) { return $e }
  }
  return 'libx264'
}

function Transcode-Args($enc, $sub) {
  $vf = if ($sub) { "fps=$TranscodeFps" } else { "scale=-2:$TranscodeHeight,fps=$TranscodeFps" }
  $pf = if ($enc -eq 'h264_qsv') { 'nv12' } else { 'yuv420p' }
  $o = switch ($enc) { 'h264_nvenc' { '-preset p4 -tune ll' } 'h264_qsv' { '-preset veryfast' } 'h264_amf' { '-usage lowlatency' } default { '-preset veryfast -tune zerolatency' } }
  $br = if ($sub) { '600k' } else { '1800k' }
  return "-vf $vf -pix_fmt $pf -c:v $enc $o -b:v $br -maxrate $br -bufsize $br -g $($TranscodeFps * 2) -bf 0"
}

function Stream-Name($st, $ch) { "edge_{0}_{1}_ch{2}" -f $st.site, $st.token, $ch }

function Pid-File($st, $ch) { Join-Path $Root ("pids\" + (Stream-Name $st $ch) + '.pid') }

# A channel counts as running while its supervising loop is alive (ffmpeg itself may be in the
# 5-second gap between restarts, so it is not the right thing to check).
function Loop-Pid($pf) {
  if (-not (Test-Path $pf)) { return $null }
  $pr = $null; $same = $false
  try {
    $pr = Get-Process -Id ([int](Get-Content $pf -Raw)) -ErrorAction SilentlyContinue
    # the PID file survives a reboot or power cut, and Windows may hand that number to another
    # program afterwards: trust it only if that process started when the file was written
    $same = [Math]::Abs(($pr.StartTime - (Get-Item $pf).LastWriteTime).TotalSeconds) -lt 120
  } catch {}
  if ($pr -and $pr.ProcessName -eq 'powershell' -and $same) { return $pr.Id }
  Remove-Item $pf -Force -ErrorAction SilentlyContinue                 # stale: forget it
  return $null
}

function Running-Channels($st) {
  $set = @{}
  foreach ($ch in $st.channels) { if (Loop-Pid (Pid-File $st $ch)) { $set[[int]$ch] = $true } }
  return $set
}

function Start-Relays($st, $restartAll) {
  $ff = $st.ffmpeg; $pass = Unprotect $st.pass
  if ($restartAll) { Stop-Relays $st }
  New-Item -ItemType Directory -Force -Path (Join-Path $Root 'pids'), $Logs | Out-Null
  $up = Running-Channels $st
  $n = 0
  foreach ($ch in $st.channels) {
    if ($up[[int]$ch]) { continue }                                  # already streaming: leave it alone
    $name = Stream-Name $st $ch
    $src  = Src-Url $st.brand $ch $st.sub $st.user $pass
    $dst  = "rtsps://$($st.cloud)/$name"
    $log  = Join-Path $Logs "$name.log"
    $err  = Join-Path $Logs "$name.err"
    $pf   = Pid-File $st $ch
    # Wait up to 15 s for a key frame before starting the push: H.265 cameras (especially Hikvision
    # "H.265+") send the codec setup only with key frames, and without it ffmpeg cannot write the
    # stream header ("Could not find codec parameters ... unspecified size") and loops forever.
    # -tls_verify 0: the cloud relay endpoint uses a self-signed certificate; ffmpeg 9+ refuses it by
    # default ("Peer certificate failed verification"). The link stays TLS-encrypted.
    # -timeout 10000000 (10 s, input side): if the NVR stops sending, ffmpeg exits and is restarted
    # instead of hanging on a dead connection with the camera black in Drishyam.
    $codec  = if ($st.tcArgs) { $st.tcArgs } else { '-c copy' }
    $ffArgs = "-nostdin -loglevel warning -rtsp_transport tcp -timeout 10000000 -analyzeduration 20000000 -probesize 30000000 -fflags +genpts -i `"$src`" $codec -an -f rtsp -rtsp_transport tcp -tls_verify 0 `"$dst`""
    $kick = ''
    if ($st.kick) {
      $ku = Kick-Url $ch $st.sub
      # ask for a key frame 2, 5, 9 and 15 s after connecting (inside the 20 s wait above)
      $kick = "`$kc = New-Object System.Management.Automation.PSCredential('$(& { param($x) $x.Replace("'", "''") } $st.user)', (ConvertTo-SecureString '$($pass.Replace("'", "''"))' -AsPlainText -Force))`r`n" +
              "foreach (`$s in 2,3,4,6) { Start-Sleep -Seconds `$s; if (`$p.HasExited) { break }; try { Invoke-WebRequest -Uri '$ku' -Method Put -Credential `$kc -UseBasicParsing -TimeoutSec 5 | Out-Null } catch {} }"
    }
    $q = { param($x) $x.Replace("'", "''") }
    # Supervising loop: restarts ffmpeg 5 s after any drop, keeps the log under 5 MB.
    # Passed as -EncodedCommand, so paths and passwords need no shell quoting at all.
    $loop = @"
`$ErrorActionPreference = 'SilentlyContinue'
Set-Content -Path '$(& $q $pf)' -Value `$PID
# keep the PC from going to sleep while this stream runs (released automatically when it stops)
try { Add-Type -Namespace DrsRelay -Name Power -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);'; [void][DrsRelay.Power]::SetThreadExecutionState([uint32]2147483649) } catch {}
`$fails = 0
while (`$true) {
  if ((Test-Path '$(& $q $log)') -and (Get-Item '$(& $q $log)').Length -gt 5MB) { Clear-Content '$(& $q $log)' }
  Add-Content '$(& $q $log)' ('---- start ' + (Get-Date))
  `$t0 = Get-Date
  `$p = Start-Process -FilePath '$(& $q $ff)' -ArgumentList '$(& $q $ffArgs)' -NoNewWindow -PassThru -RedirectStandardError '$(& $q $err)'
$kick
  `$p.WaitForExit()
  Get-Content '$(& $q $err)' | Add-Content '$(& $q $log)'
  # back off when a stream keeps failing fast, so a broken camera cannot flood the NVR with
  # reconnects (small NVRs stop answering their own web page under that load). Capped at 60 s:
  # after an internet or NVR outage every camera is back within a minute of the cause clearing.
  if (((Get-Date) - `$t0).TotalSeconds -lt 90) { `$fails++ } else { `$fails = 0 }
  `$wait = [Math]::Min(60, 5 * [Math]::Pow(2, [Math]::Min(`$fails, 4)))
  Add-Content '$(& $q $log)' ('---- dropped, retry in ' + `$wait + 's ' + (Get-Date))
  Start-Sleep -Seconds `$wait
}
"@
    $b64 = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($loop))
    Start-Process powershell -WindowStyle Hidden -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', $b64
    $n++
  }
  Start-Backfill $st
  return $n
}

function Stop-Relays($st) {
  foreach ($pf in @(@($st.channels | ForEach-Object { Pid-File $st $_ }) + (Join-Path $Root 'pids\backfill.pid'))) {
    $id = Loop-Pid $pf
    if ($id) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }
    Remove-Item $pf -Force -ErrorAction SilentlyContinue
  }
  # the tag also matches the missed-footage pulls (their output file is named after the stream)
  $tag = "edge_$($st.site)_$($st.token)_ch"
  Get-CimInstance Win32_Process -Filter "Name='ffmpeg.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like "*$tag*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

# ============================ MISSED-FOOTAGE BACKFILL ============================
# The cloud says which minutes it is missing (GET /api/relay/v1/gaps), the NVR's recording list says
# which of those it has, and each minute is copied from NVR playback into a file named
# <stream>__<UTC start>.mp4 under backfill\queue, then PUT to /api/relay/v1/backfill. A file leaves
# the queue only when the cloud has confirmed it, so a second outage during catch-up loses nothing.
# One NVR playback session at a time, and a camera is caught up only while its live push has been
# healthy for 2 minutes: live video always comes first, and a small NVR is never overloaded.

function Relay-Prefix($st) { "edge_{0}_{1}" -f $st.site, $st.token }
function Iso($dt)       { $dt.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", $Inv) }          # API times, always UTC
function Hik-Fmt($dt)   { $dt.ToString("yyyyMMdd'T'HHmmss'Z'", $Inv) }              # NVR playback URL / file names
function Parse-Utc($s)  { if ($s -is [DateTime]) { return $s.ToUniversalTime() }; [DateTimeOffset]::Parse([string]$s, $Inv).UtcDateTime }
function Nvr-Parse($s)  { [DateTime]::ParseExact(([string]$s).Trim().Substring(0, 19), 'yyyy-MM-ddTHH:mm:ss', $Inv) }

function Bf-Log($m) {
  try {
    New-Item -ItemType Directory -Force -Path $Logs | Out-Null
    if ((Test-Path $BfLog) -and (Get-Item $BfLog).Length -gt 5MB) { Clear-Content $BfLog }
    Add-Content $BfLog ('{0}  {1}' -f (Get-Date).ToString('yyyy-MM-dd HH:mm:ss'), (Mask $m))
  } catch {}
}

function New-UploadKey {
  $b = New-Object byte[] 32
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
  return (($b | ForEach-Object { $_.ToString('x2') }) -join '')
}

# JSON call to the Drishyam API with this site's upload key. Never throws: returns @{ code; body; error }.
function Api-Call($st, $method, $path, $body) {
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  $h = @{ Authorization = 'Bearer ' + (Unprotect $st.bfKey); 'X-Relay-Prefix' = (Relay-Prefix $st); 'X-Relay-Version' = $RelayVersion }
  $p = @{ Uri = ($st.api.TrimEnd('/') + $path); Method = $method; Headers = $h; UseBasicParsing = $true; TimeoutSec = 30; ErrorAction = 'Stop' }
  if ($null -ne $body) { $p.Body = ($body | ConvertTo-Json -Depth 5 -Compress); $p.ContentType = 'application/json' }
  try {
    $r = Invoke-WebRequest @p
    $obj = $null; try { $obj = $r.Content | ConvertFrom-Json } catch {}
    return @{ code = [int]$r.StatusCode; body = $obj }
  } catch {
    $code = 0; try { $code = [int]$_.Exception.Response.StatusCode } catch {}
    return @{ code = $code; body = $null; error = $_.Exception.Message }
  }
}

# Tell the cloud which streams this relay owns and which key signs its uploads. The first key seen
# for a prefix is the one the cloud keeps (409 = a different key already owns these streams).
function Bf-Register($st) {
  $streams = @($st.channels | ForEach-Object { Stream-Name $st $_ })
  Api-Call $st 'POST' '/api/relay/v1/register' @{ prefix = (Relay-Prefix $st); streams = $streams; brand = $st.brand; version = $RelayVersion; hostname = $env:COMPUTERNAME }
}

function Nvr-Http($st, $method, $path, $body) {
  $cred = New-Object System.Management.Automation.PSCredential($st.user, (ConvertTo-SecureString (Unprotect $st.pass) -AsPlainText -Force))
  $p = @{ Uri = "http://$NvrIp$path"; Method = $method; Credential = $cred; UseBasicParsing = $true; TimeoutSec = 20; ErrorAction = 'Stop' }
  if ($body) { $p.Body = $body; $p.ContentType = 'application/xml' }
  try { $r = Invoke-WebRequest @p }
  catch {
    $code = 0; try { $code = [int]$_.Exception.Response.StatusCode } catch {}
    if ($code -eq 401) { throw 'NVR rejected the password (backfill paused so the account is not locked)' }
    throw ("NVR {0} {1} failed: {2}" -f $method, $path, $_.Exception.Message)
  }
  if ($r.Content -is [byte[]]) { return [Text.Encoding]::UTF8.GetString($r.Content) } else { return [string]$r.Content }
}

# How far the NVR's clock reads from real UTC, for both ways firmware may mean its "...Z" times:
#   local = the NVR's wall-clock digits (most Hikvision / Prama firmware), utc = true UTC (+ clock error).
function Nvr-Clock($st) {
  $x = Nvr-Http $st 'GET' '/ISAPI/System/time' $null
  if ($x -notmatch '<localTime>\s*([^<]+?)\s*</localTime>') { throw 'NVR did not report its time' }
  $lt = $Matches[1]; $now = [DateTime]::UtcNow
  $digits = Nvr-Parse $lt
  $local = [Math]::Round(($digits - $now).TotalSeconds)
  $utc = $null
  if ($lt.Length -gt 19) { try { $utc = [Math]::Round(([DateTimeOffset]::Parse($lt, $Inv).UtcDateTime - $now).TotalSeconds) } catch {} }
  if ($null -eq $utc) { $utc = $local - [Math]::Round([TimeZoneInfo]::Local.GetUtcOffset($now).TotalSeconds) }   # assume the PC's time zone
  return @{ local = $local; utc = $utc; nvrTime = $lt }
}

# What the NVR recorded on one channel between two NVR-clock times: one @{ s; e } per recording file.
function Nvr-Recorded($st, $ch, $fromN, $toN) {
  $pos = 0
  for ($page = 0; $page -lt 10; $page++) {
    $xml = '<?xml version="1.0" encoding="UTF-8"?><CMSearchDescription>' +
      "<searchID>$([guid]::NewGuid().ToString().ToUpper())</searchID>" +
      "<trackList><trackID>$([int]$ch * 100 + 1)</trackID></trackList>" +
      "<timeSpanList><timeSpan><startTime>$(Iso $fromN)</startTime><endTime>$(Iso $toN)</endTime></timeSpan></timeSpanList>" +
      "<maxResults>100</maxResults><searchResultPostion>$pos</searchResultPostion>" +       # ISAPI's own spelling
      '<metadataList><metadataDescriptor>//recordType.meta.std-cgi.com</metadataDescriptor></metadataList></CMSearchDescription>'
    $r = Nvr-Http $st 'POST' '/ISAPI/ContentMgmt/search' $xml
    $n = 0
    foreach ($m in [regex]::Matches($r, '<timeSpan>\s*<startTime>([^<]+)</startTime>\s*<endTime>([^<]+)</endTime>')) {
      $s = Nvr-Parse $m.Groups[1].Value; $e = Nvr-Parse $m.Groups[2].Value
      if ($e -gt $s) { @{ s = $s; e = $e } }
      $n++
    }
    if ($n -eq 0 -or $r -notmatch '<responseStatusStrg>\s*MORE') { break }
    $pos += $n
  }
}

# Which clock reading the NVR's search/playback times use. Asked for the last few hours in LOCAL digits:
# an NVR that means UTC sees that window as hours in the future and has nothing there, so footage
# found => local. Checked on every plan (two small requests), never cached, so a wrong guess cannot stick.
function Bf-ClockMode($st, $ch, $clk) {
  $diff = [Math]::Abs($clk.local - $clk.utc)
  if ($diff -lt 120) { return 'utc' }                    # NVR runs on UTC: both readings agree
  $win = $diff - 300; $now = [DateTime]::UtcNow
  if (@(Nvr-Recorded $st $ch $now.AddSeconds($clk.local - $win) $now.AddSeconds($clk.local)).Count) { return 'local' }
  if (@(Nvr-Recorded $st $ch $now.AddSeconds($clk.utc - $win) $now.AddSeconds($clk.utc)).Count) { return 'utc' }
  return $null                                           # nothing recorded lately: cannot tell, try later
}

function Bf-LoadSkip($hours) {
  $h = @{}; $keep = [DateTime]::UtcNow.AddHours(-([double]$hours + 2))
  if (Test-Path $BfSkip) {
    foreach ($l in Get-Content $BfSkip) {
      $p = $l -split "`t"
      if ($p.Count -eq 2) { try { if ((Parse-Utc $p[1]) -gt $keep) { $h[$p[0]] = $p[1] } } catch {} }
    }
  }
  New-Item -ItemType Directory -Force -Path $BfDir | Out-Null
  @($h.Keys | ForEach-Object { "$_`t$($h[$_])" }) | Set-Content $BfSkip -Encoding UTF8      # drop old entries
  return $h
}
function Bf-AddSkip($h, $key) { $h[$key] = Iso ([DateTime]::UtcNow); Add-Content $BfSkip ("$key`t" + $h[$key]) }

# Build the catch-up list: per channel, the missing minutes the NVR actually has, oldest first.
# $quiet = $false prints what was found (used by -TestBackfill).
function Bf-Plan($st, $skip, $quiet) {
  $plan = @{}; $now = [DateTime]::UtcNow
  $from = $now.AddHours(-[double]$st.bfHours); $to = $now.AddSeconds(-180)
  $clk = $null; $mode = $null; $shift = 0
  foreach ($ch in $st.channels) {
    $name = Stream-Name $st $ch
    $r = Api-Call $st 'GET' ("/api/relay/v1/gaps?stream={0}&from={1}&to={2}" -f $name, [uri]::EscapeDataString((Iso $from)), [uri]::EscapeDataString((Iso $to))) $null
    if ($r.code -eq 401 -or $r.code -eq 403) { throw "cloud rejected the upload key ($($r.code)) - run -Install again" }
    if ($r.code -ne 200 -or -not $r.body) { Bf-Log "ch $ch : cloud gaps answered $($r.code) $($r.error)"; if (-not $quiet) { Say "  ch $ch : cloud answered $($r.code) $($r.error)" Yellow }; continue }
    if ($r.body.recording -eq $false) { if (-not $quiet) { Say "  ch $ch : not recorded in the cloud - nothing to fill" DarkGray }; continue }
    $gaps = @($r.body.gaps | Where-Object { $_ })
    if (-not $quiet) { Say ("  ch {0} : cloud is missing {1} window(s)" -f $ch, $gaps.Count) $(if ($gaps.Count) { 'Yellow' } else { 'Green' }) }
    if (-not $gaps.Count) { continue }
    if (-not $clk) {
      $clk = Nvr-Clock $st
      $mode = Bf-ClockMode $st $ch $clk
      if (-not $quiet) { Say ("        NVR time {0}; NVR times are read as {1}" -f $clk.nvrTime, $(if ($mode) { $mode } else { 'UNKNOWN (nothing recorded lately)' })) DarkGray }
      if (-not $mode) { Bf-Log 'NVR clock: cannot tell local/UTC from its recording list yet - will retry'; return @{ plan = @{}; shift = 0; mode = $null } }
      $shift = $clk.$mode
    }
    $chunks = New-Object System.Collections.ArrayList; $seen = @{}
    foreach ($g in $gaps) {
      $gs = Parse-Utc $g.start; $ge = Parse-Utc $g.end
      if ($gs -lt $from) { $gs = $from }; if ($ge -gt $to) { $ge = $to }
      if ($ge -le $gs) { continue }
      $have = 0
      foreach ($sp in @(Nvr-Recorded $st $ch $gs.AddSeconds($shift) $ge.AddSeconds($shift) | Sort-Object { $_.s })) {
        $s = $sp.s.AddSeconds(-$shift); $e = $sp.e.AddSeconds(-$shift)
        if ($s -lt $gs) { $s = $gs }; if ($e -gt $ge) { $e = $ge }
        for ($c = $s; ($e - $c).TotalSeconds -ge 5; $c = $c.AddSeconds($BfChunkSec)) {
          $key = "$name|$(Iso $c)"
          if ($seen[$key] -or $skip.ContainsKey($key)) { continue }
          $seen[$key] = $true
          $len = [int][Math]::Min($BfChunkSec, [Math]::Ceiling(($e - $c).TotalSeconds))
          [void]$chunks.Add(@{ ch = [int]$ch; name = $name; start = $c; len = $len; key = $key }); $have += $len
        }
      }
      if (-not $quiet) { Say ("        {0} -> {1} UTC  missing {2} min, NVR has {3} min" -f (Iso $gs), (Iso $ge), [Math]::Round(($ge - $gs).TotalMinutes), [Math]::Round($have / 60)) Gray }
    }
    if ($chunks.Count) { $plan["$ch"] = $chunks }
  }
  return @{ plan = $plan; shift = $shift; mode = $mode }
}

# Copy one chunk from NVR playback into the queue. Returns the file, 'nodata' or 'retry'.
function Bf-Pull($st, $c, $shift) {
  $pass = Unprotect $st.pass
  $u = [uri]::EscapeDataString($st.user); $p = [uri]::EscapeDataString($pass)
  $s = $c.start.AddSeconds($shift)
  $src = "rtsp://${u}:${p}@${NvrIp}:${RtspPort}/Streaming/tracks/$($c.ch * 100 + 1)?starttime=$(Hik-Fmt $s)&endtime=$(Hik-Fmt $s.AddSeconds($c.len + 10))"
  $base = '{0}__{1}' -f $c.name, (Hik-Fmt $c.start)
  $part = Join-Path $BfQueue "$base.part"; $out = Join-Path $BfQueue "$base.mp4"; $errf = Join-Path $BfDir 'pull.err'
  $codec = if ($st.bfTc) { $st.bfTc } else { '-c copy' }
  $fa = "-nostdin -loglevel error -y -rtsp_transport tcp -timeout 15000000 -analyzeduration 20000000 -probesize 30000000 -fflags +genpts -i `"$src`" -t $($c.len) -map 0:v:0 $codec -an -movflags +faststart -f mp4 `"$part`""
  $pr = Start-Process $st.ffmpeg -ArgumentList $fa -WindowStyle Hidden -PassThru -RedirectStandardError $errf
  $null = $pr.Handle        # without this, PowerShell 5.1 loses ExitCode when stderr is redirected
  # NVR playback runs at normal speed: a 60 s chunk takes about 60 s
  if (-not $pr.WaitForExit(($c.len + 60) * 1000)) { try { $pr.Kill() } catch {}; Remove-Item $part -Force -ErrorAction SilentlyContinue; return 'retry' }
  $err = Get-Content $errf -Raw -ErrorAction SilentlyContinue
  $size = 0; if (Test-Path $part) { $size = (Get-Item $part).Length }
  if ($pr.ExitCode -eq 0 -and $size -gt 64KB) { Move-Item $part $out -Force; return $out }
  Remove-Item $part -Force -ErrorAction SilentlyContinue
  if ($err -match '401|Unauthorized') { throw 'NVR rejected the password (backfill paused so the account is not locked)' }
  $why = ("$err" -replace '\s+', ' ').Trim(); if ($why.Length -gt 160) { $why = $why.Substring(0, 160) }
  if (-not $why) { $why = "exit $($pr.ExitCode), $size bytes" }
  Bf-Log ("ch {0} {1}: NVR playback gave no video ({2})" -f $c.ch, (Iso $c.start), $why)
  if ($err -match 'timed out|Connection refused|Connection reset|Network is unreachable|No route') { return 'retry' }
  return 'nodata'
}

# PUT one queued file. Returns the HTTP status (0 = cloud not reachable).
function Bf-Put($st, $file) {
  $leaf = [IO.Path]::GetFileNameWithoutExtension($file); $i = $leaf.LastIndexOf('__')
  $name = $leaf.Substring(0, $i)
  $start = [DateTime]::ParseExact($leaf.Substring($i + 2), "yyyyMMdd'T'HHmmss'Z'", $Inv)
  $url = "{0}/api/relay/v1/backfill?stream={1}&start={2}" -f $st.api.TrimEnd('/'), $name, [uri]::EscapeDataString((Iso $start))
  $key = Unprotect $st.bfKey; $prefix = Relay-Prefix $st
  $curl = Join-Path $env:SystemRoot 'System32\curl.exe'
  if (Test-Path $curl) {
    $resp = Join-Path $BfDir 'upload.resp'
    $rate = [int]([double]$st.bfMbps * 125000)                             # Mbps -> bytes per second
    $code = & $curl -s -o $resp -w '%{http_code}' -T $file -H "Authorization: Bearer $key" -H "X-Relay-Prefix: $prefix" -H "X-Relay-Version: $RelayVersion" -H 'Content-Type: video/mp4' --limit-rate $rate --connect-timeout 20 --max-time 1800 $url
    $n = 0; [void][int]::TryParse(([string]$code).Trim(), [ref]$n); return $n
  }
  # no curl.exe (Windows Server 2016): plain upload, without the speed cap
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  try {
    $r = Invoke-WebRequest -Uri $url -Method Put -InFile $file -ContentType 'video/mp4' -UseBasicParsing -TimeoutSec 1800 -ErrorAction Stop `
           -Headers @{ Authorization = "Bearer $key"; 'X-Relay-Prefix' = $prefix; 'X-Relay-Version' = $RelayVersion }
    return [int]$r.StatusCode
  } catch { try { return [int]$_.Exception.Response.StatusCode } catch { return 0 } }
}

# Upload everything waiting in the queue, oldest first. $true = queue empty; $false = stop and retry later.
function Bf-Drain($st, $done) {
  foreach ($f in @(Get-ChildItem $BfQueue -Filter *.mp4 -ErrorAction SilentlyContinue | Sort-Object { $_.Name.Substring($_.Name.LastIndexOf('__')) })) {
    $code = Bf-Put $st $f.FullName
    $leaf = $f.BaseName; $i = $leaf.LastIndexOf('__')
    $key = '{0}|{1}' -f $leaf.Substring(0, $i), (Iso ([DateTime]::ParseExact($leaf.Substring($i + 2), "yyyyMMdd'T'HHmmss'Z'", $Inv)))
    switch ($code) {
      { $_ -in 200, 201 } { Remove-Item $f.FullName -Force; $done[$key] = $true; Bf-Log "uploaded $($f.Name) ($([Math]::Round($f.Length / 1MB, 1)) MB)"; continue }
      409 { Remove-Item $f.FullName -Force; $done[$key] = $true; Bf-Log "cloud already has $($f.Name)"; continue }
      { $_ -in 400, 404, 413, 415, 422 } {
        # the cloud will never take this file (bad video / unknown stream / recording off): keep the last
        # few for inspection, never retry them
        $rej = Join-Path $BfDir 'rejected'; New-Item -ItemType Directory -Force -Path $rej | Out-Null
        Move-Item $f.FullName (Join-Path $rej $f.Name) -Force; $done[$key] = $true
        Get-ChildItem $rej | Sort-Object LastWriteTime -Descending | Select-Object -Skip 10 | Remove-Item -Force -ErrorAction SilentlyContinue
        Bf-Log "cloud refused $($f.Name) with $code - set aside in backfill\rejected"; continue
      }
      { $_ -in 401, 403 } { throw "cloud rejected the upload key ($code) - run -Install again" }
      default { Bf-Log "upload of $($f.Name) failed ($code) - will retry"; return $false }
    }
  }
  return $true
}

# stream name -> seconds its live push to the cloud has been running
function Live-Ages($st) {
  $m = @{}; $tag = "edge_$($st.site)_$($st.token)_ch"
  foreach ($p in @(Get-CimInstance Win32_Process -Filter "Name='ffmpeg.exe'" -ErrorAction SilentlyContinue)) {
    if ($p.CommandLine -like "*rtsps://*$tag*" -and $p.CommandLine -match '(edge_[a-z0-9]+_[a-z0-9]+_ch\d+)') {
      $m[$Matches[1]] = ((Get-Date) - $p.CreationDate).TotalSeconds
    }
  }
  return $m
}

function Start-Backfill($st) {
  if (-not ($st.bf -and $st.bfKey)) { return }
  $pf = Join-Path $Root 'pids\backfill.pid'
  if (Loop-Pid $pf) { return }
  $dest = Join-Path $Root 'drishyam-site-relay.ps1'
  if (-not (Test-Path $dest)) { return }
  Start-Process powershell -WindowStyle Hidden -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', "`"$dest`"", '-BackfillWorker'
}

# The background worker (started by Start-Relays, one per PC, restarted by the 3-minute task if it dies).
function Run-Backfill {
  $ErrorActionPreference = 'Continue'
  $st = Load-State
  if (-not ($st -and $st.bf -and $st.bfKey)) { return }
  New-Item -ItemType Directory -Force -Path $BfQueue, (Join-Path $Root 'pids') | Out-Null
  Set-Content -Path (Join-Path $Root 'pids\backfill.pid') -Value $PID
  try { Add-Type -Namespace DrsRelay -Name Power -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);'; [void][DrsRelay.Power]::SetThreadExecutionState([uint32]2147483649) } catch {}
  Get-ChildItem $BfQueue -Filter *.part -ErrorAction SilentlyContinue | Remove-Item -Force    # half-written before a crash
  $skip = Bf-LoadSkip $st.bfHours; $done = @{}; $fails = @{}
  $registered = $false; $plan = @{}; $shift = 0; $nextPlan = [DateTime]::MinValue
  Bf-Log "worker started (v$RelayVersion, look back $($st.bfHours) h, upload cap $($st.bfMbps) Mbps)"
  while ($true) {
    try {
      if (-not $registered) {
        $r = Bf-Register $st
        if ($r.code -in 200, 201) { $registered = $true; Bf-Log 'registered with the cloud' }
        elseif ($r.code -in 401, 403, 409) { Bf-Log "cloud refused this relay's key ($($r.code)) - ask Drishyam to reset it, then run -Install"; Start-Sleep -Seconds 900; continue }
        else { Bf-Log "cloud not reachable for registration ($($r.code) $($r.error))"; Start-Sleep -Seconds 60; continue }
      }
      if (-not (Bf-Drain $st $done)) { Start-Sleep -Seconds 60; continue }
      if ($plan.Count -eq 0) {
        if ((Get-Date) -lt $nextPlan) { Start-Sleep -Seconds 30; continue }
        $nextPlan = (Get-Date).AddMinutes(5)
        $res = Bf-Plan $st $skip $true
        $plan = @{}; $shift = $res.shift
        foreach ($k in $res.plan.Keys) {
          $l = New-Object System.Collections.ArrayList
          foreach ($c in $res.plan[$k]) { if (-not $done[$c.key]) { [void]$l.Add($c) } }
          if ($l.Count) { $plan[$k] = $l }
        }
        if ($plan.Count) {
          $parts = foreach ($k in ($plan.Keys | Sort-Object { [int]$_ })) { $sec = 0; foreach ($c in $plan[$k]) { $sec += $c.len }; "ch $k $([Math]::Round($sec / 60)) min" }
          Bf-Log ('missing footage to copy: ' + ($parts -join ', ') + " (NVR clock read as $($res.mode))")
        }
        continue
      }
      # one chunk per channel per round, so every camera catches up together
      $live = Live-Ages $st; $did = $false
      foreach ($k in @($plan.Keys | Sort-Object { [int]$_ })) {
        $q = $plan[$k]; $c = $q[0]
        if (-not $live[$c.name] -or $live[$c.name] -lt $BfLiveStableSec) { continue }       # live first
        $q.RemoveAt(0); if (-not $q.Count) { $plan.Remove($k) }
        $did = $true
        $res = Bf-Pull $st $c $shift
        if ($res -eq 'nodata') { Bf-AddSkip $skip $c.key }
        elseif ($res -eq 'retry') {
          # NVR busy or unreachable: leave the minute for the next plan (it is still a gap in the cloud),
          # give up on it only after 5 failed tries, and give the NVR a break
          $fails[$c.key] = 1 + [int]$fails[$c.key]
          if ($fails[$c.key] -ge 5) { Bf-AddSkip $skip $c.key }
          Start-Sleep -Seconds 30; break
        }
        if (-not (Bf-Drain $st $done)) { break }
      }
      if (-not $did) { Start-Sleep -Seconds 20 }
    } catch {
      $msg = $_.Exception.Message; Bf-Log "paused: $msg"
      $plan = @{}
      if ($msg -like '*upload key*') { $registered = $false; Start-Sleep -Seconds 900 }
      elseif ($msg -like '*password*') { Start-Sleep -Seconds 1800 }
      else { Start-Sleep -Seconds 60 }
    }
  }
}

# A relay PC must come back by itself after a shutdown, restart or power cut, and must never be
# left asleep: a sleeping PC does not wake when the power returns.
function Set-AlwaysOn {
  $lid = '5ca83367-6e45-459f-a27b-476b1d01c936'                      # "lid close action" (laptops only)
  foreach ($a in @('/change standby-timeout-ac 0', '/change hibernate-timeout-ac 0',
                   '/change standby-timeout-dc 0', '/change hibernate-timeout-dc 0',
                   "/setacvalueindex SCHEME_CURRENT SUB_BUTTONS $lid 0",
                   "/setdcvalueindex SCHEME_CURRENT SUB_BUTTONS $lid 0",
                   '/setacvalueindex SCHEME_CURRENT SUB_SLEEP RTCWAKE 1',
                   '/setdcvalueindex SCHEME_CURRENT SUB_SLEEP RTCWAKE 1',
                   '/setactive SCHEME_CURRENT')) {
    try { & powercfg.exe @($a -split ' ') | Out-Null } catch {}
  }
  # Fast Startup turns "Shut down" into a hibernate, and tasks set to run at startup then do not run
  try { Set-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Power' -Name HiberbootEnabled -Value 0 -Type DWord } catch {}
}

function Show-Cameras($st) {
  Say "`n================  ADD THESE CAMERAS IN DRISHYAM  ================" Cyan
  Say ("Site: {0}   NVR: {1} ({2})   Streams: {3}" -f $st.site, $NvrIp, $st.brand, $st.channels.Count) Gray
  Say 'For each camera:  Host = mediamtx   Port = 8554   Path = (below)   Username/Password = empty' Gray
  $lines = foreach ($ch in $st.channels) {
    $nm = if ($st.names -and $st.names."$ch") { '   Name  ' + $st.names."$ch" } else { '' }
    "  Camera {0,-3} ->  Path  /{1}{2}" -f $ch, (Stream-Name $st $ch), $nm
  }
  $lines | ForEach-Object { Say $_ White }
  $out = Join-Path $Root 'drishyam-cameras.txt'
  @("Site: $($st.site)  NVR: $NvrIp ($($st.brand))  Created: $(Get-Date)", 'Host = mediamtx   Port = 8554   no username/password', '') + $lines | Set-Content $out -Encoding UTF8
  Say "Saved to: $out  (no passwords in it - safe to send to Drishyam)" DarkGray
}

# =============================== commands ===================================
try {
  if ($BackfillWorker) { Run-Backfill; return }
  if ($TestBackfill) {
    if (-not (Is-Admin)) { throw 'Run as Administrator.' }
    $st = Load-State; if (-not $st) { throw 'Not installed yet. Run -Install.' }
    if (-not ($st.bf -and $st.bfKey)) { throw 'Missed-footage upload is not set up on this PC (run -Install with $Backfill = $true, Hikvision / Prama NVR).' }
    Say "Cloud: $($st.api)" Cyan
    $r = Bf-Register $st
    Say ("  registration: {0} {1}" -f $r.code, $(if ($r.code -in 200, 201) { 'OK' } elseif ($r.code -eq 409) { '- a different key owns these streams (ask Drishyam to reset it)' } else { $r.error })) $(if ($r.code -in 200, 201) { 'Green' } else { 'Red' })
    if ($r.code -notin 200, 201) { return }
    Say "Missing footage in the last $($st.bfHours) h (nothing is copied or uploaded by this test):" Cyan
    [void](Bf-Plan $st (Bf-LoadSkip $st.bfHours) $false)
    $qn = @(Get-ChildItem $BfQueue -Filter *.mp4 -ErrorAction SilentlyContinue).Count
    Say "Files waiting to upload: $qn" Gray
    return
  }
  if ($Uninstall) {
    if (-not (Is-Admin)) { throw 'Run as Administrator.' }
    $st = Load-State; if ($st) { Stop-Relays $st }
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Say "Relay stopped and the Windows task removed. Settings kept in $Root (use -Reset to delete them)." Green
    return
  }
  if ($Reset) {
    if (-not (Is-Admin)) { throw 'Run as Administrator.' }
    $st = Load-State; if ($st) { Stop-Relays $st }
    Remove-Item $Root -Recurse -Force -ErrorAction SilentlyContinue
    Say 'Saved settings deleted. Run -Install to set up again.' Green
    return
  }
  if ($Status) {
    $st = Load-State; if (-not $st) { throw 'Not installed yet. Run -Install.' }
    $up = Running-Channels $st
    Say ("Site {0}: {1} of {2} streams running -> {3}" -f $st.site, $up.Count, $st.channels.Count, $st.cloud) Cyan
    foreach ($ch in $st.channels) {
      $name = Stream-Name $st $ch; $log = Join-Path $Logs "$name.log"
      $last = if (Test-Path $log) { Mask (Get-Content $log -Tail 1) } else { '(no log yet)' }
      Say ("  ch {0,-3} {1,-8} {2}" -f $ch, $(if ($up[[int]$ch]) { 'RUNNING' } else { 'DOWN' }), $last) $(if ($up[[int]$ch]) { 'Green' } else { 'Yellow' })
    }
    if ($st.bf -and $st.bfKey) {
      $bfUp = Loop-Pid (Join-Path $Root 'pids\backfill.pid')
      $qn = @(Get-ChildItem $BfQueue -Filter *.mp4 -ErrorAction SilentlyContinue).Count
      $bl = if (Test-Path $BfLog) { Get-Content $BfLog -Tail 1 } else { '(no log yet)' }
      Say ("Missed-footage upload: {0}, {1} file(s) waiting  {2}" -f $(if ($bfUp) { 'RUNNING' } else { 'DOWN' }), $qn, $bl) $(if ($bfUp) { 'Green' } else { 'Yellow' })
    } else { Say 'Missed-footage upload: off' DarkGray }
    Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue | ForEach-Object { Say ("Windows task: {0}" -f $_.State) DarkGray }
    return
  }
  if ($Log) {
    $st = Load-State; if (-not $st) { throw 'Not installed yet. Run -Install.' }
    foreach ($ch in $st.channels) {
      $f = Join-Path $Logs ((Stream-Name $st $ch) + '.log')
      Say "`n== camera $ch" Cyan
      if (Test-Path $f) { Get-Content $f -Tail 15 | ForEach-Object { Mask $_ } } else { '(no log yet)' }
    }
    $tl = Join-Path $Logs 'relay-task.log'
    if (Test-Path $tl) { Say "`n== restarts by the Windows task" Cyan; Get-Content $tl -Tail 8 }
    if (Test-Path $BfLog) { Say "`n== missed-footage upload" Cyan; Get-Content $BfLog -Tail 15 }
    return
  }
  if ($Test -or $Install) {
    if (-not (Is-Admin)) { throw 'Run this in an ADMINISTRATOR PowerShell (right-click PowerShell -> Run as administrator).' }
    $st = Load-State
    # stop every stream of the previous install first: the new channel list may be shorter, and
    # streams that are no longer wanted must not keep running
    if ($st -and $Install) {
      Stop-Relays $st
      Say 'Stopped the previous streams. Waiting 30 s for the NVR to release them...' DarkGray
      Start-Sleep -Seconds 30
    }
    $ff = Find-FFmpeg $st
    if ($st -and $st.pass) { $pass = Unprotect $st.pass }
    else {
      $sec = Read-Host "NVR password for user '$NvrUser' (typing is hidden)" -AsSecureString
      $pass = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
    }
    $d = Detect $ff $pass
    if ($Test) { Say "`nTest only: nothing was installed." Cyan; return }

    $site = if ($st -and $st.site) { $st.site } else { Read-Host 'Short site name for this location (letters/numbers, e.g. sharda or office1)' }
    $site = ($site.ToLower() -replace '[^a-z0-9]', ''); if (-not $site) { $site = 'site' }
    $token = if ($st -and $st.token) { $st.token } else { -join ((48..57) + (97..122) | Get-Random -Count 6 | ForEach-Object { [char]$_ }) }
    $kickOk = $false
    if ($KeyFrameKick -and $d.brand -eq 'hikvision') {
      $kickOk = Test-Kick $d.channels[0] $pass
      Say ("      Key-frame request (for H.265 cameras): " + $(if ($kickOk) { 'supported - enabled' } else { 'not supported by this NVR - skipped' })) $(if ($kickOk) { 'Green' } else { 'DarkGray' })
    }
    $names = [ordered]@{}
    if ($d.brand -eq 'hikvision') {
      $nm = Get-ChannelNames $pass
      foreach ($ch in $d.channels) { if ($nm[[int]$ch]) { $names["$ch"] = $nm[[int]$ch] } }
      Say ("      Camera names on the NVR: " + $(if ($names.Count) { "$($names.Count) found" } else { 'not readable - Drishyam will use Camera <n>' })) DarkGray
    }
    $tcArgs = $null; $bfTc = $null
    if ($Transcode) {
      Say '      Choosing an H.264 encoder (1-second test on each)...' Cyan
      $enc = Pick-Encoder $ff
      $tcArgs = Transcode-Args $enc $SubStream
      $bfTc = Transcode-Args $enc $false          # missed footage comes from the NVR's main recording
      Say ("      Converting to H.264 with: {0}{1}" -f $enc, $(if ($enc -eq 'libx264') { '  (processor - keep the number of channels low)' } else { '  (graphics chip)' })) Green
    }
    # missed-footage upload: Hikvision / Prama only (needs the NVR's ISAPI recording search). The key is
    # made once and kept across re-installs: the cloud remembers the first key it sees for these streams.
    $bf = [bool]($Backfill -and $d.brand -eq 'hikvision')
    $bfKey = if ($st -and $st.bfKey) { $st.bfKey } else { Protect (New-UploadKey) }
    $st = [pscustomobject]@{ site = $site; token = $token; user = $NvrUser; pass = (Protect $pass); brand = $d.brand; channels = $d.channels; sub = $SubStream; cloud = $Cloud; ffmpeg = $ff; kick = $kickOk; tcArgs = $tcArgs; names = $names; installed = (Get-Date).ToString('s');
                             bf = $bf; bfKey = $bfKey; bfHours = $BackfillHours; bfMbps = $BackfillMaxMbps; bfTc = $bfTc; api = $Api }
    Save-State $st

    Say "`n[3/3] Installing the Windows task and starting the streams ..." Cyan
    $self = $PSCommandPath; $dest = Join-Path $Root 'drishyam-site-relay.ps1'
    if ($self -ne $dest) { Copy-Item $self $dest -Force }                       # task runs a protected copy
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$dest`""
    $tBoot = New-ScheduledTaskTrigger -AtStartup
    $tEvery = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 3) -RepetitionDuration (New-TimeSpan -Days 3650)
    $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    # runs without anyone logged in; wakes the PC if it ever goes to sleep; retries if a run fails
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -WakeToRun -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero)
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger @($tBoot, $tEvery) -Principal $principal -Settings $settings -Force | Out-Null
    Set-AlwaysOn
    $n = Start-Relays $st $true
    Say "      $n stream(s) started. They start again by themselves after a restart, shutdown or power cut" Green
    Say "      (no login needed), and the task re-checks every 3 minutes. Sleep and Fast Startup are turned off." Green
    Say "      AFTER A POWER CUT the PC itself must switch on: set BIOS 'Restore on AC Power Loss' = Power On." Yellow
    if ($bf) {
      $r = Bf-Register $st
      if ($r.code -in 200, 201) { Say "      Missed footage: ON - after an outage the last $BackfillHours h are filled in from the NVR's recordings." Green }
      elseif ($r.code -eq 409) { Say '      Missed footage: these streams are registered to another relay key - ask Drishyam to reset it, then run Install again.' Red }
      else { Say "      Missed footage: ON, but the cloud did not answer yet ($($r.code)) - it keeps trying by itself." Yellow }
    } elseif ($Backfill) { Say '      Missed footage: needs a Hikvision / Prama NVR - off for this brand.' DarkGray }
    Show-Cameras $st
    Say "`nCheck any time:  powershell -ExecutionPolicy Bypass -File `"$dest`" -Status" DarkGray
    return
  }

  # ---- default (what the Windows task runs every 3 min): start only what is down ----
  $st = Load-State
  if (-not $st) { Say 'Not installed. Run in an admin PowerShell:  .\drishyam-site-relay.ps1 -Install' Yellow; return }
  New-Item -ItemType Directory -Force -Path $Logs | Out-Null
  $n = Start-Relays $st $Force
  if ($n) { Add-Content (Join-Path $Logs 'relay-task.log') ("{0}  restarted {1} stream(s)" -f (Get-Date), $n) }
}
catch {
  Say ("`nERROR: " + $_.Exception.Message) Red
  exit 1
}
