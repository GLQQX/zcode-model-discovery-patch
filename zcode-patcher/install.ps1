[CmdletBinding()]
param(
    [string]$ZCodeAsar = (Join-Path $env:LOCALAPPDATA "Programs\ZCode\resources\app.asar"),
    [string]$SeedBackup,
    [switch]$SkipScheduledTask,
    [switch]$SkipInitialPatch,
    [string]$InstallRoot = (Join-Path $env:USERPROFILE ".zcode-model-discovery-patch"),
    [string]$TaskName = "ZCode Model Discovery Patch",
    [string]$NodePath
)

$ErrorActionPreference = "Stop"
$logonTaskName = "ZCode Model Discovery Patch - Logon"

function ConvertTo-PowerShellLiteral {
    param([Parameter(Mandatory = $true)][string]$Value)
    return "'" + $Value.Replace("'", "''") + "'"
}

function Copy-PatcherRuntime {
    param(
        [Parameter(Mandatory = $true)][string]$SourceRoot,
        [Parameter(Mandatory = $true)][string]$DestinationRoot
    )

    New-Item -ItemType Directory -Path $DestinationRoot -Force | Out-Null
    foreach ($directory in @("lib", "payload", "node_modules")) {
        $sourceDirectory = Join-Path $SourceRoot $directory
        $destinationDirectory = Join-Path $DestinationRoot $directory
        New-Item -ItemType Directory -Path $destinationDirectory -Force | Out-Null
        Copy-Item -Path (Join-Path $sourceDirectory "*") -Destination $destinationDirectory -Recurse -Force
    }
    foreach ($file in @(
        "apply-patch.mjs",
        "install.ps1",
        "uninstall.ps1",
        "package.json",
        "package-lock.json",
        "patch-manifest.json"
    )) {
        Copy-Item -LiteralPath (Join-Path $SourceRoot $file) -Destination (Join-Path $DestinationRoot $file) -Force
    }
}

function Write-HiddenLaunchers {
    param(
        [Parameter(Mandatory = $true)][string]$RuntimeRoot,
        [Parameter(Mandatory = $true)][string]$NodePath,
        [Parameter(Mandatory = $true)][string]$AsarPath
    )

    $runnerPath = Join-Path $RuntimeRoot "run-patch.ps1"
    $launcherPath = Join-Path $RuntimeRoot "run-hidden.vbs"
    $logsRoot = Join-Path $RuntimeRoot "logs"
    $scheduledLog = Join-Path $logsRoot "scheduled-output.log"
    New-Item -ItemType Directory -Path $logsRoot -Force | Out-Null

    $nodeLiteral = ConvertTo-PowerShellLiteral $NodePath
    $applyLiteral = ConvertTo-PowerShellLiteral (Join-Path $RuntimeRoot "apply-patch.mjs")
    $asarLiteral = ConvertTo-PowerShellLiteral $AsarPath
    $rootLiteral = ConvertTo-PowerShellLiteral $RuntimeRoot
    $logsLiteral = ConvertTo-PowerShellLiteral $logsRoot
    $logLiteral = ConvertTo-PowerShellLiteral $scheduledLog
    $runner = @"
`$ErrorActionPreference = "Continue"
New-Item -ItemType Directory -Path $logsLiteral -Force | Out-Null
& $nodeLiteral $applyLiteral --asar $asarLiteral --root $rootLiteral --json *>> $logLiteral
exit `$LASTEXITCODE
"@
    Set-Content -LiteralPath $runnerPath -Value $runner -Encoding UTF8

    $powershellPath = Join-Path $PSHOME "powershell.exe"
    $escapedPowerShellPath = $powershellPath.Replace('"', '""')
    $escapedRunnerPath = $runnerPath.Replace('"', '""')
    $launcher = @"
Set shell = CreateObject("WScript.Shell")
shell.Run """$escapedPowerShellPath"" -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File ""$escapedRunnerPath""", 0, False
"@
    Set-Content -LiteralPath $launcherPath -Value $launcher -Encoding ASCII
    return $launcherPath
}

function Register-PatcherTasks {
    param([Parameter(Mandatory = $true)][string]$LauncherPath)

    $wscriptPath = Join-Path $env:SystemRoot "System32\wscript.exe"
    $scheduledTaskAvailable = $null -ne (Get-Command Register-ScheduledTask -ErrorAction SilentlyContinue)
    if ($scheduledTaskAvailable) {
        try {
            $action = New-ScheduledTaskAction -Execute $wscriptPath -Argument ('"' + $LauncherPath + '"')
            $logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name)
            $settings = New-ScheduledTaskSettingsSet -Hidden -StartWhenAvailable -MultipleInstances IgnoreNew
            $principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
            Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $logonTrigger -Settings $settings -Principal $principal -Force | Out-Null
            Unregister-ScheduledTask -TaskName $logonTaskName -Confirm:$false -ErrorAction SilentlyContinue
            return
        } catch {
            Write-Warning "ScheduledTasks module registration failed; falling back to schtasks.exe: $($_.Exception.Message)"
        }
    }

    $taskCommand = '"' + $wscriptPath + '" "' + $LauncherPath + '"'
    & schtasks.exe /Create /TN $TaskName /TR $taskCommand /SC ONLOGON /F | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to create the logon scheduled task"
    }
}

$sourceRoot = [System.IO.Path]::GetFullPath($PSScriptRoot)
$resolvedInstallRoot = [System.IO.Path]::GetFullPath($InstallRoot)
$resolvedAsar = [System.IO.Path]::GetFullPath($ZCodeAsar)
if (-not (Test-Path -LiteralPath $resolvedAsar -PathType Leaf)) {
    throw "ZCode app.asar was not found: $resolvedAsar"
}
$bundledNodeSource = if ($NodePath) {
    [System.IO.Path]::GetFullPath($NodePath)
} elseif (Test-Path -LiteralPath (Join-Path $sourceRoot "node.exe") -PathType Leaf) {
    Join-Path $sourceRoot "node.exe"
} else {
    (Get-Command node.exe -ErrorAction Stop).Source
}
if (-not (Test-Path -LiteralPath $bundledNodeSource -PathType Leaf)) {
    throw "Node.js runtime was not found: $bundledNodeSource"
}

if (-not $sourceRoot.Equals($resolvedInstallRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    Copy-PatcherRuntime -SourceRoot $sourceRoot -DestinationRoot $resolvedInstallRoot
}
$installedNodePath = Join-Path $resolvedInstallRoot "node.exe"
if (-not $sourceRoot.Equals($resolvedInstallRoot, [System.StringComparison]::OrdinalIgnoreCase) -or $NodePath) {
    Copy-Item -LiteralPath $bundledNodeSource -Destination $installedNodePath -Force
}
if (-not (Test-Path -LiteralPath $installedNodePath -PathType Leaf)) {
    $installedNodePath = $bundledNodeSource
}
$launcherPath = Write-HiddenLaunchers -RuntimeRoot $resolvedInstallRoot -NodePath $installedNodePath -AsarPath $resolvedAsar

if (-not $SkipInitialPatch) {
    $patchArguments = @(
        (Join-Path $resolvedInstallRoot "apply-patch.mjs"),
        "--asar", $resolvedAsar,
        "--root", $resolvedInstallRoot,
        "--json"
    )
    if ($SeedBackup) {
        $resolvedSeedBackup = [System.IO.Path]::GetFullPath($SeedBackup)
        if (-not (Test-Path -LiteralPath $resolvedSeedBackup -PathType Leaf)) {
            throw "Seed backup was not found: $resolvedSeedBackup"
        }
        $patchArguments += @("--seed-backup", $resolvedSeedBackup)
    }
    $previousErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        $patchOutput = & $installedNodePath @patchArguments 2>&1
        $patchExitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
    $patchOutput | Write-Output
    if ($patchExitCode -notin @(0, 2)) {
        throw "Initial patch run failed with exit code $patchExitCode"
    }
}

if (-not $SkipScheduledTask) {
    Register-PatcherTasks -LauncherPath $launcherPath
}

Write-Output "Installed ZCode model-discovery patcher at $resolvedInstallRoot"
if (-not $SkipScheduledTask) {
    Write-Output "Registered scheduled task: $taskName"
}
