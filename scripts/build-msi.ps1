[CmdletBinding()]
param(
  [string]$Configuration = 'Release'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$installerRoot = Join-Path $projectRoot 'installer'
$buildRoot = Join-Path $installerRoot '.build'
$stageRoot = Join-Path $buildRoot 'stage'
$toolRoot = Join-Path $installerRoot '.tools'
$releaseRoot = Join-Path $projectRoot 'release'
$wixSource = Join-Path $buildRoot 'Product.wxs'
$package = Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw | ConvertFrom-Json
$version = [string]$package.version
$msiPath = Join-Path $releaseRoot "LTX-Watch-$version-x64.msi"

function Reset-BuildDirectory {
  param([Parameter(Mandatory)][string]$Path)

  $resolvedPath = [System.IO.Path]::GetFullPath($Path)
  $resolvedInstallerRoot = [System.IO.Path]::GetFullPath($installerRoot)
  if (!$resolvedPath.StartsWith("$resolvedInstallerRoot$([System.IO.Path]::DirectorySeparatorChar)", [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to reset a directory outside $resolvedInstallerRoot"
  }

  if (Test-Path -LiteralPath $resolvedPath) {
    Remove-Item -LiteralPath $resolvedPath -Recurse -Force
  }
  New-Item -ItemType Directory -Path $resolvedPath -Force | Out-Null
}

function Copy-InstallerFile {
  param(
    [Parameter(Mandatory)][string]$Source,
    [Parameter(Mandatory)][string]$Destination
  )

  $destinationDirectory = Split-Path -Parent $Destination
  New-Item -ItemType Directory -Path $destinationDirectory -Force | Out-Null
  Copy-Item -LiteralPath $Source -Destination $Destination -Force
}

function Get-StableId {
  param(
    [Parameter(Mandatory)][string]$Prefix,
    [Parameter(Mandatory)][string]$Value
  )

  $bytes = [System.Text.Encoding]::UTF8.GetBytes($Value.ToLowerInvariant())
  $algorithm = [System.Security.Cryptography.SHA256]::Create()
  try {
    $hash = $algorithm.ComputeHash($bytes)
  } finally {
    $algorithm.Dispose()
  }
  $hex = -join ($hash | ForEach-Object { $_.ToString('X2') })
  return "$Prefix$($hex.Substring(0, 20))"
}

function Escape-Xml {
  param([Parameter(Mandatory)][string]$Value)
  return [System.Security.SecurityElement]::Escape($Value)
}

$npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (!$npmCommand) { throw 'npm.cmd is required to create the production build.' }

Write-Host 'Building the production application...'
Push-Location $projectRoot
try {
  & $npmCommand.Source run build
  if ($LASTEXITCODE -ne 0) { throw "npm run build failed with exit code $LASTEXITCODE" }
} finally {
  Pop-Location
}

Reset-BuildDirectory -Path $buildRoot
New-Item -ItemType Directory -Path $stageRoot, $toolRoot, $releaseRoot -Force | Out-Null

Copy-InstallerFile (Join-Path $projectRoot 'local-server.mjs') (Join-Path $stageRoot 'local-server.mjs')
Copy-InstallerFile (Join-Path $projectRoot 'lib\environment-audit.mjs') (Join-Path $stageRoot 'lib\environment-audit.mjs')
Copy-InstallerFile (Join-Path $projectRoot 'lib\comfyui-blender-setup.mjs') (Join-Path $stageRoot 'lib\comfyui-blender-setup.mjs')
Copy-InstallerFile (Join-Path $projectRoot 'lib\comfyui-manager-setup.mjs') (Join-Path $stageRoot 'lib\comfyui-manager-setup.mjs')
Copy-InstallerFile (Join-Path $projectRoot 'local.config.example.json') (Join-Path $stageRoot 'local.config.example.json')
Copy-InstallerFile (Join-Path $projectRoot 'README.md') (Join-Path $stageRoot 'README.md')
Copy-InstallerFile (Join-Path $installerRoot 'LTX Watch.cmd') (Join-Path $stageRoot 'LTX Watch.cmd')
Copy-InstallerFile (Join-Path $projectRoot 'scripts\process-orchestrator.ps1') (Join-Path $stageRoot 'scripts\process-orchestrator.ps1')
Copy-InstallerFile (Join-Path $projectRoot 'scripts\install-comfyui-blender.ps1') (Join-Path $stageRoot 'scripts\install-comfyui-blender.ps1')
Copy-InstallerFile (Join-Path $projectRoot 'scripts\install-comfyui-manager.ps1') (Join-Path $stageRoot 'scripts\install-comfyui-manager.ps1')
Copy-InstallerFile (Join-Path $projectRoot 'scripts\run-installed.mjs') (Join-Path $stageRoot 'scripts\run-installed.mjs')
Copy-InstallerFile (Join-Path $projectRoot 'scripts\serve-production.mjs') (Join-Path $stageRoot 'scripts\serve-production.mjs')
Copy-Item -LiteralPath (Join-Path $projectRoot 'dist') -Destination (Join-Path $stageRoot 'dist') -Recurse -Force

$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
if (!$nodeCommand) { throw 'node.exe is required so its runtime can be bundled into the MSI.' }
$nodeVersion = (& $nodeCommand.Source --version).TrimStart('v')
Copy-InstallerFile $nodeCommand.Source (Join-Path $stageRoot 'runtime\node.exe')

$nodeLicense = Join-Path $stageRoot 'runtime\LICENSE-node.txt'
$nodeLicenseUrl = "https://raw.githubusercontent.com/nodejs/node/v$nodeVersion/LICENSE"
Write-Host "Downloading the Node.js $nodeVersion license..."
Invoke-WebRequest -Uri $nodeLicenseUrl -OutFile $nodeLicense -UseBasicParsing

$thirdPartyNotice = @"
LTX Watch includes the Node.js $nodeVersion runtime.

Node.js is distributed under the terms recorded in runtime\LICENSE-node.txt.
Project: https://nodejs.org/
Source: https://github.com/nodejs/node/tree/v$nodeVersion
"@
Set-Content -LiteralPath (Join-Path $stageRoot 'THIRD_PARTY_NOTICES.txt') -Value $thirdPartyNotice -Encoding utf8

$componentIds = [System.Collections.Generic.List[string]]::new()

function Get-DirectoryXml {
  param(
    [Parameter(Mandatory)][string]$Path,
    [Parameter(Mandatory)][AllowEmptyString()][string]$RelativePath,
    [int]$Indent = 0
  )

  $lines = [System.Collections.Generic.List[string]]::new()
  $padding = ' ' * $Indent

  foreach ($file in Get-ChildItem -LiteralPath $Path -File | Sort-Object Name) {
    $relativeFile = if ($RelativePath) { "$RelativePath/$($file.Name)" } else { $file.Name }
    $componentId = Get-StableId -Prefix 'Cmp' -Value $relativeFile
    $fileId = Get-StableId -Prefix 'Fil' -Value $relativeFile
    $componentIds.Add($componentId)
    $source = Escape-Xml $file.FullName
    $lines.Add("$padding<Component Id=`"$componentId`" Guid=`"*`">")
    $lines.Add("$padding  <File Id=`"$fileId`" Source=`"$source`" KeyPath=`"yes`" />")
    $lines.Add("$padding</Component>")
  }

  foreach ($directory in Get-ChildItem -LiteralPath $Path -Directory | Sort-Object Name) {
    $relativeDirectory = if ($RelativePath) { "$RelativePath/$($directory.Name)" } else { $directory.Name }
    $directoryId = Get-StableId -Prefix 'Dir' -Value $relativeDirectory
    $directoryName = Escape-Xml $directory.Name
    $lines.Add("$padding<Directory Id=`"$directoryId`" Name=`"$directoryName`">")
    foreach ($line in Get-DirectoryXml -Path $directory.FullName -RelativePath $relativeDirectory -Indent ($Indent + 2)) {
      $lines.Add($line)
    }
    $lines.Add("$padding</Directory>")
  }

  return $lines
}

$directoryXml = (Get-DirectoryXml -Path $stageRoot -RelativePath '' -Indent 10) -join "`r`n"
$componentRefs = ($componentIds | ForEach-Object { "      <ComponentRef Id=`"$_`" />" }) -join "`r`n"

$wixXml = @"
<Wix xmlns="http://wixtoolset.org/schemas/v4/wxs">
  <Package
    Name="LTX Watch"
    Manufacturer="Orffyrus-Qc"
    Version="$version"
    UpgradeCode="B57A0F45-6CE8-4B41-AE10-3A86A8D3D0C6"
    Scope="perUser"
    InstallerVersion="500">
    <MajorUpgrade DowngradeErrorMessage="A newer version of LTX Watch is already installed." />
    <MediaTemplate EmbedCab="yes" CompressionLevel="high" />

    <Feature Id="MainFeature" Title="LTX Watch" Level="1">
$componentRefs
      <ComponentRef Id="ShortcutComponent" />
    </Feature>
  </Package>

  <Fragment>
    <StandardDirectory Id="LocalAppDataFolder">
      <Directory Id="LocalProgramsFolder" Name="Programs">
        <Directory Id="INSTALLFOLDER" Name="LTX Watch">
$directoryXml
          <Component Id="ShortcutComponent" Guid="06CE6A4E-A9B8-4ED2-8661-E4A6CE94B55B">
            <Shortcut Id="DesktopShortcut" Directory="DesktopFolder" Name="LTX Watch" Description="Local LTX Video generation monitor" Target="[INSTALLFOLDER]LTX Watch.cmd" WorkingDirectory="INSTALLFOLDER" />
            <Shortcut Id="StartMenuShortcut" Directory="ApplicationProgramsFolder" Name="LTX Watch" Description="Local LTX Video generation monitor" Target="[INSTALLFOLDER]LTX Watch.cmd" WorkingDirectory="INSTALLFOLDER" />
            <RemoveFolder Id="RemoveApplicationProgramsFolder" Directory="ApplicationProgramsFolder" On="uninstall" />
            <RegistryValue Root="HKCU" Key="Software\Orffyrus-Qc\LTX Watch" Name="Installed" Type="integer" Value="1" KeyPath="yes" />
          </Component>
        </Directory>
      </Directory>
    </StandardDirectory>
  </Fragment>

  <Fragment>
    <StandardDirectory Id="DesktopFolder" />
    <StandardDirectory Id="ProgramMenuFolder">
      <Directory Id="ApplicationProgramsFolder" Name="LTX Watch" />
    </StandardDirectory>
  </Fragment>
</Wix>
"@

Set-Content -LiteralPath $wixSource -Value $wixXml -Encoding utf8

$wixExe = Join-Path $toolRoot 'wix.exe'
if (!(Test-Path -LiteralPath $wixExe)) {
  Write-Host 'Installing the pinned WiX Toolset 6 CLI locally...'
  & dotnet tool install --tool-path $toolRoot wix --version 6.0.2
  if ($LASTEXITCODE -ne 0) { throw "WiX Toolset installation failed with exit code $LASTEXITCODE" }
}

Write-Host "Building $msiPath..."
& $wixExe build $wixSource -arch x64 -out $msiPath
if ($LASTEXITCODE -ne 0) { throw "WiX build failed with exit code $LASTEXITCODE" }

$artifact = Get-Item -LiteralPath $msiPath
$hashAlgorithm = [System.Security.Cryptography.SHA256]::Create()
$stream = [System.IO.File]::OpenRead($msiPath)
try {
  $hashBytes = $hashAlgorithm.ComputeHash($stream)
} finally {
  $stream.Dispose()
  $hashAlgorithm.Dispose()
}
$hash = -join ($hashBytes | ForEach-Object { $_.ToString('X2') })
Write-Host ''
Write-Host "MSI: $($artifact.FullName)"
Write-Host "Size: $([Math]::Round($artifact.Length / 1MB, 2)) MB"
Write-Host "SHA256: $hash"
