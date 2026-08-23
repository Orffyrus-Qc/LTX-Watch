[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$ComfyRoot,
  [Parameter(Mandatory)][string]$BackupRoot,
  [Parameter(Mandatory)][ValidatePattern('^https://huggingface\.co/Comfy-Org/sam3\.1/resolve/main/checkpoints/sam3\.1_multiplex_fp16\.safetensors$')][string]$ModelUrl,
  [Parameter(Mandatory)][ValidatePattern('^[a-fA-F0-9]{64}$')][string]$ExpectedSha256,
  [Parameter(Mandatory)][long]$ExpectedSize
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

$temporaryPath = $null
$backupPath = $null
$destination = $null

try {
  Send-Stage 'Validating native SAM 3.1 support'
  $resolvedComfyRoot = Resolve-ExactPath $ComfyRoot
  if (-not (Test-Path -LiteralPath (Join-Path $resolvedComfyRoot 'main.py') -PathType Leaf)) { throw 'The configured ComfyUI root does not contain main.py.' }
  if (-not (Test-Path -LiteralPath (Join-Path $resolvedComfyRoot 'comfy_extras\nodes_sam3.py') -PathType Leaf)) { throw 'Native SAM 3.1 nodes are missing. Update ComfyUI core first.' }
  if ($ExpectedSize -lt 1GB) { throw 'The pinned SAM 3.1 model size is invalid.' }

  $destinationDirectory = Join-Path $resolvedComfyRoot 'models\checkpoints'
  New-Item -ItemType Directory -Path $destinationDirectory -Force | Out-Null
  $destination = Join-Path $destinationDirectory 'sam3.1_multiplex_fp16.safetensors'

  if (Test-Path -LiteralPath $destination -PathType Leaf) {
    Send-Stage 'Verifying the existing SAM 3.1 checkpoint'
    $existing = Get-Item -LiteralPath $destination
    if ($existing.Length -eq $ExpectedSize) {
      $existingHash = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant()
      if ($existingHash -eq $ExpectedSha256.ToLowerInvariant()) {
        $result = [ordered]@{ ok = $true; installed = $false; verified = $true; filename = $existing.Name; size = $existing.Length; sha256 = $existingHash; backup = $null; comfyRestartRequired = $true }
        Send-Stage 'SAM 3.1 checkpoint is already verified'
        Write-Output "LTX_WATCH_SAM3_RESULT:$($result | ConvertTo-Json -Compress)"
        exit 0
      }
    }
  }

  $driveRoot = [System.IO.Path]::GetPathRoot($destinationDirectory)
  $drive = Get-PSDrive -Name $driveRoot.TrimEnd(':\')
  if ($drive.Free -lt ($ExpectedSize + 1GB)) { throw 'At least 2.7 GB of free space is required for the verified download and temporary file.' }

  $timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $resolvedBackupRoot = [System.IO.Path]::GetFullPath($BackupRoot)
  New-Item -ItemType Directory -Path $resolvedBackupRoot -Force | Out-Null
  if (Test-Path -LiteralPath $destination -PathType Leaf) {
    Send-Stage 'Backing up the unverified existing checkpoint'
    $backupPath = Join-Path $resolvedBackupRoot "sam3.1-checkpoint-$timestamp.safetensors"
    Move-Item -LiteralPath $destination -Destination $backupPath
  }

  $temporaryPath = Join-Path $destinationDirectory ".sam3.1-download-$([guid]::NewGuid().ToString('N')).part"
  Send-Stage 'Downloading the official 1.63 GiB SAM 3.1 checkpoint'
  Invoke-WebRequest -Uri $ModelUrl -OutFile $temporaryPath -UseBasicParsing -Headers @{ 'User-Agent' = 'LTX-Watch-SAM3-Setup' }

  Send-Stage 'Verifying model size and SHA-256 digest'
  $download = Get-Item -LiteralPath $temporaryPath
  if ($download.Length -ne $ExpectedSize) { throw "The SAM 3.1 download size did not match the pinned official file. Expected $ExpectedSize bytes and received $($download.Length)." }
  $downloadHash = (Get-FileHash -LiteralPath $temporaryPath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($downloadHash -ne $ExpectedSha256.ToLowerInvariant()) { throw 'The SAM 3.1 SHA-256 digest did not match the pinned official checkpoint.' }

  Move-Item -LiteralPath $temporaryPath -Destination $destination
  $temporaryPath = $null
  $result = [ordered]@{ ok = $true; installed = $true; verified = $true; filename = 'sam3.1_multiplex_fp16.safetensors'; size = $ExpectedSize; sha256 = $downloadHash; backup = $backupPath; comfyRestartRequired = $true }
  Send-Stage 'SAM 3.1 model installation complete'
  Write-Output "LTX_WATCH_SAM3_RESULT:$($result | ConvertTo-Json -Compress)"
} catch {
  $failure = $_.Exception.Message
  if ($temporaryPath -and (Test-Path -LiteralPath $temporaryPath -PathType Leaf)) {
    Remove-Item -LiteralPath $temporaryPath -Force -ErrorAction SilentlyContinue
  }
  if ($backupPath -and $destination -and (Test-Path -LiteralPath $backupPath -PathType Leaf) -and -not (Test-Path -LiteralPath $destination)) {
    Move-Item -LiteralPath $backupPath -Destination $destination -ErrorAction SilentlyContinue
  }
  $result = [ordered]@{ ok = $false; error = $failure }
  Write-Output "LTX_WATCH_SAM3_RESULT:$($result | ConvertTo-Json -Compress)"
  exit 1
}
