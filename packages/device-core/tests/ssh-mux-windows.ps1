# Measures whether the OpenSSH on a Windows machine can multiplex (ControlMaster) and writes what it saw to the
# job summary. A measurement, not a test: it never fails the job. The desktop already runs one ssh process per
# server on Windows with no multiplexing (`ssh::MULTIPLEXING`); this records whether that is forced.
#
# It stops at the first stage it cannot get through and says which, so "not measured" is never read as "works".
$ErrorActionPreference = "Continue"

$summary = [System.Collections.Generic.List[string]]::new()
$raw = [System.Collections.Generic.List[string]]::new()

function Note([string]$text) { $summary.Add($text); Write-Host $text }
function Raw([string]$title, $output, $code) {
    $raw.Add("--- $title (exit $code)")
    $raw.Add(($output | Out-String).TrimEnd())
}
function Finish([string]$verdict) {
    $lines = @("## ssh ControlMaster on Windows", "", "**$verdict**", "")
    $lines += $summary
    $lines += @("", '```', ($raw -join "`n"), '```')
    $path = $env:GITHUB_STEP_SUMMARY
    if ($path) { $lines | Add-Content -Path $path -Encoding utf8 } else { $lines | Write-Host }
    exit 0
}

$version = (& ssh -V 2>&1) | Out-String
Note "ssh: $($version.Trim())"

# Stage 1: an sshd to log in to.
$capability = Get-WindowsCapability -Online -Name "OpenSSH.Server*" -ErrorAction SilentlyContinue | Select-Object -First 1
if ($capability -and $capability.State -ne "Installed") {
    Add-WindowsCapability -Online -Name $capability.Name | Out-Null
}
$service = Get-Service sshd -ErrorAction SilentlyContinue
if (-not $service) { Finish "not measured: this runner has no sshd and it could not be installed" }
Start-Service sshd -ErrorAction SilentlyContinue
if ((Get-Service sshd).Status -ne "Running") { Finish "not measured: sshd would not start" }

# Stage 2: a key it accepts. The runner account is an administrator, whose keys sshd reads from this file.
$key = Join-Path $env:RUNNER_TEMP "mux_key"
Remove-Item "$key*" -ErrorAction SilentlyContinue
& ssh-keygen -q -t ed25519 -N '""' -f $key | Out-Null
$authorized = Join-Path $env:ProgramData "ssh\administrators_authorized_keys"
Get-Content "$key.pub" | Set-Content -Path $authorized -Encoding ascii
& icacls $authorized /inheritance:r /grant "SYSTEM:(F)" /grant "BUILTIN\Administrators:(F)" | Out-Null

$common = @(
    "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=NUL", "-o", "BatchMode=yes",
    "-o", "PasswordAuthentication=no", "-o", "ConnectTimeout=15", "-i", $key, "-p", "22"
)
$destination = "$env:USERNAME@127.0.0.1"
$login = & ssh @common $destination "echo logged-in" 2>&1
Raw "login without multiplexing" $login $LASTEXITCODE
if (($login | Out-String) -notmatch "logged-in") { Finish "not measured: could not log in to the local sshd" }

# Stage 3: the master, a check against it, and a session that should ride it.
$path = Join-Path $env:RUNNER_TEMP "cm-%C"
$mux = @("-o", "ControlPath=$path")

$start = & ssh @common @mux -o ControlMaster=yes -o ControlPersist=60 -N -f $destination 2>&1
$startCode = $LASTEXITCODE
Raw "start a master (ControlMaster=yes, ControlPersist=60, -N -f)" $start $startCode

$check = & ssh @common @mux -O check $destination 2>&1
$checkCode = $LASTEXITCODE
Raw "ssh -O check" $check $checkCode

$ride = & ssh @common @mux -o ControlMaster=no $destination "echo rode-the-master" 2>&1
$rideCode = $LASTEXITCODE
Raw "a session with ControlMaster=no (it fails if there is no master to ride)" $ride $rideCode

& ssh @common @mux -O exit $destination 2>&1 | Out-Null

$works = ($startCode -eq 0) -and ($checkCode -eq 0) -and (($check | Out-String) -match "Master running") -and (($ride | Out-String) -match "rode-the-master")
Note "master start exit $startCode; check exit $checkCode; ride exit $rideCode"

if ($works) {
    Finish "ControlMaster WORKS on this runner's OpenSSH. The desktop still does not use it on Windows; the plan's S5 note says what to change."
}
Finish "ControlMaster does NOT work on this runner's OpenSSH. Windows keeps one ssh process per server with no multiplexing, and the window says so."
