[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$ComfyRoot,
  [Parameter(Mandatory)][string]$RunnerPath,
  [Parameter(Mandatory)][string]$BackupRoot
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Send-Stage {
  param([Parameter(Mandatory)][string]$Message)
  Write-Output "LTX_WATCH_STAGE:$Message"
}

function Resolve-ExactPath {
  param([Parameter(Mandatory)][string]$Path)
  return (Resolve-Path -LiteralPath $Path -ErrorAction Stop).Path
}

function Assert-ChildPath {
  param(
    [Parameter(Mandatory)][string]$Path,
    [Parameter(Mandatory)][string]$Parent
  )
  $resolvedPath = Resolve-ExactPath $Path
  $resolvedParent = (Resolve-ExactPath $Parent).TrimEnd('\')
  if (-not $resolvedPath.StartsWith("$resolvedParent\", [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'The configured ComfyUI launcher is outside the ComfyUI root.'
  }
  return $resolvedPath
}

function Invoke-Checked {
  param(
    [Parameter(Mandatory)][string]$Executable,
    [Parameter(Mandatory)][string[]]$Arguments,
    [string]$FailureMessage = 'A required command failed.'
  )
  $output = @(& $Executable @Arguments 2>&1)
  if ($LASTEXITCODE -ne 0) {
    $detail = ($output | Select-Object -Last 12) -join [Environment]::NewLine
    throw "$FailureMessage`n$detail"
  }
  return $output
}

$legacyTarget = $null
$legacyBackup = $null
$runnerBackup = $null
$runnerChanged = $false
$legacyMoved = $false

try {
  Send-Stage 'Validating the built-in Manager setup'
  $resolvedComfyRoot = Resolve-ExactPath $ComfyRoot
  $resolvedRunner = Assert-ChildPath -Path $RunnerPath -Parent $resolvedComfyRoot
  $mainPath = Join-Path $resolvedComfyRoot 'main.py'
  $requirementsPath = Join-Path $resolvedComfyRoot 'manager_requirements.txt'
  $cliArgsPath = Join-Path $resolvedComfyRoot 'comfy\cli_args.py'
  if (-not (Test-Path -LiteralPath $mainPath -PathType Leaf)) { throw 'The configured ComfyUI root does not contain main.py.' }
  if (-not (Test-Path -LiteralPath $requirementsPath -PathType Leaf)) { throw 'This ComfyUI revision does not include manager_requirements.txt. Update ComfyUI core first.' }
  if (-not (Test-Path -LiteralPath $cliArgsPath -PathType Leaf) -or -not (Select-String -LiteralPath $cliArgsPath -SimpleMatch '--enable-manager' -Quiet)) {
    throw 'This ComfyUI revision does not support the built-in --enable-manager option.'
  }

  $pythonCandidates = @(
    (Join-Path $resolvedComfyRoot 'venv\Scripts\python.exe'),
    (Join-Path $resolvedComfyRoot '.venv\Scripts\python.exe'),
    (Join-Path $resolvedComfyRoot 'python_embeded\python.exe'),
    (Join-Path $resolvedComfyRoot 'python\python.exe')
  )
  $python = $pythonCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
  if (-not $python) { throw 'The Python environment belonging to ComfyUI was not found.' }

  $runnerText = [System.IO.File]::ReadAllText($resolvedRunner)
  $managerAlreadyEnabled = $runnerText -match '["'']--enable-manager["'']|\s--enable-manager(?:\s|$)'
  $launcherPattern = '(?m)^(?<indent>[ \t]*)args\.server_extra_args\s*=\s*\[\s*\][ \t]*$'
  $launcherRegex = [regex]::new($launcherPattern)
  if (-not $managerAlreadyEnabled -and $launcherRegex.Matches($runnerText).Count -ne 1) {
    throw 'The external ComfyUI launcher is not a recognized safe target. Add --enable-manager to it manually, then run setup again.'
  }

  $legacyTarget = Join-Path $resolvedComfyRoot 'custom_nodes\ComfyUI-Manager'
  if (Test-Path -LiteralPath $legacyTarget) {
    Send-Stage 'Verifying the legacy Manager before migration'
    if (-not (Test-Path -LiteralPath (Join-Path $legacyTarget '.git') -PathType Container)) {
      throw 'An unrecognized ComfyUI-Manager folder exists. It was left unchanged.'
    }
    $safeLegacy = $legacyTarget.Replace('\', '/')
    $origin = (Invoke-Checked -Executable 'git.exe' -Arguments @('-c', "safe.directory=$safeLegacy", '-C', $legacyTarget, 'remote', 'get-url', 'origin') -FailureMessage 'The legacy Manager repository origin could not be verified.' | Select-Object -Last 1).Trim()
    if ($origin -notmatch '^https://github\.com/(Comfy-Org|ltdrdata)/ComfyUI-Manager(?:\.git)?/?$') {
      throw 'The existing ComfyUI-Manager folder does not use an official upstream repository. It was left unchanged.'
    }
    $dirty = (Invoke-Checked -Executable 'git.exe' -Arguments @('-c', "safe.directory=$safeLegacy", '-C', $legacyTarget, 'status', '--porcelain') -FailureMessage 'The legacy Manager working tree could not be verified.') -join ''
    if ($dirty) { throw 'The legacy ComfyUI Manager contains local changes. Commit or back them up before migrating.' }
  }

  Send-Stage 'Checking official Manager dependencies'
  Invoke-Checked -Executable $python -Arguments @('-m', 'pip', 'install', '--dry-run', '-r', $requirementsPath) -FailureMessage 'The Manager dependency preflight failed.' | Out-Null

  Send-Stage 'Installing official Manager dependencies'
  Invoke-Checked -Executable $python -Arguments @('-m', 'pip', 'install', '-r', $requirementsPath) -FailureMessage 'The official Manager dependencies could not be installed.' | Out-Null

  $timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $resolvedBackupRoot = [System.IO.Path]::GetFullPath($BackupRoot)
  New-Item -ItemType Directory -Path $resolvedBackupRoot -Force | Out-Null
  $runnerBackup = Join-Path $resolvedBackupRoot "manager-runner-$timestamp.py"
  Copy-Item -LiteralPath $resolvedRunner -Destination $runnerBackup -Force

  if (-not $managerAlreadyEnabled) {
    Send-Stage 'Enabling Manager in the detected LTX launcher'
    $updatedRunner = $launcherRegex.Replace($runnerText, '${indent}args.server_extra_args = ["--enable-manager"]', 1)
    [System.IO.File]::WriteAllText($resolvedRunner, $updatedRunner, [System.Text.UTF8Encoding]::new($false))
    $runnerChanged = $true
  }

  if (Test-Path -LiteralPath $legacyTarget) {
    Send-Stage 'Archiving the legacy custom-node Manager'
    $legacyBackup = Join-Path $resolvedBackupRoot "ComfyUI-Manager-legacy-$timestamp"
    Move-Item -LiteralPath $legacyTarget -Destination $legacyBackup
    $legacyMoved = $true
  }

  Send-Stage 'Verifying the built-in Manager package'
  $versionOutput = Invoke-Checked -Executable $python -Arguments @('-c', "import importlib.metadata; print(importlib.metadata.version('comfyui-manager'))") -FailureMessage 'The built-in Manager package could not be verified.'
  $managerVersion = ($versionOutput | Select-Object -Last 1).Trim()
  $result = [ordered]@{
    ok = $true
    mode = 'built-in'
    version = $managerVersion
    runnerUpdated = $runnerChanged
    runnerBackup = $runnerBackup
    legacyArchived = $legacyMoved
    legacyBackup = $legacyBackup
    comfyRestartRequired = $true
  }
  Send-Stage 'Manager migration complete'
  Write-Output "LTX_WATCH_MANAGER_RESULT:$($result | ConvertTo-Json -Compress)"
} catch {
  $failure = $_.Exception.Message
  if ($runnerChanged -and $runnerBackup -and (Test-Path -LiteralPath $runnerBackup)) {
    Copy-Item -LiteralPath $runnerBackup -Destination $resolvedRunner -Force -ErrorAction SilentlyContinue
  }
  if ($legacyMoved -and $legacyBackup -and (Test-Path -LiteralPath $legacyBackup) -and -not (Test-Path -LiteralPath $legacyTarget)) {
    Move-Item -LiteralPath $legacyBackup -Destination $legacyTarget -ErrorAction SilentlyContinue
  }
  $result = [ordered]@{ ok = $false; error = $failure }
  Write-Output "LTX_WATCH_MANAGER_RESULT:$($result | ConvertTo-Json -Compress)"
  exit 1
}
