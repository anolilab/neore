# Measures whether the OpenSSH on a Windows machine can multiplex (ControlMaster) and writes what it saw to the
# job summary. Neore does not multiplex on Windows (`ssh::MULTIPLEXING`): one ssh process per server. This records
# whether that is forced.
#
# It exits 0 with a verdict ("works" or "does not work") and exits 1 when it could not get far enough to give one,
# so a broken setup fails the step instead of passing as "not measured".
$ErrorActionPreference = "Continue"
# An empty argument must reach the native program as an empty argument.
$PSNativeCommandArgumentPassing = "Standard"

$summary = [System.Collections.Generic.List[string]]::new()
$raw = [System.Collections.Generic.List[string]]::new()

function Note([string]$text) { $summary.Add($text); Write-Host $text }
function Raw([string]$title, $output, $code) {
    $raw.Add("--- $title (exit $code)")
    $raw.Add(($output | Out-String).TrimEnd())
}
function Report([string]$verdict, [int]$exitCode) {
    $lines = @("## ssh ControlMaster on Windows", "", "**$verdict**", "")
    $lines += $summary
    $lines += @("", '```', ($raw -join "`n"), '```')
    $path = $env:GITHUB_STEP_SUMMARY
    if ($path) { $lines | Add-Content -Path $path -Encoding utf8 } else { $lines | Write-Host }
    exit $exitCode
}
function Fail([string]$why) { Report "not measured: $why" 1 }

$version = (& ssh -V 2>&1) | Out-String
Note "ssh: $($version.Trim())"

# Stage 1: an sshd to log in to.
$capability = Get-WindowsCapability -Online -Name "OpenSSH.Server*" -ErrorAction SilentlyContinue | Select-Object -First 1
if ($capability -and $capability.State -ne "Installed") {
    Add-WindowsCapability -Online -Name $capability.Name | Out-Null
}
$service = Get-Service sshd -ErrorAction SilentlyContinue
if (-not $service) { Fail "this runner has no sshd and it could not be installed" }
Start-Service sshd -ErrorAction SilentlyContinue
if ((Get-Service sshd).Status -ne "Running") { Fail "sshd would not start" }

# Stage 2: a key it accepts. The runner account is an administrator, whose keys sshd reads from this file.
$key = Join-Path $env:RUNNER_TEMP "mux_key"
Remove-Item "$key*" -ErrorAction SilentlyContinue
& ssh-keygen -q -t ed25519 -N '' -f $key | Out-Null
& ssh-keygen -y -P '' -f $key | Out-Null
if ($LASTEXITCODE -ne 0) { Fail "could not generate a key without a passphrase" }
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
if (($login | Out-String) -notmatch "logged-in") { Fail "could not log in to the local sshd" }

# Stage 3: start a master and ask it. `-O check` is answered by the master itself, so it is the proof that one runs.
$path = Join-Path $env:RUNNER_TEMP "cm-%C"
$mux = @("-o", "ControlPath=$path")

$start = & ssh @common @mux -o ControlMaster=yes -o ControlPersist=60 -N -f $destination 2>&1
$startCode = $LASTEXITCODE
Raw "start a master (ControlMaster=yes, ControlPersist=60, -N -f)" $start $startCode

$check = & ssh @common @mux -O check $destination 2>&1
$checkCode = $LASTEXITCODE
Raw "ssh -O check" $check $checkCode

& ssh @common @mux -O exit $destination 2>&1 | Out-Null

Note "master start exit $startCode; check exit $checkCode"

if (($startCode -eq 0) -and ($checkCode -eq 0) -and (($check | Out-String) -match "Master running")) {
    Report "ControlMaster WORKS on this runner's OpenSSH. Neore still does not use it on Windows; the plan's S5 note says what to change." 0
}

Report "ControlMaster does NOT work on this runner's OpenSSH. Windows keeps one ssh process per server with no multiplexing, and the window says so." 0
