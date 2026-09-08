param(
    [string]$GsRoot,
    [string]$GsBin,
    [string]$ShareDir,
    [Parameter(Mandatory=$true)]
    [string]$OutputRoot
)

$ErrorActionPreference = 'Stop'

function Get-VersionTuple([string]$Name) {
    if ($Name -match '^gs(\d+(?:\.\d+)*)$') {
        return ($Matches[1] -split '\.' | ForEach-Object { [int]$_ })
    }
    return $null
}

function Get-InstallRoots {
    $roots = @()
    foreach ($base in @($env:ProgramFiles, ${env:ProgramFiles(x86)})) {
        if (-not $base) { continue }
        $parent = Join-Path $base 'gs'
        if (-not (Test-Path $parent)) { continue }
        Get-ChildItem -Path $parent -Directory | ForEach-Object {
            $ver = Get-VersionTuple $_.Name
            if ($ver) {
                $roots += [pscustomobject]@{ Version = ($ver -join '.'); VersionParts = $ver; Path = $_.FullName }
            }
        }
    }
    $roots |
        Sort-Object -Property @{Expression={($_.VersionParts | ForEach-Object { '{0:D6}' -f $_ }) -join '.'}} -Descending |
        Select-Object -ExpandProperty Path
}

function Copy-IfExists([string]$Src, [string]$Dst) {
    if (-not (Test-Path $Src)) { return $false }
    $item = Get-Item $Src
    if ($item.PSIsContainer) {
        Copy-Item -Path $Src -Destination $Dst -Recurse -Force
    } else {
        $parent = Split-Path -Parent $Dst
        if ($parent) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
        Copy-Item -Path $Src -Destination $Dst -Force
    }
    return $true
}

$rootCandidates = @()
if ($GsRoot) { $rootCandidates += $GsRoot }
$rootCandidates += Get-InstallRoots

$binCandidates = @()
if ($GsBin) { $binCandidates += $GsBin }
foreach ($root in $rootCandidates) {
    $binCandidates += (Join-Path $root 'bin\\gswin64c.exe')
    $binCandidates += (Join-Path $root 'bin\\gswin32c.exe')
}
foreach ($name in @('gswin64c.exe','gswin32c.exe','gswin64c','gswin32c')) {
    $cmd = Get-Command $name -ErrorAction SilentlyContinue
    if ($cmd) { $binCandidates += $cmd.Source }
}

$selectedBin = $null
foreach ($candidate in $binCandidates) {
    if ($candidate -and (Test-Path $candidate)) {
        $selectedBin = (Resolve-Path $candidate).Path
        break
    }
}
if (-not $selectedBin) {
    throw "Ghostscript executable not found. Tried: $($binCandidates -join ', ')"
}

if ($GsRoot) {
    $resolvedRoot = (Resolve-Path $GsRoot).Path
} else {
    $resolvedRoot = Split-Path -Parent (Split-Path -Parent $selectedBin)
}
if (-not (Test-Path $resolvedRoot)) {
    throw "Ghostscript root not found: $resolvedRoot"
}

$resolvedOutput = [System.IO.Path]::GetFullPath($OutputRoot)
if (Test-Path $resolvedOutput) {
    Remove-Item -Path $resolvedOutput -Recurse -Force
}
New-Item -ItemType Directory -Path $resolvedOutput -Force | Out-Null

$srcBinDir = Join-Path $resolvedRoot 'bin'
if (-not (Test-Path $srcBinDir)) {
    throw "Ghostscript bin directory not found: $srcBinDir"
}
Copy-Item -Path $srcBinDir -Destination (Join-Path $resolvedOutput 'bin') -Recurse -Force

$shareRoot = Join-Path $resolvedOutput 'share\\ghostscript'
$copiedAny = $false
if ($ShareDir) {
    if (-not (Test-Path $ShareDir)) {
        throw "Provided -ShareDir does not exist: $ShareDir"
    }
    $name = (Get-Item $ShareDir).Name
    if ($name -ieq 'ghostscript') {
        Copy-Item -Path $ShareDir -Destination $shareRoot -Recurse -Force
    } else {
        Copy-Item -Path $ShareDir -Destination (Join-Path $shareRoot $name) -Recurse -Force
    }
    $copiedAny = $true
} else {
    $copiedAny = (Copy-IfExists (Join-Path $resolvedRoot 'lib') (Join-Path $shareRoot 'lib')) -or $copiedAny
    $copiedAny = (Copy-IfExists (Join-Path $resolvedRoot 'Resource') (Join-Path $shareRoot 'Resource')) -or $copiedAny
    $copiedAny = (Copy-IfExists (Join-Path $resolvedRoot 'fonts') (Join-Path $shareRoot 'fonts')) -or $copiedAny
    $copiedAny = (Copy-IfExists (Join-Path $resolvedRoot 'iccprofiles') (Join-Path $shareRoot 'iccprofiles')) -or $copiedAny
    if (-not $copiedAny) {
        $copiedAny = (Copy-IfExists (Join-Path $resolvedRoot 'share\\ghostscript') $shareRoot) -or $copiedAny
    }
}

if (-not $copiedAny) {
    throw 'Could not stage Ghostscript resources. Expected lib/Resource under installation root.'
}

if (-not (Test-Path (Join-Path $resolvedOutput 'bin\\gswin64c.exe')) -and -not (Test-Path (Join-Path $resolvedOutput 'bin\\gswin32c.exe'))) {
    throw 'Prepared runtime is missing gswin64c.exe and gswin32c.exe in output/bin.'
}

Write-Host "Prepared Windows Ghostscript runtime at: $resolvedOutput"
Write-Host "Source Ghostscript root: $resolvedRoot"
