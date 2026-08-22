param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('suspend', 'resume')]
  [string]$Mode,

  [Parameter(Mandatory = $true)]
  [string]$RootPidCsv,

  [string]$ExpectedCommandFragment = ''
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class NativeProcessControl
{
    [DllImport("ntdll.dll", SetLastError = true)]
    public static extern int NtSuspendProcess(IntPtr processHandle);

    [DllImport("ntdll.dll", SetLastError = true)]
    public static extern int NtResumeProcess(IntPtr processHandle);
}
'@

$rootPids = @($RootPidCsv.Split(',') | ForEach-Object { [int]$_.Trim() } | Where-Object { $_ -gt 0 })
if ($rootPids.Count -eq 0) {
  throw 'No valid root process IDs were supplied.'
}

$all = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, CommandLine)
$depth = @{}
$targets = [System.Collections.Generic.HashSet[int]]::new()
$queue = [System.Collections.Generic.Queue[object]]::new()

foreach ($rootPid in $rootPids) {
  $root = $all | Where-Object { $_.ProcessId -eq $rootPid } | Select-Object -First 1
  if (-not $root) {
    throw "Worker process $rootPid no longer exists."
  }
  if ($ExpectedCommandFragment -and $root.CommandLine -notlike "*$ExpectedCommandFragment*") {
    throw "Process $rootPid does not match the configured LTX worker."
  }
  $queue.Enqueue([pscustomobject]@{ Pid = [int]$rootPid; Depth = 0 })
}

while ($queue.Count -gt 0) {
  $item = $queue.Dequeue()
  if ($targets.Contains($item.Pid)) { continue }
  $null = $targets.Add($item.Pid)
  $depth[$item.Pid] = $item.Depth
  $children = $all | Where-Object { $_.ParentProcessId -eq $item.Pid -and $_.Name -ne 'conhost.exe' }
  foreach ($child in $children) {
    $queue.Enqueue([pscustomobject]@{ Pid = [int]$child.ProcessId; Depth = $item.Depth + 1 })
  }
}

$ordered = @($targets | ForEach-Object {
  [pscustomobject]@{ Pid = [int]$_; Depth = [int]$depth[$_] }
})

if ($Mode -eq 'suspend') {
  $ordered = @($ordered | Sort-Object Depth, Pid)
} else {
  $ordered = @($ordered | Sort-Object @{ Expression = 'Depth'; Descending = $true }, Pid)
}

$results = @()
foreach ($item in $ordered) {
  try {
    $process = Get-Process -Id $item.Pid -ErrorAction Stop
    $code = if ($Mode -eq 'suspend') {
      [NativeProcessControl]::NtSuspendProcess($process.Handle)
    } else {
      [NativeProcessControl]::NtResumeProcess($process.Handle)
    }
    if ($code -ne 0) { throw "Native process control returned $code" }
    $results += [pscustomobject]@{ pid = $item.Pid; depth = $item.Depth; ok = $true }
  } catch {
    $results += [pscustomobject]@{ pid = $item.Pid; depth = $item.Depth; ok = $false; error = $_.Exception.Message }
  }
}

$rootFailures = @($results | Where-Object { $_.pid -in $rootPids -and -not $_.ok })
[pscustomobject]@{
  ok = $rootFailures.Count -eq 0
  mode = $Mode
  roots = $rootPids
  affected = @($results | Where-Object { $_.ok } | ForEach-Object { $_.pid })
  results = $results
} | ConvertTo-Json -Depth 5 -Compress

if ($rootFailures.Count -gt 0) { exit 2 }
