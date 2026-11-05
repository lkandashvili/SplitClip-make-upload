# clip-uploader — setup guide

One command publishes a finished clip to YouTube, Instagram, Facebook and TikTok.
Everything runs on your PC. No server, no third-party service, your tokens never leave your machine.

Node and ffmpeg are already installed, so there is nothing to `npm install` — this tool has **zero dependencies**.

---

## Before you start: the two account facts that decide everything

**Instagram.** The Instagram API can only publish to a **Business or Creator** account that is **linked to a Facebook Page**. A personal Instagram account cannot be automated at all — not by this tool, not by Buffer, not by anyone. Check and, if needed, convert:

> Instagram app → your profile → ☰ → **Settings and activity** → **Account type and tools** → **Switch to professional account** → choose **Creator** (or Business).
> Then link it: Meta Business Suite → **Settings** → **Accounts** → **Instagram accounts** → **Add**.

If it already says "Professional account", you are set.

**Facebook.** You need a **Page you administer**, not a personal profile. Personal profiles have no posting API. Create one free at facebook.com/pages/create if you do not have one — the name can be your channel name.

**TikTok.** Until your developer app passes TikTok's audit, every post is forced to **private** (`SELF_ONLY`) — it lands in your drafts and you tap Post in the app. That is a TikTok rule, not a limitation of this tool. Fine for now; you can request the audit later.

---

## Step 1 — YouTube

1. Go to https://console.cloud.google.com/ and sign in with the Google account that owns your channel.
2. Top bar → project dropdown → **New project** → name it `clip-uploader` → **Create**. Make sure the new project is selected.
3. Left menu → **APIs & Services** → **Library** → search `YouTube Data API v3` → **Enable**.
4. Left menu → **APIs & Services** → **OAuth consent screen**:
   - User type **External** → **Create**
   - App name `clip-uploader`, your email for both contact fields → **Save and continue**
   - Scopes: just **Save and continue** (no need to add any)
   - Test users: **Add users** → add your own Gmail address → **Save**
5. Left menu → **APIs & Services** → **Credentials** → **Create credentials** → **OAuth client ID**:
   - Application type: **Desktop app**
   - Name: `clip-uploader` → **Create**
   - Copy the **Client ID** and **Client secret**
> **You will not find an "Authorized redirect URIs" box** — Desktop-app clients do not have one. Google accepts the loopback address automatically, but it must be **`localhost`**, not `127.0.0.1`: the raw IP is rejected with `Error 400: invalid_request`. This tool sends `http://localhost:8720/oauth2callback`. If your browser still shows that error, jump to *When authorization fails* below.

6. Run it:

```
cd "C:\Users\lkand\OneDrive\Documents\deepseek-harness\default-workspace\clip-uploader"
node upload.mjs auth youtube
```

Paste the Client ID, then the secret. Your browser opens; pick your channel's Google account and approve. The terminal should say `youtube connected`.

> **Quota warning:** uploading costs 1600 units of a 10,000/day free quota — about **6 uploads per day**. If you post more, request a quota increase in Google Cloud Console (APIs & Services → YouTube Data API v3 → Quotas), or stagger posts.

---

## Step 2 — Facebook + Instagram (one authorization covers both)

1. Go to https://developers.facebook.com/ → **My apps** → **Create app**.
2. Choose **Other** → **Business** → name it `clip-uploader` → **Create app**.
3. On the app dashboard, find **Facebook Login** → **Set up** → choose **Web**.
4. Left menu → **Facebook Login** → **Settings** → in **Valid OAuth Redirect URIs** paste exactly:

```
http://localhost:8721/callback
```

→ **Save changes**. (The port must match; if you change `--port`, change this too.)

5. Left menu → **App settings** → **Basic**: copy the **App ID** and **App secret** (click *Show*).
6. Leave the app in **Development** mode. This is intentional and important: in Development mode the app works for accounts that hold a role on it — i.e. you — so you do **not** need App Review. Do not switch to Live without re-reading Step 2 notes below.
7. Run it:

```
node upload.mjs auth meta
```

Paste the App ID and secret, approve in the browser, then pick your Page when asked (or pass `--page "Your Page Name"`).

### If it complains about permissions
- `pages_manage_posts` / `instagram_content_publish` work without review **only** for accounts with a role on the app. Confirm you are listed: **App roles** → **Roles** → your account should be **Administrator**.
- Instagram publishing additionally needs the IG account to be professional **and** linked to the Page. `node upload.mjs doctor` prints whether it found a linked IG account.

### Token lifetime
The Page token this tool stores does not expire as long as you keep using the tool. If you see an expired-token error months from now, just re-run `node upload.mjs auth meta`.

---

## Step 3 — TikTok

1. Go to https://developers.tiktok.com/ → sign in with your TikTok account → **Manage apps** → **Connect an app** (or *Create app*).
2. Name it `clip-uploader`. Under **Products**, add **Login Kit** and **Content Posting API**.
3. In **Login Kit** → **Redirect URI**, register your **public https page** — TikTok rejects `localhost` and `127.0.0.1` outright:

```
https://YOUR-SITE/redirect.html
```

   That is `site/redirect.html` from this project. Host it first (Netlify Drop / GitHub Pages) and confirm it loads in a browser. The page simply displays the authorization code so you can paste it back.

4. In **Content Posting API** / **Scopes**, ensure the **`video.upload`** scope is added (this is the draft scope that works before audit).
5. Copy the **Client key** and **Client secret** from the app's basic info — and if the app has not passed review, use the **Sandbox** tab's key pair, not Production.
6. Add your own TikTok account as a **target user / sandbox tester** if the dashboard asks — before audit, only listed accounts can post.
7. Run it, passing your public redirect page:

```
node upload.mjs auth tiktok --manual --redirect-uri https://YOUR-SITE/redirect.html
```

   Approve in the browser. TikTok sends you to `redirect.html`, which shows a one-time code with a copy button. Paste it at the terminal prompt.

> **Why `--manual`:** without it the tool waits for the browser to reach a listener on your own machine. TikTok will not redirect to localhost at all, so there is nothing local to catch. `redirect.html` replaces the listener, and the code travels by clipboard instead.

---

## When authorization fails

**Google shows "Required parameter is missing: response_type" (or `redirect_uri`).**
The browser received a **truncated** URL, not a bad one. Windows used to launch it with `cmd /c start`, and `cmd` treats the `&` between query parameters as a command separator — so everything after `client_id` was cut off. Fixed in 0.2.1 by launching without a shell. If you still see it, copy the URL yourself:

```powershell
node upload.mjs auth youtube --no-browser
```

That prints the URL instead of opening it. Copy the whole thing (it is one line, even when it wraps), paste it into your browser, approve, and the terminal catches the redirect as usual. If the page after approving fails to load, use `--manual` and paste the address bar contents instead.

**Google shows `Error 400: invalid_request` (with `flowName=GeneralOAuthFlow`).**
Google rejects `http://127.0.0.1` for Desktop-app clients; it wants `http://localhost`. This version already sends localhost. If it still happens, force it and switch to the paste fallback:

```powershell
node upload.mjs auth youtube --redirect-uri http://localhost:8720/oauth2callback --manual
```

`--manual` means the browser never has to reach your PC at all. Approve, then copy the **entire address bar** of the page you land on — even if that page shows an error — and paste it at the prompt. It only needs to contain `code=`.

**`redirect_uri_mismatch` (Meta).** The URI under Facebook Login → Settings must match character for character, port included: `http://localhost:8721/callback`.

**It just sits there and times out after 3 minutes.** The browser never redirected back, which always means the provider refused the redirect. Same fix: add `--manual`.

**`The OAuth client was not found` / `invalid_client`.** The ID or secret is wrong, or belongs to a different Google Cloud project than the one where you enabled the YouTube Data API.

## Step 4 — Verify

```
node upload.mjs doctor
```

You want `OK` on all four lines (YouTube, Facebook, Instagram, TikTok). Anything marked `SKIP` tells you the exact command to run next.

---

## Daily use

```powershell
cd "C:\Users\lkand\OneDrive\Documents\deepseek-harness\default-workspace\clip-uploader"

node upload.mjs upload --file "C:\Users\lkand\Videos\clips\ep12_clutch.mp4" `
  --title "1v4 clutch that should not have worked" `
  --caption "Last alive, no util, full team wipe." `
  --tags valorant,clutch,gaming
```

That uploads to all four platforms, choosing the right format automatically:

| Your clip | YouTube | Instagram | Facebook | TikTok |
|---|---|---|---|---|
| Vertical, ≤ 90s | Short | Reel | Reel | Video |
| Vertical, 91s–180s | Short | Reel | Video | Video |
| Vertical, > 180s | Video | Reel | Video | Video |
| Horizontal | Video | Reel (blocked — see below) | Video | Video |

### Useful variations

```powershell
# only some platforms
--platforms youtube,tiktok

# don't actually post, just show the payload
--dry-run

# re-post a file you already uploaded (the log normally blocks duplicates)
--force

# long caption from a text file (hashtags, line breaks, the works)
--caption-file "C:\clips\ep12_caption.txt"

# private / unlisted
--privacy unlisted
```

### Why a platform sometimes refuses
The tool checks the file with ffprobe **before** uploading and blocks a platform rather than wasting your time:

- Instagram Reels are 9:16 — a horizontal clip is refused because it would be letterboxed into a tiny strip.
- Instagram minimum 3s; TikTok maximum 10 min and MP4/MOV only.
- No audio → warning, not a block.

### What gets remembered
`.creds/uploads.jsonl` logs every upload by absolute path + file size. Re-running the same command says `already uploaded … use --force to redo`, so you cannot double-post by accident.

---

## Files

```
clip-uploader/
  upload.mjs              the CLI
  lib/probe.mjs           ffprobe validation + platform limits
  lib/exec.mjs            subprocess capture
  lib/oauth.mjs           local browser-login helper
  lib/http.mjs            retries + readable errors
  lib/platforms/*.mjs     one file per platform
  tests/smoke.mjs         14 offline checks (node tests/smoke.mjs)
  tests/oauth.mjs         13 offline OAuth/loopback checks
  .creds/tokens.json      YOUR TOKENS - never share or commit this
  .creds/uploads.jsonl    upload history
```

## Security notes

- Tokens live in `.creds/tokens.json`, which is gitignored. Treat that file like a password.
- The OAuth listener binds to `127.0.0.1` only and shuts down after the code arrives.
- All accounts see the same thing: whoever holds these tokens can post as you. If you ever suspect exposure, revoke in the platform dashboards (Google: myaccount.google.com/permissions; Meta: Business Integrations; TikTok: app settings) and re-auth.
