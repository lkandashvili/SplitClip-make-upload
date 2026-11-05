<#
.SYNOPSIS
  Render a split-screen captioned clip and publish it, in one command.

.DESCRIPTION
  Wraps make-split.ps1 (download -> stack -> captions) and then calls
  clip-uploader\upload.mjs to post the finished file to YouTube, Instagram,
  Facebook and TikTok.

  Two ways to use it:

    # render AND post
    .\make-and-post.ps1 -Url "https://youtube.com/watch?v=..." -Start 42:38 -End 43:18 `
                        -Name Robert_Pape_Blackout -Title "Potential BLACKOUT in Ukraine" `
                        -Caption "Robert Pape" -Tags war,ukraine,podcast

    # post something you rendered earlier (no re-render)
    .\make-and-post.ps1 -ExistingFile ".\Robert_Pape_Blackout_split_captioned.mp4" `
                        -Title "..." -Caption "..." -Tags a,b,c

  If -Title / -Caption / -Tags are omitted you are prompted for them, with the
  clip name as the suggested default.

  Nothing is uploaded when -DryRun is passed: you see exactly what each platform
  would receive.

.PARAMETER SkipUpload
  Render only. Identical to running make-split.ps1 yourself.

.PARAMETER ExistingFile
  Skip rendering and upload an already-finished file.

.PARAMETER Platforms
  Comma list passed to clip-uploader. Default: all four.

.EXAMPLE
  .\make-and-post.ps1 -Url "https://www.youtube.com/watch?v=ABC" -Start 10:00 -End 10:45 -Name clip1 -DryRun
#>
# PositionalBinding must be OFF. Without this, an unquoted multi-word value
# spills into the NEXT parameter in declaration order - "-Name Joey Diaz Story"
# silently bound "Story" to -Layout, and could equally have overwritten
# -GameplayUrl. With it off, stray words are a hard error instead.
[CmdletBinding(PositionalBinding = $false)]
param(
    # --- render (passed straight through to make-split.ps1) ---
    [Alias('VideoUrl')]
    [string]$Url,
    [string]$Start,
    [string]$End,
    [string]$Name,
    [Alias('GameplayUrl')]
    [string]$MinecraftUrl,
    [Alias('GameplayStart')]
    [string]$MinecraftStart,
    [string]$Folder,
    [ValidateSet("fill", "fit")][string]$Layout,
    [double]$PodcastFocus = -1,
    [double]$CaptionPos = -1,
    [double]$Outline = -1,
    [int]$Fps = 0,
    [int]$PreRoll = -1,
    [ValidateSet("1080", "best")][string]$Quality,
    [string]$Cookies,
    [string]$CookiesFile,
    [switch]$NoCookies,
    [switch]$SkipCaptions,
    [switch]$KeepFiles,

    # --- upload ---
    [string]$Title,
    [string]$Caption,
    [Alias('Hashtags')]
    [string[]]$Tags,
    [string]$Platforms = "youtube,instagram,facebook,tiktok",
    [ValidateSet("", "public", "unlisted", "private")][string]$Privacy = "",
    [string]$ExistingFile,
    [switch]$DryRun,
    [switch]$SkipUpload,
    # Folder holding upload.mjs. Empty = the clip-uploader folder beside this script.
    [string]$UploaderPath = ""
)

$ErrorActionPreference = "Stop"

function Write-Step([string]$t) { Write-Host ""; Write-Host "=== $t ===" -ForegroundColor Cyan }
function Fail([string]$m) { Write-Host "ERROR: $m" -ForegroundColor Red; exit 1 }

# Read-Host returns $null when nothing is typed (or when the script runs without
# an interactive console), and .Trim() on that throws. Always come back a string.
function Read-Value([string]$prompt) {
    $v = Read-Host $prompt
    if ($null -eq $v) { return "" }
    return ([string]$v).Trim()
}

$here = if ($PSScriptRoot) { $PSScriptRoot } else { (Get-Location).Path }
$workFolder = if ($Folder) { $Folder } else { $here }

# Bundle-friendly default: the uploader that ships beside this script.
if (-not $UploaderPath) { $UploaderPath = Join-Path $here "clip-uploader" }

# NOTE: an unquoted value containing spaces binds only its first word and the
# rest are dropped silently - PowerShell gives no error. Always quote -Name,
# -Title, -Caption and -Tags text that contains spaces.

# ------------------------------------------------------------------ 1. render
$finalFile = $null

if ($ExistingFile) {
    $finalFile = if (Test-Path -LiteralPath $ExistingFile) { (Resolve-Path -LiteralPath $ExistingFile).Path }
                 else { Fail "No such file: $ExistingFile" }
    Write-Step "Using existing clip: $([System.IO.Path]::GetFileName($finalFile))"
}
elseif (-not $SkipUpload) {
    $makeSplit = Join-Path $here "make-split.ps1"
    if (-not (Test-Path -LiteralPath $makeSplit)) { Fail "make-split.ps1 not found next to this script ($here)." }

    if (-not $Name) {
        $Name = Read-Value "Clip name (used for the file name)"
        if (-not $Name) { Fail "A clip name is required so the upload knows which file to post." }
    }

    Write-Step "Rendering: $Name"

    $renderParams = @{ NoOpen = $true }
    foreach ($key in @('Url', 'Start', 'End', 'Name', 'MinecraftUrl', 'MinecraftStart', 'Folder', 'Layout', 'PodcastFocus', 'CaptionPos', 'Outline', 'Fps', 'PreRoll', 'Quality', 'Cookies', 'CookiesFile')) {
        if ($PSBoundParameters.ContainsKey($key)) { $renderParams[$key] = $PSBoundParameters[$key] }
    }
    if ($NoCookies) { $renderParams['NoCookies'] = $true }
    if ($SkipCaptions) { $renderParams['SkipCaptions'] = $true }
    if ($KeepFiles) { $renderParams['KeepFiles'] = $true }

    $startedAt = Get-Date

    # Run make-split.ps1 in its OWN process with -ExecutionPolicy Bypass.
    # Calling it in-process fails whenever the file carries a Zone.Identifier
    # ("mark of the web", e.g. it arrived in a zip) while the policy is
    # RemoteSigned - the same reason make-split.bat uses Bypass.
    $childArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $makeSplit)
    foreach ($key in $renderParams.Keys) {
        $value = $renderParams[$key]
        if ($value -is [System.Management.Automation.SwitchParameter]) {
            if ($value.IsPresent) { $childArgs += "-$key" }
        }
        elseif ($value -is [bool]) {
            if ($value) { $childArgs += "-$key" }
        }
        else {
            $childArgs += @("-$key", [string]$value)
        }
    }

    & powershell @childArgs
    if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) { Fail "make-split.ps1 failed (exit $LASTEXITCODE). Nothing was uploaded." }

    # Do NOT predict the file name: make-split.ps1 sanitises it (spaces become
    # underscores) and may change that rule later. Take the newest matching file
    # that appeared during this run instead.
    $absWork = (Resolve-Path -LiteralPath $workFolder).Path
    $suffix = if ($SkipCaptions) { "_split.mp4" } else { "_split_captioned.mp4" }
    $safeName = $Name -replace '\s+', '_'
    $predicted = Join-Path $absWork "$safeName$suffix"

    if (Test-Path -LiteralPath $predicted) {
        $finalFile = $predicted
    }
    else {
        $fresh = Get-ChildItem -LiteralPath $absWork -Filter "*$suffix" -File -ErrorAction SilentlyContinue |
            Where-Object { $_.LastWriteTime -ge $startedAt.AddSeconds(-5) } |
            Sort-Object LastWriteTime -Descending |
            Select-Object -First 1
        if (-not $fresh) {
            Fail "Render finished but no new *$suffix file appeared in $absWork. Nothing was uploaded."
        }
        $finalFile = $fresh.FullName
    }

    Write-Step "Rendered: $([System.IO.Path]::GetFileName($finalFile))"
}
else {
    Write-Host "SkipUpload given without ExistingFile - nothing to do." -ForegroundColor Yellow
    exit 0
}

if ($SkipUpload) {
    Write-Step "Done (render only)"
    Write-Host "  $finalFile"
    exit 0
}

# ------------------------------------------------------------------ 2. metadata
$suggested = if ($Name) { $Name } else { [System.IO.Path]::GetFileNameWithoutExtension($finalFile) }
$suggested = $suggested -replace '[_\-]+', ' '

if (-not $Title) {
    $answer = Read-Value "Title [$suggested]"
    $Title = if ($answer) { $answer } else { $suggested }
}
if (-not $Caption) {
    $answer = Read-Value "Caption [$suggested]"
    $Caption = if ($answer) { $answer } else { $suggested }
}
if (-not $Tags) {
    $answer = Read-Value "Tags, comma separated (blank to skip)"
    $Tags = $answer
}

# ------------------------------------------------------------------ 3. upload
$uploader = Join-Path $UploaderPath "upload.mjs"
if (-not (Test-Path -LiteralPath $uploader)) {
    Fail @"
upload.mjs not found at:
  $uploader
Pass the correct location with -UploaderPath, e.g.
  -UploaderPath "C:\path\to\clip-uploader"
"@
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Fail "node is not on PATH." }

$sizeMb = [math]::Round((Get-Item -LiteralPath $finalFile).Length / 1MB, 1)
Write-Step "Uploading $([System.IO.Path]::GetFileName($finalFile)) ($sizeMb MB)"

$nodeArgs = @($uploader, "upload", "--file", $finalFile, "--title", $Title, "--caption", $Caption)
if ($Tags) {
    # Accepts both "-Tags a,b,c" (an array) and "-Tags 'a,b,c'" (one string).
    $tagsJoined = ($Tags -join ',')
    if ($tagsJoined) { $nodeArgs += @("--tags", $tagsJoined) }
}
if ($Platforms) { $nodeArgs += @("--platforms", $Platforms) }
if ($Privacy) { $nodeArgs += @("--privacy", $Privacy) }
if ($DryRun) { $nodeArgs += "--dry-run" }

Push-Location $UploaderPath
try {
    & node @nodeArgs
    $code = $LASTEXITCODE
}
finally {
    Pop-Location
}

Write-Host ""
if ($code -eq 0) {
    Write-Host "Finished." -ForegroundColor Green
} else {
    Write-Host "Upload finished with failures - see the summary above." -ForegroundColor Yellow
}
exit $code
