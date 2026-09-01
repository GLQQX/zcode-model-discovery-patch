[CmdletBinding()]
param(
    [string]$ZCodeAsar,
    [string]$SeedBackup,
    [string]$InstallRoot = (Join-Path $env:USERPROFILE ".zcode-model-discovery-patch")
)

$ErrorActionPreference = "Stop"
$runtimeArchive = Join-Path $PSScriptRoot "runtime.zip"
$runtimeRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("zcode-model-discovery-runtime-" + [guid]::NewGuid().ToString("N"))
$powershellPath = Join-Path $PSHOME "powershell.exe"

function Find-ZCodeAsar {
    param([string]$ExplicitPath)

    if ($ExplicitPath) {
        return [System.IO.Path]::GetFullPath($ExplicitPath)
    }

    $candidatePaths = [System.Collections.Generic.List[string]]::new()
    $knownPaths = @(
        (Join-Path $env:LOCALAPPDATA "Programs\ZCode\resources\app.asar"),
        (Join-Path $env:LOCALAPPDATA "ZCode\resources\app.asar"),
        (Join-Path $env:ProgramFiles "ZCode\resources\app.asar"),
        (Join-Path ${env:ProgramFiles(x86)} "ZCode\resources\app.asar")
    )
    foreach ($candidate in $knownPaths) {
        if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) {
            [void]$candidatePaths.Add([System.IO.Path]::GetFullPath($candidate))
        }
    }

    foreach ($root in @(
        (Join-Path $env:LOCALAPPDATA "Programs"),
        $env:ProgramFiles,
        ${env:ProgramFiles(x86)}
    )) {
        if (-not $root -or -not (Test-Path -LiteralPath $root -PathType Container)) { continue }
        Get-ChildItem -LiteralPath $root -Filter "app.asar" -File -Recurse -ErrorAction SilentlyContinue |
            Where-Object { $_.DirectoryName -match "[\\/]ZCode[\\/]resources$" } |
            ForEach-Object { [void]$candidatePaths.Add($_.FullName) }
    }

    $unique = @($candidatePaths | Sort-Object -Unique)
    if ($unique.Count -eq 0) {
        throw "ZCode installation was not found. Install ZCode first, or pass -ZCodeAsar with the path to app.asar."
    }
    if ($unique.Count -eq 1) { return $unique[0] }

    $withExecutable = [System.Collections.Generic.List[string]]::new()
    foreach ($candidatePath in $unique) {
        $zcodeRoot = Split-Path -Parent (Split-Path -Parent $candidatePath)
        if (Test-Path -LiteralPath (Join-Path $zcodeRoot "ZCode.exe") -PathType Leaf) {
            [void]$withExecutable.Add($candidatePath)
        }
    }
    if ($withExecutable.Count -eq 1) { return $withExecutable[0] }
    if ($withExecutable.Count -gt 1) {
        return ($withExecutable | ForEach-Object { Get-Item -LiteralPath $_ } | Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName
    }
    return ($unique | ForEach-Object { Get-Item -LiteralPath $_ } | Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName
}

try {
    if (-not (Test-Path -LiteralPath $runtimeArchive -PathType Leaf)) {
        throw "The embedded runtime archive is missing."
    }
    $resolvedZCodeAsar = Find-ZCodeAsar -ExplicitPath $ZCodeAsar
    if (-not (Test-Path -LiteralPath $resolvedZCodeAsar -PathType Leaf)) {
        throw "ZCode app.asar was not found: $resolvedZCodeAsar"
    }

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [System.IO.Compression.ZipFile]::ExtractToDirectory($runtimeArchive, $runtimeRoot)
    $installScript = Join-Path $runtimeRoot "install.ps1"
    $nodePath = Join-Path $runtimeRoot "node.exe"
    if (-not (Test-Path -LiteralPath $installScript -PathType Leaf) -or -not (Test-Path -LiteralPath $nodePath -PathType Leaf)) {
        throw "The embedded patcher runtime is incomplete."
    }

    $arguments = @(
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-File", $installScript,
        "-ZCodeAsar", $resolvedZCodeAsar,
        "-InstallRoot", $InstallRoot,
        "-NodePath", $nodePath
    )
    if ($SeedBackup) {
        $arguments += @("-SeedBackup", $SeedBackup)
    }
    & $powershellPath @arguments
    $exitCode = $LASTEXITCODE
    if ($exitCode -notin @(0, 2)) {
        throw "The patcher returned exit code $exitCode."
    }
    Write-Output "ZCode model-discovery patch installed."
} catch {
    $message = $_.Exception.Message
    try {
        Add-Type -AssemblyName PresentationFramework -ErrorAction Stop
        [System.Windows.MessageBox]::Show($message, "ZCode Model Discovery Patch", "OK", "Error") | Out-Null
    } catch {
        Write-Error $message
    }
    exit 1
} finally {
    if (Test-Path -LiteralPath $runtimeRoot) {
        Remove-Item -LiteralPath $runtimeRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}
