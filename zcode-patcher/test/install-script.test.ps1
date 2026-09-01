$ErrorActionPreference = "Stop"

function Assert-True {
    param(
        [Parameter(Mandatory = $true)][bool]$Condition,
        [Parameter(Mandatory = $true)][string]$Message
    )
    if (-not $Condition) {
        throw $Message
    }
}

$patcherRoot = Split-Path -Parent $PSScriptRoot
$installScript = Join-Path $patcherRoot "install.ps1"
$uninstallScript = Join-Path $patcherRoot "uninstall.ps1"
$testTaskName = "ZCode Installer Test " + [guid]::NewGuid().ToString("N")
$temporaryRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("zcode-installer-test-" + [guid]::NewGuid().ToString("N"))
$previousLocalAppData = $env:LOCALAPPDATA
$previousUserProfile = $env:USERPROFILE

try {
    $testLocalAppData = Join-Path $temporaryRoot "LocalAppData"
    $testUserProfile = Join-Path $temporaryRoot "UserProfile"
    $fixtureAsar = Join-Path $temporaryRoot "ZCode\resources\app.asar"
    New-Item -ItemType Directory -Path (Split-Path -Parent $fixtureAsar) -Force | Out-Null
    Set-Content -LiteralPath $fixtureAsar -Value "fixture" -NoNewline
    $env:LOCALAPPDATA = $testLocalAppData
    $env:USERPROFILE = $testUserProfile

    & $installScript -SkipScheduledTask -SkipInitialPatch -ZCodeAsar $fixtureAsar

    $installedRoot = Join-Path $testUserProfile ".zcode-model-discovery-patch"
    foreach ($relativePath in @(
        "apply-patch.mjs",
        "patch-manifest.json",
        "payload\model-discovery.js",
        "lib\state.mjs",
        "lib\transform.mjs",
        "node_modules\@electron\asar\package.json",
        "run-hidden.vbs",
        "run-patch.ps1"
    )) {
        Assert-True (Test-Path -LiteralPath (Join-Path $installedRoot $relativePath)) "Missing installed runtime file: $relativePath"
    }

    Assert-True (Test-Path -LiteralPath (Join-Path $installedRoot "node.exe")) "Installer did not install the bundled Node runtime"

    $launcher = Get-Content -Raw -LiteralPath (Join-Path $installedRoot "run-hidden.vbs")
    $runner = Get-Content -Raw -LiteralPath (Join-Path $installedRoot "run-patch.ps1")
    $nodePath = (Get-Command node.exe -ErrorAction Stop).Source
    Assert-True ($launcher.Contains((Join-Path $installedRoot "run-patch.ps1"))) "Launcher does not contain the absolute runner path"
    Assert-True ($launcher -match ',\s*0,\s*False') "Launcher does not request a hidden, asynchronous window"
    Assert-True ($runner.Contains((Join-Path $installedRoot "node.exe"))) "Runner does not contain the installed Node.js path"
    Assert-True ($runner.Contains($fixtureAsar)) "Runner does not contain the absolute ZCode ASAR path"

    $bundledNodePath = Join-Path $temporaryRoot "bundled-node.exe"
    Copy-Item -LiteralPath $nodePath -Destination $bundledNodePath -Force
    $bundledInstallRoot = Join-Path $testUserProfile ".zcode-model-discovery-bundled"
    & $installScript -InstallRoot $bundledInstallRoot -SkipScheduledTask -SkipInitialPatch -ZCodeAsar $fixtureAsar -NodePath $bundledNodePath
    Assert-True (Test-Path -LiteralPath (Join-Path $bundledInstallRoot "node.exe")) "Installer did not copy the bundled Node runtime"
    Assert-True ((Get-Content -Raw -LiteralPath (Join-Path $bundledInstallRoot "run-patch.ps1")).Contains((Join-Path $bundledInstallRoot "node.exe"))) "Runner does not use the bundled Node runtime"

    & $installScript -TaskName $testTaskName -SkipInitialPatch -ZCodeAsar $fixtureAsar
    $task = Get-ScheduledTask -TaskName $testTaskName -ErrorAction Stop
    $taskXml = [xml](Export-ScheduledTask -TaskName $testTaskName)
    $triggerNames = @($taskXml.Task.Triggers.ChildNodes | ForEach-Object { $_.LocalName })
    Assert-True ($triggerNames.Count -eq 1 -and $triggerNames[0] -eq "LogonTrigger") "Installer registered a non-logon trigger: $($triggerNames -join ',')"
    Assert-True (-not ($taskXml.Task.Triggers.ChildNodes | Where-Object { $_.LocalName -eq "TimeTrigger" })) "Installer still registered a time trigger"

    $statePath = Join-Path $installedRoot "state.json"
    Set-Content -LiteralPath $statePath -Value '{"status":"preserve-me"}' -NoNewline
    & $installScript -SkipScheduledTask -SkipInitialPatch -ZCodeAsar $fixtureAsar
    Assert-True ((Get-Content -Raw -LiteralPath $statePath) -eq '{"status":"preserve-me"}') "Reinstall overwrote state.json"

    $backupFile = Join-Path $installedRoot "backups\official.asar"
    $logFile = Join-Path $installedRoot "logs\patcher.log"
    New-Item -ItemType Directory -Path (Split-Path -Parent $backupFile) -Force | Out-Null
    Set-Content -LiteralPath $backupFile -Value "backup" -NoNewline
    Set-Content -LiteralPath $logFile -Value "log" -NoNewline
    $uninstallOutput = & $uninstallScript -InstallRoot $installedRoot -SkipScheduledTask | Out-String
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $installedRoot "apply-patch.mjs"))) "Uninstall left the patch runtime in place"
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $installedRoot "node_modules"))) "Uninstall left node_modules in place"
    Assert-True (Test-Path -LiteralPath $statePath) "Uninstall removed state.json"
    Assert-True (Test-Path -LiteralPath $backupFile) "Uninstall removed backups"
    Assert-True (Test-Path -LiteralPath $logFile) "Uninstall removed logs"
    Assert-True ($uninstallOutput -match '--restore') "Uninstall did not print the explicit restore command"

    Write-Output "PASS: isolated installer, preservation, and uninstall checks"
} finally {
    Unregister-ScheduledTask -TaskName $testTaskName -Confirm:$false -ErrorAction SilentlyContinue
    $env:LOCALAPPDATA = $previousLocalAppData
    $env:USERPROFILE = $previousUserProfile
    if (Test-Path -LiteralPath $temporaryRoot) {
        $resolvedTemporaryRoot = [System.IO.Path]::GetFullPath($temporaryRoot)
        $resolvedSystemTemp = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\') + '\'
        if (-not $resolvedTemporaryRoot.StartsWith($resolvedSystemTemp, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Refusing to remove a test directory outside the system temp root: $resolvedTemporaryRoot"
        }
        Remove-Item -LiteralPath $resolvedTemporaryRoot -Recurse -Force
    }
}
