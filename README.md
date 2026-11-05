# Split-Clip Maker & Uploader

Turn a segment of any YouTube video into a vertical split-screen clip and publish it to **YouTube, Instagram, Facebook and TikTok** — in one command.

```
┌─────────────────┐
│   gameplay      │  ← random moment from a gameplay video
├─────────────────┤
│   your clip     │  ← exact segment you chose
│   with captions │     word-by-word burned-in captions
└─────────────────┘
      1080×1920
```

Two tools, chained:

| Tool | Job |
|---|---|
| `make-split.ps1` | download both videos, stack them, burn captions |
| `make-and-post.ps1` | runs the above, then publishes the finished file |
| `clip-uploader/` | the publisher — one command, four platforms |

---

## Requirements

| Software | Why | Install |
|---|---|---|
| **PowerShell 5.1+** | runs the scripts | built into Windows |
| **yt-dlp** | downloads the YouTube segments | `winget install yt-dlp.yt-dlp` |
| **ffmpeg + ffprobe** | cutting, stacking, encoding | `winget install Gyan.FFmpeg` |
| **uv** | runs Whisper for captions | `winget install astral-sh.uv` |
| **Node 20+** | the uploader | `winget install OpenJS.NodeJS` |

Open a **new** terminal after installing anything so `PATH` updates.

## Install

```powershell
git clone https://github.com/<you>/splitclip-maker-and-uploader.git
cd splitclip-maker-and-uploader
Get-ChildItem -Recurse -Filter *.ps1 | Unblock-File
```

> **`Unblock-File` matters.** Files downloaded from the internet carry a *Zone.Identifier*, and Windows blocks them under the default `RemoteSigned` policy with *"is not digitally signed"*. The `.bat` launchers pass `-ExecutionPolicy Bypass` so they work regardless, but unblocking keeps direct `.\make-split.ps1` calls working too.

## One-time setup: connect the uploader

The uploader needs your own developer apps — they are **your** accounts, and nobody should hold your keys.

```powershell
cd clip-uploader
node upload.mjs auth youtube
node upload.mjs auth meta      # Facebook Page + Instagram together
node upload.mjs auth tiktok    # needs a public redirect page, below
node upload.mjs doctor         # all four should say OK
```

Full click-by-click instructions for the Google, Meta and TikTok dashboards are in **[clip-uploader/SETUP.md](clip-uploader/SETUP.md)**.

### TikTok needs a hosted redirect page

TikTok rejects `http://localhost` redirect URIs. `clip-uploader/site/redirect.html` is a ready-made page that displays the authorization code so you can paste it back:

1. Host that file anywhere with HTTPS (Netlify Drop, GitHub Pages, Cloudflare Pages).
2. Register the URL as the Login Kit redirect URI in your TikTok app.
3. `node upload.mjs auth tiktok --manual --redirect-uri https://your-site/redirect.html`

## Usage

### Render and publish in one command

```powershell
.\make-and-post.ps1 `
  -VideoUrl    "https://www.youtube.com/watch?v=BOTTOM_VIDEO_ID" `
  -Start       1:23:16 `
  -End         1:24:19 `
  -GameplayUrl "https://www.youtube.com/watch?v=GAMEPLAY_ID" `
  -Name        "Robert Pape-positive things about social media" `
  -Title       "Robert Pape-positive things about social media" `
  -Caption     "Robert Pape-positive things about social media" `
  -Tags        war,usa,iran,ukraine,russia,podcast,viral
```

- `-VideoUrl` + `-Start`/`-End` → the clip that goes **on the bottom**
- `-GameplayUrl` → the footage **on top**; omit `-GameplayStart` and a random moment of the same length is used
- `-Name` → file name only; `-Title`/`-Caption`/`-Tags` are the upload metadata

### Upload a clip you already rendered

```powershell
.\make-and-post.ps1 -ExistingFile ".\myclip_split_captioned.mp4" `
  -Title "..." -Caption "..." -Tags a,b,c
```

### Render only, then upload later

```powershell
.\make-split.ps1 -Url "https://..." -Start 10:00 -End 10:45 -Name clip1
```

You can also double-click `make-and-post.bat` / `make-split.bat` and answer the prompts.

## Flags

### Render (passed through to `make-split.ps1`)

| Flag | Meaning |
|---|---|
| `-VideoUrl` / `-Url` | video that goes on the bottom |
| `-Start`, `-End` | the segment (`1:23:16`, `83:16` or seconds) |
| `-GameplayUrl` / `-MinecraftUrl` | gameplay that goes on top |
| `-GameplayStart` | starting point in the gameplay; omitted = random |
| `-Name` | base file name |
| `-Layout fill\|fit` | crop the clip, or letterbox it with a caption bar |
| `-CaptionPos 0.72` | caption vertical position (0 = top, 1 = bottom) |
| `-PodcastFocus 0.3` | crop the bottom video left/right of centre |
| `-SkipCaptions` | no Whisper, no burn-in |
| `-KeepFiles` | keep the intermediate downloads |
| `-CookiesFile`, `-Cookies firefox`, `-NoCookies` | YouTube sign-in handling |

### Upload

| Flag | Meaning |
|---|---|
| `-Title`, `-Caption`, `-Tags` | post metadata; prompted for if omitted |
| `-Platforms youtube,facebook` | limit which platforms run |
| `-Privacy public\|unlisted\|private` | publishing state |
| `-DryRun` | show exactly what would be posted, upload nothing |
| `-SkipUpload` | render only |
| `-ExistingFile` | upload a finished file, no render |

## What happens on each run

1. `yt-dlp` downloads **only** the chosen range of the bottom video (video + audio).
2. `yt-dlp` downloads a **same-length** range of the gameplay video (audio discarded).
3. `ffmpeg` stacks them into 1080×1920, gameplay on top.
4. Whisper transcribes the audio and burns word-by-word captions.
5. Temporary downloads are deleted; only `<Name>_split_captioned.mp4` remains.
6. The uploader probes the file, picks the right format per platform, and publishes.

## Platform limits worth knowing

| Clip length | YouTube | Instagram | Facebook | TikTok |
|---|---|---|---|---|
| ≤ 90s | Short | Reel | Reel | video/draft |
| 90s – 10 min | Short ≤180s, else video | unreliable | video (chunked) | video/draft |
| > 10 min | video | refused | video (chunked) | **refused** (600s cap) |

- **YouTube** allows ~6 uploads/day on the default API quota.
- **Instagram** ingests inside the upload request and fails non-deterministically near its limit; the uploader retries three times with progressively smaller encodes.
- **TikTok** before app audit can only deliver **drafts** to your inbox — you finish them in the app.

## Troubleshooting

| Message | Fix |
|---|---|
| `make-split.ps1 cannot be loaded ... not digitally signed` | `Get-ChildItem -Recurse -Filter *.ps1 \| Unblock-File` |
| `Cannot validate argument on parameter 'Layout'` | A value with spaces wasn't quoted. Wrap `-Name`, `-Title`, `-Caption` in `"..."` |
| `A positional parameter cannot be found` | Same cause — quote the value |
| `yt-dlp`/`ffmpeg`/`node` not found | Install it, then open a new terminal |
| Instagram `ProcessingFailedError` | The clip is too long/heavy for Instagram; trim it or drop Instagram for that clip |
| TikTok post not visible | It's a draft — open the app → Inbox (top right), or Profile → menu → Drafts |

## Security

- **`cookies.txt`** lets the tool download age-restricted YouTube videos using your login. It is a credential. It is gitignored — never commit or share it.
- **`clip-uploader/.creds/tokens.json`** holds OAuth tokens for your posting accounts. Also gitignored.
- Nothing is sent anywhere except the platforms you publish to.

## A note on copyright

Overlaying gameplay does **not** defeat Content ID — it fingerprints audio as well as video. If the underlying clip is someone else's content, a claim or strike lands on the channel that uploaded it, and repeated strikes terminate channels. This tool makes that loop faster, not safer. Decide deliberately what you publish with it.

## License

MIT — see [LICENSE](LICENSE).
