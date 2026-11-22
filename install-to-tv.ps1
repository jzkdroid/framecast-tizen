<#
.SYNOPSIS
    Packages FrameCast as a signed .wgt and installs it on a Samsung TV in Developer Mode.

.EXAMPLE
    .\install-to-tv.ps1 -TvIp 192.168.1.50 -CertProfile FrameCast

.NOTES
    One-time setup (Tizen Studio, TV Developer Mode, Samsung certificate) is in README.md.
#>
param(
    [Parameter(Mandatory = $true)] [string] $TvIp,
    [string] $CertProfile = 'FrameCast',
    [string] $TizenStudio = ''
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$appDir = Join-Path $root 'app'
$buildDir = Join-Path $root 'build'

# --- Find the Tizen CLI ---------------------------------------------------
$candidates = @($TizenStudio, 'C:\tizen-studio', "$env:USERPROFILE\tizen-studio") | Where-Object { $_ }
$tizenHome = $candidates | Where-Object { Test-Path (Join-Path $_ 'tools\ide\bin\tizen.bat') } | Select-Object -First 1
if (-not $tizenHome) {
    throw "Tizen Studio not found. Install it (see README.md) or pass -TizenStudio 'path\to\tizen-studio'."
}
$tizen = Join-Path $tizenHome 'tools\ide\bin\tizen.bat'
$sdb = Join-Path $tizenHome 'tools\sdb.exe'
Write-Host "Using Tizen Studio at $tizenHome"

# --- Copy only the app files into a clean build folder ---------------------
if (Test-Path $buildDir) { Remove-Item -Recurse -Force $buildDir }
New-Item -ItemType Directory -Path $buildDir | Out-Null
Copy-Item -Recurse -Path (Join-Path $appDir '*') -Destination $buildDir

# --- Package and sign ------------------------------------------------------
Write-Host "Packaging with certificate profile '$CertProfile'..."
& $tizen package -t wgt -s $CertProfile -- $buildDir
if ($LASTEXITCODE -ne 0) { throw "Packaging failed. Check that the certificate profile '$CertProfile' exists in Certificate Manager." }
$wgt = Get-ChildItem -Path $buildDir -Filter '*.wgt' | Select-Object -First 1
if (-not $wgt) { throw 'No .wgt file was produced.' }
Write-Host "Built $($wgt.FullName)"

# --- Connect to the TV and install ----------------------------------------
Write-Host "Connecting to TV at $TvIp..."
& $sdb connect $TvIp
$serial = "${TvIp}:26101"
$devices = & $sdb devices
if (-not ($devices -match [regex]::Escape($TvIp))) {
    throw "The TV at $TvIp did not connect. Make sure Developer Mode is on with this PC's IP as the host, and that the TV was restarted after turning it on."
}

Write-Host 'Installing on the TV...'
& $tizen install -n $wgt.Name -s $serial -- $buildDir
if ($LASTEXITCODE -ne 0) {
    throw 'Install failed. A common cause is a distributor certificate that does not include this TV''s DUID (see README.md).'
}

Write-Host ''
Write-Host 'Done. FrameCast is in Apps on your TV (scroll to the end of the list).' -ForegroundColor Green
