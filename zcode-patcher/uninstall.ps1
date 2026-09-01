[CmdletBinding()]
param(
    [string]$InstallRoot = (Join-Path $env:USERPROFILE ".zcode-model-discovery-patch"),
    [switch]$SkipScheduledTask
)

$ErrorActionPreference = "Stop"
$taskNames = @("ZCode Model Discovery Patch", "ZCode Model Discovery Patch - Logon")
$resolvedInstallRoot = [System.IO.Path]::GetFullPath($InstallRoot)

if (-not $SkipScheduledTask) {
    foreach ($taskName in $taskNames) {
        if ($null -ne (Get-Command Unregister-ScheduledTask -ErrorAction SilentlyContinue)) {
            Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
        } else {
            & schtasks.exe /Delete /TN $taskName /F 2>$null | Out-Null
        }
    }
}

$nodePath = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $nodePath) {
    $nodePath = "node.exe"
}
$restoreCommand = '& "' + $nodePath + '" "' + (Join-Path $resolvedInstallRoot "apply-patch.mjs") + '" --root "' + $resolvedInstallRoot + '" --restore --json'

foreach ($file in @(
    "apply-patch.mjs",
    "install.ps1",
    "uninstall.ps1",
    "package.json",
    "package-lock.json",
    "patch-manifest.json",
    "run-hidden.vbs",
    "run-patch.ps1"
)) {
    Remove-Item -LiteralPath (Join-Path $resolvedInstallRoot $file) -Force -ErrorAction SilentlyContinue
}

foreach ($directory in @("lib", "payload", "node_modules", "pending")) {
    $candidate = [System.IO.Path]::GetFullPath((Join-Path $resolvedInstallRoot $directory))
    $rootPrefix = $resolvedInstallRoot.TrimEnd('\') + '\'
    if (-not $candidate.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to remove a path outside the patcher root: $candidate"
    }
    Remove-Item -LiteralPath $candidate -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Output "Removed scheduled tasks and patcher runtime files. Preserved state.json, backups, and logs."
Write-Output "To restore before uninstalling the runtime, run: $restoreCommand"
