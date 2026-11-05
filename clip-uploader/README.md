# clip-uploader

Publish one finished video clip to **YouTube, Instagram, Facebook and TikTok** from a single command.

A local CLI for creators who edit clips and want them posted everywhere without opening four apps. No server, no third-party scheduler, no dependencies — your OAuth tokens stay on your own disk.

```
node upload.mjs upload --file "C:\clips\ep12.mp4" --title "1v4 clutch" --caption "Last alive." --tags gaming,clutch
```

```
youtube     uploaded   https://youtu.be/xxxxxxxxxxx
instagram   uploaded   https://www.instagram.com/reel/xxxxxxxxxxx/
facebook    uploaded   https://www.facebook.com/reel/xxxxxxxxxx
tiktok      uploaded   draft in your inbox (video.upload scope)
```
![whatitdoesSCREENSHOT](image.png)
---

## What it does

- **Probes the file first** with `ffprobe` and refuses a platform that would reject it anyway, instead of failing halfway through an upload.
- **Picks the right format per platform** — YouTube Short vs long-form video, Instagram Reel, Facebook Reel vs Page video.
- **Handles each platform's real upload protocol**, which is the whole point:
  - YouTube resumable session
  - Facebook Page video: simple multipart under 50 MB, chunked resumable upload above it (a single large POST returns `413`)
  - Facebook Reels: `video_reels` start → rupload → finish
  - Instagram Reels: resumable container, then poll until transcode finishes
  - TikTok: chunked upload following TikTok's round-down `total_chunk_count` rule
- **Works around platform quirks** discovered by testing against real accounts (see [Platform notes](#platform-notes)).
- **Never double-posts** — a local ledger keys uploads by absolute path + file size.
- **Explains its failures** in plain language, with platform error codes preserved.

## Requirements

- **Node 20+** (uses the built-in `fetch`, `FormData` and `fs.openAsBlob`)
- **ffmpeg + ffprobe** on your `PATH`
- No `npm install` — there are no dependencies

## Install

```bash
git clone https://github.com/<you>/clip-uploader.git
cd clip-uploader
node upload.mjs doctor
```

## Setup (once per platform)

Each platform needs your own developer app. This is unavoidable — they are *your* accounts, and no third party should hold the keys.

**Follow [SETUP.md](SETUP.md)** — it walks through Google Cloud, Meta for Developers and TikTok for Developers click by click, including the redirect URIs.

```bash
node upload.mjs auth youtube
node upload.mjs auth meta       # Facebook + Instagram together
node upload.mjs auth tiktok     # requires a public redirect page, see below
node upload.mjs doctor          # confirms all four are live
```

### TikTok needs a hosted redirect page

TikTok rejects `http://localhost` redirect URIs. `site/redirect.html` is a ready-made page that displays the authorization code so you can paste it back:

1. Host `site/redirect.html` anywhere with HTTPS (Netlify Drop, GitHub Pages, Cloudflare Pages).
2. Register that URL as the Login Kit redirect URI in your TikTok app.
3. `node upload.mjs auth tiktok --manual --redirect-uri https://your-site/redirect.html`

## Usage

```bash
node upload.mjs upload --file "C:\clips\ep12.mp4" \
  --title "Title for YouTube" \
  --caption "Caption for Instagram, TikTok and Facebook" \
  --tags gaming,clutch,viral
```

| Flag | Purpose |
|---|---|
| `--file <path>` | the clip (required) |
| `--title <text>` | YouTube title, max 100 chars |
| `--caption <text>` | Instagram / TikTok caption, Facebook description |
| `--caption-file <path>` | read the caption from a text file |
| `--description <text>` | longer YouTube description |
| `--tags a,b,c` | `#hashtags` for IG/TikTok, keywords for YouTube |
| `--platforms youtube,facebook` | limit which platforms run |
| `--privacy public\|unlisted\|private` | publishing state |
| `--dry-run` | show exactly what would be sent, upload nothing |
| `--force` | re-post something the ledger thinks is done |

### Other commands

```bash
node upload.mjs doctor                  # what is connected, what is missing
node upload.mjs help                    # all flags
node tools/check-shorts.mjs <videoId>   # is this YouTube video actually a Short?
node tools/tiktok-status.mjs <publishId># what happened to a TikTok upload?
node tests/smoke.mjs                    # offline test suite
```

## Format routing

| Clip | YouTube | Instagram | Facebook | TikTok |
|---|---|---|---|---|
| Vertical ≤ 90s | Short | Reel | Reel | Video / draft |
| Vertical 91–180s | Short | Reel | Video | Video / draft |
| Vertical > 180s | Video | Reel | Video | Video / draft |
| Horizontal | Video | refused (9:16 only) | Video | Video / draft |

## Platform notes

These are measured behaviours, not guesses — each cost a debugging session:

**YouTube** — uploading costs 1600 quota units against the default 10,000/day, so roughly **6 uploads per day**. Raise the quota in Google Cloud Console if you need more. Vertical clips ≤ 180s become Shorts automatically; `#Shorts` in the description is not required.

**Instagram** — ingestion happens *inside* the upload request and is bounded. Longer and larger clips must be downscaled, so the tool re-encodes a temporary copy for Instagram only (your master is untouched). Near the limit Instagram fails **non-deterministically** — the same geometry can pass one minute and fail the next — so the tool retries up to three times, each time with a slightly smaller encode.

**Facebook** — Page video uploads above ~50 MB get `HTTP 413` from `graph.facebook.com`. The tool switches to the dedicated `graph-video.facebook.com` host and a resumable session, where **Facebook dictates the chunk size** (1 MB at a time) via `start_offset`/`end_offset`.

**TikTok** — `total_chunk_count` must be `video_size / chunk_size` **rounded down**, and the final chunk absorbs the remainder. Rounding up is rejected with *"The total chunk count is invalid"*. Until your app passes TikTok's audit, posts can only reach your **inbox as drafts** — the tool finishes the upload and tells you where to look.

**TikTok Direct Post** — if your token carries `video.publish`, the tool tries Direct Post first and automatically falls back to the inbox draft when TikTok answers `unaudited_client_can_only_post_to_private_accounts`.

## Architecture

```
upload.mjs               CLI: arg parsing, routing, reporting, ledger
lib/probe.mjs            ffprobe validation + per-platform limits
lib/exec.mjs             subprocess capture via temp files (no pipe deadlocks)
lib/oauth.mjs            loopback server, PKCE, redirect parsing, browser launch
lib/http.mjs             fetch wrapper: retries, readable platform errors
lib/config.mjs           token storage, credential hygiene, upload ledger
lib/platforms/youtube.mjs
lib/platforms/meta.mjs   Facebook Page + Reels + Instagram
lib/platforms/tiktok.mjs Content Posting API
site/redirect.html       public OAuth redirect page for TikTok
tools/                   small diagnostics
tests/                   offline test suites
```

Tokens live in `.creds/tokens.json`, which is gitignored. Treat it like a password. Revoke access from the provider dashboards if it is ever exposed.

## Tests

```bash
node tests/smoke.mjs             # routing, validation, chunk maths, credential slicing
node tests/oauth.mjs             # loopback listener over IPv4 and IPv6, redirect parsing
node tests/facebook-chunked.mjs  # chunked Facebook upload against a stubbed network
node tests/check-meta-token.mjs  # is the stored Meta token still alive?
node tests/check-ig-fit.mjs <video>  # what would Instagram do with this clip?
```

The suites are offline by design: no credentials, no network, safe to run anywhere.

## Using this for other people

The **code** is shareable under MIT. The **apps are not** — here is the honest constraint:

- A Meta app in Development mode only works for accounts holding a role on it (you). Other people must create their own Meta app, or you take your app through App Review.
- A TikTok app before audit can only post to the account that owns it, as drafts. Others need their own app, or you go through TikTok's audit.
- YouTube has no such limit — the tool is genuinely usable by anyone who adds their own Google Cloud project.

So: share the repository, and point each person at [SETUP.md](SETUP.md). Do **not** share your `tokens.json`, your client secrets, or your `.creds` folder.

## License

MIT — see [LICENSE](LICENSE).
