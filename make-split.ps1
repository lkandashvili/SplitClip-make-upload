<#
.SYNOPSIS
  Make a vertical split-screen clip: gameplay (e.g. Minecraft parkour) on top, podcast on the bottom,
  with captions - from two links.

.DESCRIPTION
  Asks for: podcast URL, start, end, gameplay URL, gameplay start (Enter = random moment), name.
  Then:
    1. yt-dlp  downloads ONLY the podcast section you want (audio is kept)
    2. yt-dlp  downloads a gameplay section of exactly the same length (audio is dropped)
    3. ffmpeg  stacks them into one 1080x1920 video (gameplay on top, podcast below)
    4. uv/Whisper add_captions.py  burns the captions
    5. clean-up: deletes every temporary file and keeps ONLY <name>_split_captioned.mp4

  Work folder = the folder this script lives in (put add_captions.py there too).
  The gameplay link is remembered in split-config.json, so next time just press Enter.

.EXAMPLE
  .\make-split.ps1
  .\make-split.ps1 -Url "https://www.youtube.com/watch?v=PODCAST_ID" -Start 42:38 -End 43:18 -Name clip3 `
                   -MinecraftUrl "https://www.youtube.com/watch?v=GAMEPLAY_ID"
  .\make-split.ps1 -Layout fit            # podcast NOT cropped, captions on a black bar underneath
  .\make-split.ps1 -CaptionPos 0.72       # move captions lower (0 = top ... 1 = bottom)
  .\make-split.ps1 -PodcastFocus 0.3      # crop the podcast left of centre (0 = left, 1 = right)
  .\make-split.ps1 -PreRoll 12            # extra seconds downloaded before your start (see below)
  .\make-split.ps1 -CookiesFile "C:\path\cookies.txt"   # use a specific cookies file
  .\make-split.ps1 -Cookies firefox       # read the YouTube login straight from a browser instead
  .\make-split.ps1 -NoCookies             # ignore cookies.txt for this run

  About cookies: age-restricted videos need your YouTube login ("Sign in to confirm your age").
  Save your YouTube cookies as cookies.txt (Netscape format) in the work folder and the script uses
  it automatically for every download. The script prints how to export it if a download is refused.

  About -PreRoll: YouTube downloads often have a video track that starts a few seconds AFTER the
  audio. Stacking such a file freezes the picture at the start while sound plays. To avoid it, the
  script downloads a few extra seconds before your start time and trims to the exact start while
  stacking, so both picture and sound exist from the first frame.
#>
[CmdletBinding()]
param(
    [string]$Url,
    [string]$Start,
    [string]$End,
    [string]$Name,
    [string]$MinecraftUrl,
    [string]$MinecraftStart,
    [string]$Folder,
    [ValidateSet("fill", "fit")][string]$Layout = "fill",
    [double]$PodcastFocus = 0.5,
    [double]$CaptionPos = -1,
    [double]$Outline = -1,
    [int]$Fps = 30,
    [int]$PreRoll = 8,
    [ValidateSet("1080", "best")][string]$Quality = "1080",
    [string]$Cookies = "",
    [string]$CookiesFile = "",
    [switch]$NoCookies,
    [switch]$SkipCaptions,
    [switch]$KeepFiles,
    [switch]$NoOpen
)

$ErrorActionPreference = "Stop"
$interactive = -not ($Url -and $Start -and $End -and $Name)

# ------------------------------------------------------------------ helpers
function Write-Step([string]$text) { Write-Host ""; Write-Host "=== $text ===" -ForegroundColor Cyan }
function Write-Problem([string]$text) { Write-Host "ERROR: $text" -ForegroundColor Red }

function Convert-ToSeconds([string]$t) {
    $t = $t.Trim()
    if ($t -match '^\d+(\.\d+)?$') { return [double]$t }
    if ($t -match '^(\d+):([0-5]?\d(\.\d+)?)$') { return [int]$Matches[1] * 60 + [double]$Matches[2] }
    if ($t -match '^(\d+):([0-5]?\d):([0-5]?\d(\.\d+)?)$') {
        return [int]$Matches[1] * 3600 + [int]$Matches[2] * 60 + [double]$Matches[3]
    }
    return $null
}

function Format-Clock([double]$s) {
    $ts = [TimeSpan]::FromSeconds([math]::Floor($s))
    if ($ts.TotalHours -ge 1) { return "{0}:{1:00}:{2:00}" -f [int]$ts.TotalHours, $ts.Minutes, $ts.Seconds }
    return "{0}:{1:00}" -f $ts.Minutes, $ts.Seconds
}

function Get-Answer([string]$prompt, [string]$current, [scriptblock]$validate, [string]$hint) {
    while ($true) {
        if (-not $current) { $current = (Read-Host $prompt).Trim() }
        if ($current -and (& $validate $current)) { return $current.Trim() }
        Write-Problem $hint
        $current = ""
    }
}

function Find-Uv {
    # the leading comma keeps PowerShell from unwrapping a one-item array into a plain string
    if (Get-Command uv -ErrorAction SilentlyContinue) { return , @("uv") }
    if (Get-Command python -ErrorAction SilentlyContinue) {
        & python -m uv --version *> $null
        if ($LASTEXITCODE -eq 0) { return , @("python", "-m", "uv") }
    }
    return $null
}

function Test-Overwrite([string[]]$files) {
    $existing = @($files | Where-Object { Test-Path -LiteralPath $_ })
    if (-not $existing) { return $false }
    Write-Host "These files already exist:" -ForegroundColor Yellow
    $existing | ForEach-Object { Write-Host "  $_" }
    $a = Read-Host "Overwrite them? (y/N)"
    if ($a -notmatch '^(y|yes)$') { throw "Cancelled - pick a different name or move the old files." }
    return $true
}

function Invoke-Step([string]$title, [scriptblock]$run, [string]$expectFile) {
    Write-Step $title
    $sw = [Diagnostics.Stopwatch]::StartNew()
    & $run
    if ($LASTEXITCODE -ne 0) { throw "$title failed (exit code $LASTEXITCODE). See the messages above." }
    if ($expectFile -and -not (Test-Path -LiteralPath $expectFile)) {
        throw "$title finished but this file was not created: $expectFile"
    }
    Write-Host ("Done in {0:N0}s" -f $sw.Elapsed.TotalSeconds) -ForegroundColor Green
}

function Get-Number([string]$text) {
    $v = 0.0
    $ok = [double]::TryParse(("$text").Trim(), [Globalization.NumberStyles]::Float,
        [Globalization.CultureInfo]::InvariantCulture, [ref]$v)
    if ($ok) { return $v }
    return $null
}

function Get-RemoteDuration([string]$link, [string[]]$extra) {
    try {
        $out = & yt-dlp --no-playlist --skip-download --print "%(duration)s" @extra $link 2>$null
        $v = Get-Number ($out | Select-Object -Last 1)
        if ($v -and $v -gt 0) { return $v }
    }
    catch { }
    return $null
}

function Get-VideoSize([string]$path) {
    $out = & ffprobe -v error -select_streams v:0 -show_entries "stream=width,height" -of "csv=s=x:p=0" $path 2>$null
    if (("$out").Trim() -match '^(\d+)x(\d+)$') { return @([int]$Matches[1], [int]$Matches[2]) }
    return $null
}

function Get-YtdlpText([string[]]$ytArgs) {
    # runs yt-dlp and returns everything it printed (stdout + stderr) as one string
    $old = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try { $o = & yt-dlp @ytArgs 2>&1 | ForEach-Object { "$_" } }
    catch { $o = @("$_") }
    finally { $ErrorActionPreference = $old }
    return (@($o) -join "`n")
}

function Test-CookiesFile([string]$path) {
    # returns a list of warnings about a cookies file (empty list = looks fine)
    $warn = @()
    $head = @(Get-Content -LiteralPath $path -TotalCount 5 -ErrorAction SilentlyContinue)
    if (-not ($head | Where-Object { $_ -match '^\s*#\s*(Netscape )?HTTP Cookie File' })) {
        $warn += "this does not look like a Netscape-format cookies file (its first line should be '# Netscape HTTP Cookie File'). Export it again with a 'cookies.txt' browser extension."
    }
    if (-not (Select-String -LiteralPath $path -Pattern 'youtube\.com' -Quiet)) {
        $warn += "there are no youtube.com cookies in this file."
    }
    elseif (-not (Select-String -LiteralPath $path -Pattern '\t(__Secure-1PSID|__Secure-3PSID|SID|LOGIN_INFO)\t' -Quiet)) {
        $warn += "no sign-in cookies found - were you logged into YouTube when you exported it?"
    }
    return $warn
}

function Show-SignInHelp([string]$link, [string[]]$cookieArgs, [string]$Folder, [bool]$hadCookies) {
    # after a failed download: if the reason is a sign-in requirement, explain how to fix it
    $text = Get-YtdlpText (@("--simulate", "--no-playlist", "--print", "id") + $cookieArgs + @($link))
    if ($text -notmatch "confirm your age|age-restricted|Sign in to confirm") { return }
    Write-Host ""
    Write-Host "This video needs a signed-in YouTube account (it is age-restricted)." -ForegroundColor Yellow
    if ($hadCookies) {
        Write-Host "Your cookies were used but were refused: they may have expired, been exported while logged out," -ForegroundColor Yellow
        Write-Host "or the account may not be age-verified. Export a fresh cookies.txt as described below." -ForegroundColor Yellow
    }
    Write-Host "How to fix it (one time, then it works automatically):" -ForegroundColor Yellow
    Write-Host "  1. Open a PRIVATE / incognito browser window and log into YouTube with an age-verified account."
    Write-Host "  2. In that same window, open  https://www.youtube.com/robots.txt"
    Write-Host "  3. With a 'cookies.txt' extension (e.g. 'Get cookies.txt LOCALLY') export the cookies for youtube.com."
    Write-Host "     Then close the private window (this stops YouTube from rotating the cookies you just saved)."
    Write-Host "  4. Save the file as:  $(Join-Path $Folder 'cookies.txt')"
    Write-Host "  5. Run this again - the script finds cookies.txt by itself."
    Write-Host "Keep cookies.txt private: it gives access to your Google account."
}

function Get-StreamStarts([string]$path) {
    # start time (seconds) of the first video and first audio stream; $null if missing
    $res = @{ Video = $null; Audio = $null }
    $lines = & ffprobe -v error -show_entries "stream=codec_type,start_time" -of "csv=p=0" $path 2>$null
    foreach ($l in @($lines)) {
        $parts = ("$l").Trim().Split(",")
        if ($parts.Count -lt 2) { continue }
        $v = Get-Number $parts[1]
        if ($null -eq $v) { continue }
        if ($parts[0] -eq "video" -and $null -eq $res.Video) { $res.Video = $v }
        if ($parts[0] -eq "audio" -and $null -eq $res.Audio) { $res.Audio = $v }
    }
    return $res
}

function Get-FileDuration([string]$path) {
    $d = & ffprobe -v error -show_entries format=duration -of "default=nw=1:nk=1" $path 2>$null
    return (Get-Number $d)
}

function Get-StreamEnd([string]$path, [string]$stream) {
    # latest end time (seconds) of any packet in the first video ("v:0") or audio ("a:0") stream
    $lines = & ffprobe -v error -select_streams $stream -show_entries "packet=pts_time,duration_time" -of "csv=p=0" $path 2>$null
    $best = $null
    foreach ($l in @($lines)) {
        $p = ("$l").Trim().Split(",")
        $t = Get-Number $p[0]
        if ($null -eq $t) { continue }
        $d = 0.0
        if ($p.Count -gt 1) { $x = Get-Number $p[1]; if ($null -ne $x) { $d = $x } }
        if ($null -eq $best -or ($t + $d) -gt $best) { $best = $t + $d }
    }
    return $best
}

function Get-AvProblem([string]$path) {
    # picture and sound of one download must end together; a big gap means the connection dropped mid-download
    $v = Get-StreamEnd $path "v:0"
    $a = Get-StreamEnd $path "a:0"
    if ($null -eq $v) { return "the download contains no video" }
    if ($null -eq $a) { return "the download contains no audio" }
    if ($a -lt ($v - 1.5)) { return ("the audio stops {0:N1}s before the picture (audio {1:N1}s, video {2:N1}s)" -f ($v - $a), $a, $v) }
    if ($v -lt ($a - 1.5)) { return ("the picture stops {0:N1}s before the audio (video {1:N1}s, audio {2:N1}s)" -f ($a - $v), $v, $a) }
    return $null
}

function Get-VideoLengthProblem([string]$path, [double]$need) {
    $end = Get-StreamEnd $path "v:0"
    if ($null -eq $end) { return "no video was downloaded" }
    $st = (Get-StreamStarts $path).Video
    if ($null -eq $st) { $st = 0.0 }
    if (($end - $st) -lt ($need - 0.5)) { return ("only {0:N1}s of video was downloaded but {1:N1}s are needed" -f ($end - $st), $need) }
    return $null
}

function Get-StreamDurations([string]$path) {
    $res = @{ Video = $null; Audio = $null }
    $lines = & ffprobe -v error -show_entries "stream=codec_type,duration" -of "csv=p=0" $path 2>$null
    foreach ($l in @($lines)) {
        $p = ("$l").Trim().Split(",")
        if ($p.Count -lt 2) { continue }
        $v = Get-Number $p[1]
        if ($null -eq $v) { continue }
        if ($p[0] -eq "video" -and $null -eq $res.Video) { $res.Video = $v }
        if ($p[0] -eq "audio" -and $null -eq $res.Audio) { $res.Audio = $v }
    }
    return $res
}

function Test-VideoOk([string]$path, [double]$minSeconds = 0.5) {
    if (-not (Test-Path -LiteralPath $path)) { return $false }
    if ((Get-Item -LiteralPath $path).Length -lt 100KB) { return $false }
    if (Get-Command ffprobe -ErrorAction SilentlyContinue) {
        $d = & ffprobe -v error -show_entries format=duration -of "default=nw=1:nk=1" $path 2>$null
        $v = Get-Number $d
        if ($null -eq $v) { return $false }
        return ($v -gt $minSeconds)
    }
    return $true
}

function Remove-Intermediates([string]$Folder, [string[]]$Bases, [string]$Final, [string[]]$Known) {
    Write-Step "Cleaning up temporary files"
    if (-not (Test-VideoOk $Final)) {
        Write-Host "The final video looks incomplete, so nothing was deleted." -ForegroundColor Yellow
        return
    }
    $patterns = @()
    foreach ($b in $Bases) {
        $esc = [regex]::Escape($b)
        $patterns += "^$esc\.mkv\.(part.*|ytdl)$"
        $patterns += "^$esc\.ytdl$"
        $patterns += "^$esc\.f\d+\.[A-Za-z0-9]+(\.part.*)?$"
    }
    $leftovers = @(Get-ChildItem -LiteralPath $Folder -File | Where-Object {
            $n = $_.Name
            ($patterns | Where-Object { $n -match $_ }).Count -gt 0
        } | ForEach-Object { $_.FullName })
    $targets = @(@($Known) + $leftovers | Where-Object {
            $_ -and ($_ -ne $Final) -and (Test-Path -LiteralPath $_)
        } | Select-Object -Unique)
    $count = 0
    $bytes = 0
    foreach ($f in $targets) {
        try {
            $bytes += (Get-Item -LiteralPath $f).Length
            Remove-Item -LiteralPath $f -Force
            $count++
        }
        catch { Write-Host "Could not delete $f ($($_.Exception.Message))" -ForegroundColor Yellow }
    }
    if ($count -eq 0) { Write-Host "Nothing to clean up." }
    else { Write-Host ("Removed {0} file(s), freed {1:N1} MB. Kept only the finished video." -f $count, ($bytes / 1MB)) -ForegroundColor Green }
}

# ------------------------------------------------------------------ one clip
function New-SplitClip {
    param([string]$Url, [string]$Start, [string]$End, [string]$Name,
        [string]$MinecraftUrl, [string]$MinecraftStart, [string]$Folder)

    $cfgPath = Join-Path $Folder "split-config.json"
    $savedUrl = ""
    if (Test-Path -LiteralPath $cfgPath) {
        try { $savedUrl = [string](Get-Content -LiteralPath $cfgPath -Raw | ConvertFrom-Json).MinecraftUrl } catch { }
    }

    # --- inputs
    $Url = Get-Answer "Podcast video URL" $Url { param($v) $v -match '^https?://\S+$' } "Enter a full link starting with http:// or https://"
    $Start = Get-Answer "Podcast start time (e.g. 42:38 or 1:02:30)" $Start { param($v) $null -ne (Convert-ToSeconds $v) } "Use MM:SS, H:MM:SS or plain seconds."
    $End = Get-Answer "Podcast end time   (e.g. 43:18)" $End { param($v) $null -ne (Convert-ToSeconds $v) } "Use MM:SS, H:MM:SS or plain seconds."
    $s = Convert-ToSeconds $Start
    $e = Convert-ToSeconds $End
    while ($e -le $s) {
        Write-Problem "End time must be later than the start time."
        $End = Get-Answer "Podcast end time" "" { param($v) $null -ne (Convert-ToSeconds $v) } "Use MM:SS, H:MM:SS or plain seconds."
        $e = Convert-ToSeconds $End
    }
    $dur = $e - $s

    if (-not $MinecraftUrl) { $MinecraftUrl = $savedUrl }
    if ($interactive -and $MinecraftUrl) {
        $typed = (Read-Host "Gameplay video URL [Enter = $MinecraftUrl]").Trim()
        if ($typed) { $MinecraftUrl = $typed }
    }
    $MinecraftUrl = Get-Answer "Gameplay (Minecraft) video URL" $MinecraftUrl { param($v) $v -match '^https?://\S+$' } "Enter a full link starting with http:// or https://"
    if ($interactive -and -not $MinecraftStart) {
        $MinecraftStart = (Read-Host "Gameplay start time [Enter = random moment]").Trim()
    }
    if ($MinecraftStart -and $null -eq (Convert-ToSeconds $MinecraftStart)) {
        $MinecraftStart = Get-Answer "Gameplay start time" "" { param($v) $null -ne (Convert-ToSeconds $v) } "Use MM:SS, H:MM:SS or plain seconds."
    }

    $Name = Get-Answer "Name for this clip (no extension)" $Name { param($v) ($v -replace '[\\/:*?"<>|%\s]', '') -ne '' } "Enter a name."
    $clean = ($Name -replace '[\\/:*?"<>|%]', '_' -replace '\s+', '_').Trim('_', '.')
    if ($clean -ne $Name) { Write-Host "Using file name: $clean" -ForegroundColor Yellow }
    $Name = $clean

    Write-Host ("Podcast section: {0} -> {1}  ({2:N0}s)" -f (Format-Clock $s), (Format-Clock $e), $dur)

    # --- paths
    $pod = Join-Path $Folder "${Name}_podcast.mkv"
    $mc = Join-Path $Folder "${Name}_minecraft.mkv"
    $split = Join-Path $Folder "${Name}_split.mp4"
    $ass = Join-Path $Folder "${Name}_split.ass"
    $capt = Join-Path $Folder "${Name}_split_captioned.mp4"
    $outputs = @($pod, $mc, $split)
    if (-not $SkipCaptions) { $outputs += $capt }
    $overwrite = Test-Overwrite $outputs

    $cookieArgs = @()
    $usingCookies = $false
    if (-not $NoCookies) {
        $cfile = $CookiesFile
        if (-not $cfile -and -not $Cookies) {
            $auto = Join-Path $Folder "cookies.txt"
            if (Test-Path -LiteralPath $auto) { $cfile = $auto }
        }
        if ($cfile) {
            if (-not (Test-Path -LiteralPath $cfile)) { throw "Cookies file not found: $cfile" }
            $cfile = (Resolve-Path -LiteralPath $cfile).Path
            $cookieArgs = @("--cookies", $cfile)
            $usingCookies = $true
            Write-Host "Using your YouTube cookies from: $cfile" -ForegroundColor Cyan
            foreach ($w in @(Test-CookiesFile $cfile)) { Write-Host "WARNING: $w" -ForegroundColor Yellow }
        }
        elseif ($Cookies) {
            $cookieArgs = @("--cookies-from-browser", $Cookies)
            $usingCookies = $true
            Write-Host "Using the YouTube login from your $Cookies browser" -ForegroundColor Cyan
        }
    }
    # ask ffmpeg to reconnect if the connection to the video site drops while it downloads
    $net = @("--downloader-args", "ffmpeg_i:-reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 5")
    $sort = "res:1080,fps"
    if ($Quality -eq "best") { $sort = "res,fps" }

    # --- choose the gameplay moment (same length as the podcast clip)
    $total = Get-RemoteDuration $MinecraftUrl $cookieArgs
    if ($MinecraftStart) {
        $mcS = [math]::Floor((Convert-ToSeconds $MinecraftStart))
        if ($total -and ($mcS + $dur + 5 -gt $total)) {
            throw ("That gameplay start is too close to the end of the video ({0} long, clip needs {1:N0}s)." -f (Format-Clock $total), $dur)
        }
    }
    elseif ($total) {
        $lo = [int][math]::Min(30, [math]::Floor($total * 0.05))
        $hi = [int][math]::Floor($total - $dur - 15)
        if ($hi -le $lo) { throw "The gameplay video is too short for a $([math]::Round($dur))s clip." }
        $mcS = Get-Random -Minimum $lo -Maximum $hi
        Write-Host "Random gameplay moment: starts at $(Format-Clock $mcS)" -ForegroundColor Yellow
    }
    else {
        $MinecraftStart = Get-Answer "Could not read the gameplay length - type a gameplay start time" "" { param($v) $null -ne (Convert-ToSeconds $v) } "Use MM:SS, H:MM:SS or plain seconds."
        $mcS = [math]::Floor((Convert-ToSeconds $MinecraftStart))
    }
    $mcStartInt = [int]$mcS
    $mcEndInt = [int][math]::Ceiling($mcS + $dur) + 3

    # remember the gameplay link for next time
    try { @{ MinecraftUrl = $MinecraftUrl } | ConvertTo-Json | Set-Content -LiteralPath $cfgPath -Encoding UTF8 } catch { }

    # --- step 1: podcast section (exact cut points so the captions line up)
    $pS = [int][math]::Max(0, [math]::Floor($s - $PreRoll))     # begin a few seconds early ...
    $pE = [int][math]::Ceiling($e)
    $pre = $s - $pS                                             # ... and remember how early
    $yt1 = @("-P", $Folder, "-o", "${Name}_podcast.%(ext)s", "-f", "bv*+ba/b", "-S", $sort,
        "--merge-output-format", "mkv", "--download-sections", "*${pS}-${pE}",
        "--force-keyframes-at-cuts", "--no-playlist")
    if ($overwrite) { $yt1 += "--force-overwrites" }
    $yt1 += $net
    $yt1 += $cookieArgs
    $yt1 += $Url
    for ($try = 1; $true; $try++) {
        $run1 = $yt1
        if ($try -gt 1) { $run1 = @($yt1) + "--force-overwrites" }
        try { Invoke-Step "Step 1/4: downloading the podcast section $Start - $End" { & yt-dlp @run1 } $pod }
        catch { Show-SignInHelp $Url $cookieArgs $Folder $usingCookies; throw }
        $problem = Get-AvProblem $pod
        if (-not $problem) { break }
        Write-Host "WARNING: the podcast download is incomplete - $problem." -ForegroundColor Yellow
        if ($try -ge 3) {
            throw "The podcast download keeps coming out incomplete ($problem). This usually means the connection to the video site keeps dropping. Try again in a few minutes."
        }
        Write-Host "Downloading it again ($try of 2 retries used) ..." -ForegroundColor Yellow
    }

    # --- step 2: gameplay section (audio is dropped later; a few spare seconds, trimmed exactly in step 3)
    $yt2 = @("-P", $Folder, "-o", "${Name}_minecraft.%(ext)s", "-f", "bv*+ba/b", "-S", $sort,
        "--merge-output-format", "mkv", "--download-sections", "*${mcStartInt}-${mcEndInt}", "--no-playlist")
    if ($overwrite) { $yt2 += "--force-overwrites" }
    $yt2 += $net
    $yt2 += $cookieArgs
    $yt2 += $MinecraftUrl
    for ($try = 1; $true; $try++) {
        $run2 = $yt2
        if ($try -gt 1) { $run2 = @($yt2) + "--force-overwrites" }
        try { Invoke-Step "Step 2/4: downloading $([math]::Round($dur))s of gameplay from $(Format-Clock $mcS)" { & yt-dlp @run2 } $mc }
        catch { Show-SignInHelp $MinecraftUrl $cookieArgs $Folder $usingCookies; throw }
        $problem = Get-VideoLengthProblem $mc $dur
        if (-not $problem) { break }
        Write-Host "WARNING: the gameplay download is incomplete - $problem." -ForegroundColor Yellow
        if ($try -ge 3) { throw "The gameplay download keeps coming out too short ($problem). Try another start time or run again later." }
        Write-Host "Downloading it again ($try of 2 retries used) ..." -ForegroundColor Yellow
    }

    # --- find where the podcast really starts: both picture and sound must exist at the cut point
    $starts = Get-StreamStarts $pod
    $aStart = 0.0
    if ($null -ne $starts.Audio) { $aStart = $starts.Audio }
    $cut = $aStart + $pre
    if ($null -ne $starts.Video -and $starts.Video -gt ($cut - 0.02)) {
        $newCut = $starts.Video + 0.05
        Write-Host ("Note: this download's video track starts {0:N1}s after the audio, later than the {1:N1}s of extra lead-in." -f ($starts.Video - $aStart), $pre) -ForegroundColor Yellow
        Write-Host ("      The clip will begin {0:N1}s later than you asked (no picture exists before that). Use -PreRoll {1} to keep your exact start." -f ($newCut - $cut), ([int][math]::Ceiling($starts.Video - $aStart + $PreRoll + 1))) -ForegroundColor Yellow
        $cut = $newCut
    }
    $podLen = Get-FileDuration $pod
    $outDur = $dur
    if ($podLen) { $outDur = [math]::Min($dur, $podLen + $aStart - $cut) }
    if ($outDur -lt 3) { throw "Almost nothing is left of the podcast clip after trimming. Try a later start time or a larger -PreRoll." }

    # --- step 3: stack them (gameplay on top, podcast below)
    $layoutUsed = $Layout
    $ph = 0
    if ($Layout -eq "fit") {
        $sz = Get-VideoSize $pod
        if ($sz) { $ph = [int]([math]::Round(1080.0 * $sz[1] / $sz[0] / 2) * 2) }
        if ($ph -le 0 -or (960 + $ph) -gt 1700) {
            Write-Host "This podcast video is too tall for the 'fit' layout - using 'fill' instead." -ForegroundColor Yellow
            $layoutUsed = "fill"
        }
    }
    $top = "[1:v]setpts=PTS-STARTPTS,fps=$Fps,scale=1080:960:force_original_aspect_ratio=increase,crop=1080:960,setsar=1[top]"
    if ($layoutUsed -eq "fill") {
        $crop = "(iw-1080)*$PodcastFocus"
        $fc = "[0:v]fps=$Fps,scale=1080:960:force_original_aspect_ratio=increase,crop=1080:960:${crop}:0,setsar=1[bot];" +
        "$top;[top][bot]vstack=inputs=2[v]"
        $capPos = 0.5
        $outl = 6
    }
    else {
        $fc = "[0:v]fps=$Fps,scale=1080:${ph},setsar=1[pod];" +
        "$top;[top][pod]vstack=inputs=2,pad=1080:1920:0:0:black[v]"
        $capPos = ((960 + $ph) + 1920) / 2.0 / 1920.0     # middle of the black bar under the podcast
        $outl = 0
    }
    if ($CaptionPos -ge 0) { $capPos = $CaptionPos }
    if ($Outline -ge 0) { $outl = $Outline }

    $ff = @("-hide_banner", "-loglevel", "warning", "-stats", "-y", "-ss", "$cut", "-i", $pod, "-i", $mc, "-filter_complex", $fc, "-map", "[v]", "-map", "0:a:0?",
        "-t", "$outDur", "-c:v", "libx264", "-crf", "16", "-preset", "slow", "-pix_fmt", "yuv420p",
        "-r", "$Fps", "-c:a", "aac", "-b:a", "256k", "-movflags", "+faststart", $split)
    Invoke-Step "Step 3/4: stacking gameplay (top) + podcast (bottom) into 1080x1920 [$layoutUsed layout]" { & ffmpeg @ff } $split
    $final = $split

    # --- safety check: the stacked video must have sound for (almost) its whole length
    $sd = Get-StreamDurations $split
    if ($null -eq $sd.Audio) { throw "The stacked video has no sound. Your temporary files were kept so you can inspect them." }
    if ($sd.Audio -lt ($outDur - 1.5)) {
        throw ("The sound in the stacked video is only {0:N1}s long but the picture is {1:N1}s. The source audio was incomplete, so nothing was deleted - run the script again." -f $sd.Audio, $outDur)
    }

    # --- step 4: captions
    if (-not $SkipCaptions) {
        $uv = @(Find-Uv)[0]
        if (-not $uv) { throw "Could not find 'uv' (needed for captions). Run:  winget install astral-sh.uv   - or use -SkipCaptions." }
        $uvArgs = @()
        if ($uv.Count -gt 1) { $uvArgs += $uv[1..($uv.Count - 1)] }
        $uvArgs += @("run", "--python", "3.12", "--with", "faster-whisper", "add_captions.py", "${Name}_split.mp4",
            "--center", "$capPos", "--outline", "$outl")
        Push-Location $Folder
        try {
            Invoke-Step "Step 4/4: adding captions (first run downloads the speech model)" { & $uv[0] @uvArgs } $capt
        }
        finally { Pop-Location }
        $final = $capt
    }

    if (-not $KeepFiles) {
        Remove-Intermediates -Folder $Folder -Bases @("${Name}_podcast", "${Name}_minecraft") -Final $final -Known @($pod, $mc, $split, $ass)
    }

    Write-Host ""
    Write-Host "All done!  $final" -ForegroundColor Green
    if (-not $NoOpen -and $IsWindows -ne $false -and (Get-Command explorer.exe -ErrorAction SilentlyContinue)) {
        Start-Process explorer.exe -ArgumentList "/select,`"$final`""
    }
}

# ------------------------------------------------------------------ main
if (-not $Folder) { $Folder = $PSScriptRoot }
if (-not $Folder) { $Folder = (Get-Location).Path }
if (-not (Test-Path -LiteralPath $Folder)) { New-Item -ItemType Directory -Path $Folder | Out-Null }
$Folder = (Resolve-Path -LiteralPath $Folder).Path

$missing = @()
if (-not (Get-Command yt-dlp -ErrorAction SilentlyContinue)) { $missing += "yt-dlp   ->  winget install yt-dlp.yt-dlp" }
if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) { $missing += "ffmpeg   ->  winget install Gyan.FFmpeg" }
if (-not (Get-Command ffprobe -ErrorAction SilentlyContinue)) { $missing += "ffprobe  ->  comes with ffmpeg (winget install Gyan.FFmpeg)" }
if (-not $SkipCaptions) {
    $capScript = Join-Path $Folder "add_captions.py"
    if (-not (Test-Path -LiteralPath $capScript)) {
        $missing += "add_captions.py is not in $Folder  (copy it there, or use -SkipCaptions)"
    }
    elseif (-not (Select-String -LiteralPath $capScript -Pattern '"--outline"' -SimpleMatch -Quiet)) {
        $missing += "add_captions.py is an OLD version (no --outline option) - replace it with the newest one"
    }
    if (-not (Find-Uv)) { $missing += "uv       ->  winget install astral-sh.uv   (or: python -m pip install uv)" }
}
if ($missing) {
    Write-Problem "Something is missing:"
    $missing | ForEach-Object { Write-Host "  - $_" -ForegroundColor Yellow }
    Write-Host "Fix what is listed, open a NEW PowerShell window if you installed something, and run this again."
    exit 1
}

Write-Host "Split-screen clip maker - work folder: $Folder" -ForegroundColor Cyan
do {
    $again = $false
    try {
        New-SplitClip -Url $Url -Start $Start -End $End -Name $Name -MinecraftUrl $MinecraftUrl `
            -MinecraftStart $MinecraftStart -Folder $Folder
    }
    catch {
        Write-Problem $_.Exception.Message
        if (-not $interactive) { exit 1 }
    }
    if ($interactive) {
        $a = Read-Host "`nMake another clip? (y/N)"
        if ($a -match '^(y|yes)$') { $again = $true; $Url = ""; $Start = ""; $End = ""; $Name = ""; $MinecraftStart = "" }
    }
} while ($again)
