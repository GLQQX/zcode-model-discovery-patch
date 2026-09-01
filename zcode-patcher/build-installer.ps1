[CmdletBinding()]
param(
    [string]$OutputPath,
    [string]$NodePath = ((Get-Command node.exe -ErrorAction Stop).Source)
)

$ErrorActionPreference = "Stop"
$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Definition
$sourceRoot = [System.IO.Path]::GetFullPath($scriptRoot)
$resolvedOutputPath = if ($OutputPath) {
    [System.IO.Path]::GetFullPath($OutputPath)
} else {
    [System.IO.Path]::GetFullPath((Join-Path $sourceRoot "..\dist\ZCodeModelDiscoveryPatch-Setup.exe"))
}
$outputFile = $resolvedOutputPath
$iexpressPath = Join-Path $env:SystemRoot "System32\iexpress.exe"
$stageRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("zcode-model-discovery-installer-" + [guid]::NewGuid().ToString("N"))
$payloadRoot = Join-Path $stageRoot "runtime"
$runtimeArchive = Join-Path $stageRoot "runtime.zip"
$sedPath = Join-Path $stageRoot "installer.sed"
$iexpressOutput = Join-Path $stageRoot "ZCodeModelDiscoveryPatch-Setup.exe"
$buildSucceeded = $false

function Add-SedLine {
    param(
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][System.Collections.Generic.List[string]]$Lines,
        [Parameter(Mandatory = $true)][string]$Value
    )
    [void]$Lines.Add($Value)
}

try {
    if (-not (Test-Path -LiteralPath $iexpressPath -PathType Leaf)) {
        throw "Windows IExpress was not found: $iexpressPath"
    }
    if (-not (Test-Path -LiteralPath $NodePath -PathType Leaf)) {
        throw "Node.js runtime was not found: $NodePath"
    }

    New-Item -ItemType Directory -Path $payloadRoot -Force | Out-Null
    foreach ($file in @(
        "apply-patch.mjs",
        "install.ps1",
        "uninstall.ps1",
        "package.json",
        "package-lock.json",
        "patch-manifest.json"
    )) {
        Copy-Item -LiteralPath (Join-Path $sourceRoot $file) -Destination (Join-Path $payloadRoot $file) -Force
    }
    foreach ($directory in @("lib", "payload", "node_modules")) {
        Copy-Item -LiteralPath (Join-Path $sourceRoot $directory) -Destination (Join-Path $payloadRoot $directory) -Recurse -Force
    }
    Copy-Item -LiteralPath $NodePath -Destination (Join-Path $payloadRoot "node.exe") -Force
    foreach ($file in @("setup.cmd", "setup.ps1")) {
        Copy-Item -LiteralPath (Join-Path $sourceRoot $file) -Destination (Join-Path $stageRoot $file) -Force
    }

    Compress-Archive -Path (Join-Path $payloadRoot "*") -DestinationPath $runtimeArchive -CompressionLevel Optimal -Force
    New-Item -ItemType Directory -Path (Split-Path -Parent $outputFile) -Force | Out-Null
    Remove-Item -LiteralPath $outputFile -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $iexpressOutput -Force -ErrorAction SilentlyContinue

    $sedLines = [System.Collections.Generic.List[string]]::new()
    Add-SedLine $sedLines "[Version]"
    Add-SedLine $sedLines "Class=IEXPRESS"
    Add-SedLine $sedLines "SEDVersion=3"
    Add-SedLine $sedLines "[Options]"
    Add-SedLine $sedLines "PackagePurpose=InstallApp"
    Add-SedLine $sedLines "ShowInstallProgramWindow=1"
    Add-SedLine $sedLines "HideExtractAnimation=1"
    Add-SedLine $sedLines "UseLongFileName=1"
    Add-SedLine $sedLines "InsideCompressed=1"
    Add-SedLine $sedLines "CAB_FixedSize=0"
    Add-SedLine $sedLines "CAB_ResvCodeSigning=0"
    Add-SedLine $sedLines "RebootMode=N"
    Add-SedLine $sedLines "InstallPrompt=%InstallPrompt%"
    Add-SedLine $sedLines "DisplayLicense=%DisplayLicense%"
    Add-SedLine $sedLines "FinishMessage=%FinishMessage%"
    Add-SedLine $sedLines "TargetName=%TargetName%"
    Add-SedLine $sedLines "FriendlyName=%FriendlyName%"
    Add-SedLine $sedLines "AppLaunched=%AppLaunched%"
    Add-SedLine $sedLines "PostInstallCmd=%PostInstallCmd%"
    Add-SedLine $sedLines "AdminQuietInstCmd=%AdminQuietInstCmd%"
    Add-SedLine $sedLines "UserQuietInstCmd=%UserQuietInstCmd%"
    Add-SedLine $sedLines "SourceFiles=SourceFiles"
    Add-SedLine $sedLines "[Strings]"
    Add-SedLine $sedLines "InstallPrompt="
    Add-SedLine $sedLines "DisplayLicense="
    Add-SedLine $sedLines "FinishMessage=ZCode model-discovery patch installation finished."
    Add-SedLine $sedLines ("TargetName=" + $iexpressOutput)
    Add-SedLine $sedLines "FriendlyName=ZCode Model Discovery Patch"
    Add-SedLine $sedLines "AppLaunched=cmd.exe /c setup.cmd"
    Add-SedLine $sedLines "PostInstallCmd=<None>"
    Add-SedLine $sedLines "AdminQuietInstCmd=powershell.exe -NoProfile -ExecutionPolicy Bypass -File setup.ps1"
    Add-SedLine $sedLines "UserQuietInstCmd=powershell.exe -NoProfile -ExecutionPolicy Bypass -File setup.ps1"
    Add-SedLine $sedLines "FILE0=setup.cmd"
    Add-SedLine $sedLines "FILE1=setup.ps1"
    Add-SedLine $sedLines "FILE2=runtime.zip"
    Add-SedLine $sedLines "[SourceFiles]"
    Add-SedLine $sedLines ("SourceFiles0=" + $stageRoot + "\")
    Add-SedLine $sedLines "[SourceFiles0]"
    Add-SedLine $sedLines "%FILE0%="
    Add-SedLine $sedLines "%FILE1%="
    Add-SedLine $sedLines "%FILE2%="
    Set-Content -LiteralPath $sedPath -Value $sedLines -Encoding ASCII

    $iexpress = Start-Process -FilePath $iexpressPath -ArgumentList @("/N", "/Q", $sedPath) -WorkingDirectory $stageRoot -Wait -PassThru
    if ($iexpress.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $iexpressOutput -PathType Leaf)) {
        throw "IExpress failed to create the installer (exit code $($iexpress.ExitCode))."
    }
    Move-Item -LiteralPath $iexpressOutput -Destination $outputFile -Force
    if (-not (Test-Path -LiteralPath $outputFile -PathType Leaf)) {
        throw "IExpress output could not be moved to the requested path."
    }
    $buildSucceeded = $true
    $hash = (Get-FileHash -LiteralPath $outputFile -Algorithm SHA256).Hash
    $size = (Get-Item -LiteralPath $outputFile).Length
    [pscustomobject]@{
        path = $outputFile
        sha256 = $hash
        sizeBytes = $size
        bundledNode = $NodePath
    } | ConvertTo-Json -Compress
} finally {
    if ($buildSucceeded -and (Test-Path -LiteralPath $stageRoot)) {
        Remove-Item -LiteralPath $stageRoot -Recurse -Force -ErrorAction SilentlyContinue
    } elseif (Test-Path -LiteralPath $stageRoot) {
        Write-Warning "IExpress staging files were preserved for diagnosis: $stageRoot"
    }
}
