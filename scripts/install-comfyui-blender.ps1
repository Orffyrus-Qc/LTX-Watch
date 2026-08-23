param(
  [Parameter(Mandatory = $true)]
  [string]$ComfyRoot,

  [Parameter(Mandatory = $true)]
  [string]$ComfyUrl
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$script:nodeTarget = $null
$script:nodeBackup = $null
$script:nodeChanged = $false
$script:addonTarget = $null
$script:addonBackup = $null
$script:addonInitiallyExisted = $false
$script:temporaryRoot = $null

function Send-Stage {
  param([Parameter(Mandatory)][string]$Message)
  Write-Output "LTX_WATCH_STAGE:$Message"
}

function Send-Result {
  param([Parameter(Mandatory)][hashtable]$Value)
  Write-Output "LTX_WATCH_RESULT:$($Value | ConvertTo-Json -Depth 6 -Compress)"
}

function Resolve-ChildPath {
  param(
    [Parameter(Mandatory)][string]$Candidate,
    [Parameter(Mandatory)][string]$Parent
  )
  $resolvedCandidate = [System.IO.Path]::GetFullPath($Candidate)
  $resolvedParent = [System.IO.Path]::GetFullPath($Parent).TrimEnd('\')
  if (-not $resolvedCandidate.StartsWith("$resolvedParent\", [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to change a path outside $resolvedParent."
  }
  return $resolvedCandidate
}

function Get-NumericVersion {
  param([AllowNull()][string]$Value)
  if ($Value -match '(\d+\.\d+(?:\.\d+)?)') {
    try { return [version]$Matches[1] } catch { return $null }
  }
  return $null
}

function Find-Blender {
  $paths = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
  foreach ($base in @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:LOCALAPPDATA)) {
    if (-not $base) { continue }
    $foundation = if ($base -eq $env:LOCALAPPDATA) { Join-Path $base 'Programs\Blender Foundation' } else { Join-Path $base 'Blender Foundation' }
    if (-not (Test-Path -LiteralPath $foundation -PathType Container)) { continue }
    Get-ChildItem -LiteralPath $foundation -Directory -ErrorAction SilentlyContinue | ForEach-Object {
      $executable = Join-Path $_.FullName 'blender.exe'
      if (Test-Path -LiteralPath $executable -PathType Leaf) { $null = $paths.Add($executable) }
    }
  }

  foreach ($registryPath in @(
    'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*'
  )) {
    Get-ItemProperty $registryPath -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like 'Blender*' } | ForEach-Object {
      if ($_.InstallLocation) {
        $executable = Join-Path $_.InstallLocation 'blender.exe'
        if (Test-Path -LiteralPath $executable -PathType Leaf) { $null = $paths.Add($executable) }
      }
    }
  }

  $pathCommand = Get-Command blender.exe -ErrorAction SilentlyContinue
  if ($pathCommand -and (Test-Path -LiteralPath $pathCommand.Source -PathType Leaf)) { $null = $paths.Add($pathCommand.Source) }

  $candidates = foreach ($executable in $paths) {
    $fileVersion = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($executable)
    $version = Get-NumericVersion ($fileVersion.ProductVersion)
    if (-not $version) { $version = Get-NumericVersion (Split-Path (Split-Path $executable -Parent) -Leaf) }
    if ($version) { [pscustomobject]@{ Executable = $executable; Version = $version } }
  }
  return $candidates | Sort-Object Version -Descending | Select-Object -First 1
}

function Read-ComfyBlenderVersion {
  param([Parameter(Mandatory)][string]$ProjectRoot)
  $projectFile = Join-Path $ProjectRoot 'pyproject.toml'
  if (-not (Test-Path -LiteralPath $projectFile -PathType Leaf)) { return $null }
  $text = Get-Content -LiteralPath $projectFile -Raw
  if ($text -notmatch '(?m)^name\s*=\s*["'']comfyui-blender["'']\s*$') { return $null }
  if ($text -match '(?m)^version\s*=\s*["'']([^"'']+)["'']\s*$') { return $Matches[1] }
  return $null
}

function Restore-Installation {
  if ($script:nodeChanged -and $script:nodeTarget) {
    $customRoot = Split-Path $script:nodeTarget -Parent
    $safeTarget = Resolve-ChildPath $script:nodeTarget $customRoot
    if (Test-Path -LiteralPath $safeTarget) { Remove-Item -LiteralPath $safeTarget -Recurse -Force }
    if ($script:nodeBackup -and (Test-Path -LiteralPath $script:nodeBackup)) {
      Copy-Item -LiteralPath $script:nodeBackup -Destination $safeTarget -Recurse -Force
    }
  }
  if ($script:addonTarget) {
    $addonParent = Split-Path $script:addonTarget -Parent
    $safeAddon = Resolve-ChildPath $script:addonTarget $addonParent
    if (Test-Path -LiteralPath $safeAddon) { Remove-Item -LiteralPath $safeAddon -Recurse -Force }
    if ($script:addonInitiallyExisted -and $script:addonBackup -and (Test-Path -LiteralPath $script:addonBackup)) {
      Copy-Item -LiteralPath $script:addonBackup -Destination $safeAddon -Recurse -Force
    }
  }
}

try {
  $resolvedComfyRoot = [System.IO.Path]::GetFullPath($ComfyRoot)
  if (-not (Test-Path -LiteralPath (Join-Path $resolvedComfyRoot 'main.py') -PathType Leaf)) {
    throw 'The configured ComfyUI root does not contain main.py.'
  }
  $serverUri = [uri]$ComfyUrl
  if ($serverUri.Scheme -notin @('http', 'https') -or $serverUri.Host -notin @('127.0.0.1', 'localhost', '::1')) {
    throw 'The ComfyUI-Blender server address must use a loopback HTTP URL.'
  }
  if (Get-Process -Name blender -ErrorAction SilentlyContinue) {
    throw 'Close Blender before installing or repairing ComfyUI-Blender.'
  }

  Send-Stage 'Detecting Blender'
  $blender = Find-Blender
  if (-not $blender) { throw 'Blender was not detected. Install Blender 4.5 or Blender 5 before continuing.' }
  if ($blender.Version -lt [version]'4.5') { throw "Blender $($blender.Version) is not supported by the automated integration." }

  Send-Stage 'Resolving the official release'
  $releaseApi = if ($blender.Version.Major -ge 5) {
    'https://api.github.com/repos/alexisrolland/ComfyUI-Blender/releases/latest'
  } else {
    'https://api.github.com/repos/alexisrolland/ComfyUI-Blender/releases/tags/v3.3.4'
  }
  $headers = @{ Accept = 'application/vnd.github+json'; 'User-Agent' = 'LTX-Watch-ComfyUI-Blender-Setup' }
  $release = Invoke-RestMethod -Uri $releaseApi -Headers $headers
  $releaseTag = [string]$release.tag_name
  if ($releaseTag -notmatch '^v\d+\.\d+\.\d+$') { throw 'The official release returned an unexpected version tag.' }
  $releaseVersion = $releaseTag.TrimStart('v')
  $asset = $release.assets | Where-Object { $_.name -match '(?i)^comfyui[_-]blender.*\.zip$' } | Select-Object -First 1
  if (-not $asset) { throw "Release $releaseTag does not contain a Blender add-on archive." }
  $assetUri = [uri]$asset.browser_download_url
  if ($assetUri.Scheme -ne 'https' -or $assetUri.Host -ne 'github.com' -or $assetUri.AbsolutePath -notlike '/alexisrolland/ComfyUI-Blender/*') {
    throw 'The release asset URL is outside the official ComfyUI-Blender repository.'
  }

  $tempBase = Join-Path ([System.IO.Path]::GetTempPath()) 'LTX-Watch'
  New-Item -ItemType Directory -Path $tempBase -Force | Out-Null
  $script:temporaryRoot = Resolve-ChildPath (Join-Path $tempBase ("comfyui-blender-" + [guid]::NewGuid().ToString('N'))) $tempBase
  New-Item -ItemType Directory -Path $script:temporaryRoot -Force | Out-Null
  $addonArchive = Join-Path $script:temporaryRoot $asset.name
  $sourceArchive = Join-Path $script:temporaryRoot 'source.zip'

  Send-Stage "Downloading ComfyUI-Blender $releaseTag"
  Invoke-WebRequest -Uri $assetUri.AbsoluteUri -Headers $headers -OutFile $addonArchive -UseBasicParsing
  $digestVerified = $false
  if ([string]$asset.digest -match '^sha256:([a-fA-F0-9]{64})$') {
    $expectedHash = $Matches[1].ToLowerInvariant()
    $actualHash = (Get-FileHash -LiteralPath $addonArchive -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualHash -ne $expectedHash) { throw 'The downloaded Blender add-on failed its official SHA-256 verification.' }
    $digestVerified = $true
  }

  $sourceUri = "https://github.com/alexisrolland/ComfyUI-Blender/archive/refs/tags/$releaseTag.zip"
  Invoke-WebRequest -Uri $sourceUri -Headers $headers -OutFile $sourceArchive -UseBasicParsing
  $sourceRoot = Join-Path $script:temporaryRoot 'source'
  Expand-Archive -LiteralPath $sourceArchive -DestinationPath $sourceRoot -Force
  $sourceProject = Get-ChildItem -LiteralPath $sourceRoot -Directory | Select-Object -First 1
  if (-not $sourceProject) { throw 'The official source archive did not contain a project folder.' }
  $sourceVersion = Read-ComfyBlenderVersion $sourceProject.FullName
  if ($sourceVersion -ne $releaseVersion) { throw 'The custom-node source version does not match the selected official release.' }

  Send-Stage 'Staging the ComfyUI custom nodes'
  $customRoot = Join-Path $resolvedComfyRoot 'custom_nodes'
  New-Item -ItemType Directory -Path $customRoot -Force | Out-Null
  $script:nodeTarget = Resolve-ChildPath (Join-Path $customRoot 'ComfyUI-Blender') $customRoot
  $installedNodeVersion = if (Test-Path -LiteralPath $script:nodeTarget) { Read-ComfyBlenderVersion $script:nodeTarget } else { $null }
  if ((Test-Path -LiteralPath $script:nodeTarget) -and -not $installedNodeVersion) {
    throw 'An unrecognized custom_nodes\ComfyUI-Blender folder already exists. It was left unchanged.'
  }
  if ($installedNodeVersion -ne $releaseVersion -and $installedNodeVersion -and (Test-Path -LiteralPath (Join-Path $script:nodeTarget '.git'))) {
    $dirty = & git -c "safe.directory=$($script:nodeTarget.Replace('\','/'))" -C $script:nodeTarget status --porcelain 2>$null
    if ($LASTEXITCODE -ne 0 -or $dirty) { throw 'The existing ComfyUI-Blender custom nodes contain local changes or cannot be verified. They were left unchanged.' }
  }

  $backupParent = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { $resolvedComfyRoot }
  $backupBase = Join-Path $backupParent 'LTX Watch\maintenance-backups\comfyui-blender'
  $backupRoot = Join-Path $backupBase (Get-Date -Format 'yyyyMMdd-HHmmss')
  New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
  if ($installedNodeVersion -ne $releaseVersion) {
    if ($installedNodeVersion) {
      $script:nodeBackup = Join-Path $backupRoot 'custom-nodes'
      Copy-Item -LiteralPath $script:nodeTarget -Destination $script:nodeBackup -Recurse -Force
      Remove-Item -LiteralPath $script:nodeTarget -Recurse -Force
    }
    Copy-Item -LiteralPath $sourceProject.FullName -Destination $script:nodeTarget -Recurse -Force
    $script:nodeChanged = $true
  }

  Send-Stage 'Backing up the Blender add-on'
  $profileVersion = "$($blender.Version.Major).$($blender.Version.Minor)"
  $addonParent = Join-Path $env:APPDATA "Blender Foundation\Blender\$profileVersion\scripts\addons"
  New-Item -ItemType Directory -Path $addonParent -Force | Out-Null
  $script:addonTarget = Resolve-ChildPath (Join-Path $addonParent 'comfyui_blender') $addonParent
  $script:addonInitiallyExisted = Test-Path -LiteralPath $script:addonTarget
  if ($script:addonInitiallyExisted) {
    $script:addonBackup = Join-Path $backupRoot 'blender-addon'
    Copy-Item -LiteralPath $script:addonTarget -Destination $script:addonBackup -Recurse -Force
  }

  Send-Stage 'Enabling and configuring the Blender add-on'
  $env:LTX_WATCH_BLENDER_ARCHIVE = $addonArchive
  $env:LTX_WATCH_BLENDER_SERVER = $ComfyUrl
  $pythonExpression = "import bpy,json,os; archive=os.environ['LTX_WATCH_BLENDER_ARCHIVE']; server=os.environ['LTX_WATCH_BLENDER_SERVER']; bpy.ops.preferences.addon_install(filepath=archive); bpy.ops.preferences.addon_enable(module='comfyui_blender'); addon=bpy.context.preferences.addons.get('comfyui_blender'); assert addon is not None, 'Add-on was not enabled'; addon.preferences.server_address=server; bpy.ops.wm.save_userpref(); print('LTX_WATCH_BLENDER:'+json.dumps({'enabled':True,'serverAddress':addon.preferences.server_address}))"
  try {
    $blenderOutput = @(& $blender.Executable --background --python-expr $pythonExpression 2>&1)
    $blenderExitCode = $LASTEXITCODE
  } finally {
    Remove-Item Env:\LTX_WATCH_BLENDER_ARCHIVE -ErrorAction SilentlyContinue
    Remove-Item Env:\LTX_WATCH_BLENDER_SERVER -ErrorAction SilentlyContinue
  }
  if ($blenderExitCode -ne 0 -or -not ($blenderOutput | Where-Object { "$_" -like 'LTX_WATCH_BLENDER:*' })) {
    throw (($blenderOutput | Select-Object -Last 12) -join "`n")
  }

  Send-Stage 'Verifying the completed integration'
  $configuredNodeVersion = Read-ComfyBlenderVersion $script:nodeTarget
  if ($configuredNodeVersion -ne $releaseVersion -or -not (Test-Path -LiteralPath (Join-Path $script:addonTarget '__init__.py'))) {
    throw 'ComfyUI-Blender verification did not find both installed components.'
  }

  Send-Result @{
    ok = $true
    version = $releaseVersion
    releaseTag = $releaseTag
    releaseUrl = [string]$release.html_url
    blenderVersion = $blender.Version.ToString()
    serverAddress = $ComfyUrl
    customNodesChanged = $script:nodeChanged
    comfyRestartRequired = $script:nodeChanged
    digestVerified = $digestVerified
    backupPath = if ($script:nodeBackup -or $script:addonBackup) { $backupRoot } else { $null }
  }
} catch {
  $failure = $_.Exception.Message
  try { Restore-Installation } catch { $failure = "$failure Rollback warning: $($_.Exception.Message)" }
  Send-Result @{ ok = $false; error = $failure }
  exit 1
} finally {
  if ($script:temporaryRoot -and (Test-Path -LiteralPath $script:temporaryRoot)) {
    $tempBase = Join-Path ([System.IO.Path]::GetTempPath()) 'LTX-Watch'
    try {
      $safeTemporaryRoot = Resolve-ChildPath $script:temporaryRoot $tempBase
      Remove-Item -LiteralPath $safeTemporaryRoot -Recurse -Force
    } catch { /* Temporary cleanup must not hide the installation result. */ }
  }
}
