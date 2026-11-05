// Meta (Facebook Page + Instagram Reels).
//
// One OAuth grant covers both. The app can stay in "Development" mode and still
// publish to a Page/IG account you administer - no App Review needed - because
// dev-mode apps may act on accounts that hold a role on the app.
//
// Both video paths use Meta's resumable "rupload" endpoint, so the file never
// has to be hosted at a public URL.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { request } from '../http.mjs';
import { capture } from '../exec.mjs';
import { startLoopback, browserHint, resolveRedirect, parseRedirectInput } from '../oauth.mjs';
import { updatePlatform, cleanCredential } from '../config.mjs';

export const GRAPH = 'https://graph.facebook.com/v21.0';
// Video uploads belong on the dedicated video host. Posting large bodies to
// graph.facebook.com hits its payload limit and fails with HTTP 413.
export const GRAPH_VIDEO = 'https://graph-video.facebook.com/v21.0';
const AUTH_URL = 'https://www.facebook.com/v21.0/dialog/oauth';
const SCOPES = [
  'pages_show_list',
  'pages_manage_posts',
  'pages_read_engagement',
  'instagram_basic',
  'instagram_content_publish',
  'business_management',
];

// ------------------------------------------------------------- auth ---------

async function graphGet(path, token, label) {
  const url = new URL(`${GRAPH}${path}`);
  // Callers may have already put access_token in the query; never double it.
  if (token && !url.searchParams.has('access_token')) url.searchParams.set('access_token', token);
  const { body } = await request(url.toString(), { label });
  return body;
}

/**
 * Mutating Graph calls MUST be POST. Sent as GET, several endpoints do not
 * error - they silently act as a list request and return {"data":[]}, which is
 * how /video_reels?upload_phase=start looked like a missing upload session.
 */
async function graphPost(path, token, label) {
  const url = new URL(`${GRAPH}${path}`);
  if (token && !url.searchParams.has('access_token')) url.searchParams.set('access_token', token);
  const { body } = await request(url.toString(), { label, method: 'POST' });
  return body;
}

export async function authenticate({ ask, log, args }) {
  const appId = cleanCredential(args['app-id'] ?? (await ask('Meta App ID: ')));
  const appSecret = cleanCredential(args['app-secret'] ?? (await ask('Meta App Secret: ')));
  if (!appId || !appSecret) throw new Error('Both the App ID and App Secret are required.');

  // 'localhost', not 127.0.0.1: Facebook rejects the raw IP for http redirects
  // and only tolerates localhost. Override with --redirect-uri if needed.
  const manual = Boolean(args.manual);
  const redirect = resolveRedirect(
    args['redirect-uri'],
    Number(args.port ?? 8721),
    '/callback',
    'localhost',
  );
  const { redirectUri, waitForCode, close } = await startLoopback({ ...redirect, timeoutMs: 180_000 });

  const state = Math.random().toString(36).slice(2);
  const url = `${AUTH_URL}?${new URLSearchParams({
    client_id: appId,
    redirect_uri: redirectUri,
    state,
    response_type: 'code',
    scope: SCOPES.join(','),
  })}`;

  log(`  redirect URI: ${redirectUri}`);
  log(browserHint(url, { open: !args['no-browser'] }));

  let code;
  if (manual) {
    close();
    log('--manual: approve in the browser, then copy the address bar of the page you land on');
    log('(it starts with ' + redirectUri + ' and contains code=...), or just the code.');
    const pasted = await ask('Redirect URL (or just the code): ');
    const parsed = parseRedirectInput(pasted);
    if (parsed.state && parsed.state !== state) {
      throw new Error('State mismatch - that URL came from a different authorization request. Re-run auth.');
    }
    code = parsed.code;
  } else {
    try {
      const result = await waitForCode();
      if (result.state !== state) throw new Error('State mismatch - the redirect did not come from this request.');
      code = result.code;
    } catch (err) {
      close();
      throw err;
    }
  }

  // Short-lived user token.
  const short = await graphGet(
    `/oauth/access_token?${new URLSearchParams({
      client_id: appId,
      client_secret: appSecret,
      redirect_uri: redirectUri,
      code,
    })}`,
    null,
    'Meta code exchange',
  );
  if (!short?.access_token) throw new Error('Meta did not return an access token.');

  // Swap for a 60-day token so the tool keeps working.
  const long = await graphGet(
    `/oauth/access_token?${new URLSearchParams({
      grant_type: 'fb_exchange_token',
      client_id: appId,
      client_secret: appSecret,
      fb_exchange_token: short.access_token,
    })}`,
    null,
    'Meta long-lived token exchange',
  );

  const userToken = long?.access_token ?? short.access_token;

  const pages = await graphGet('/me/accounts?fields=id,name,access_token,instagram_business_account', userToken, 'Meta pages');
  const list = pages?.data ?? [];
  if (!list.length) {
    // "No pages" has two very different causes; ask Meta which one applies.
    const perm = await graphGet('/me/permissions', userToken, 'Meta permissions').catch(() => null);
    const rows = perm?.data ?? [];
    const granted = rows.filter((r) => r.status === 'granted').map((r) => r.permission);
    const declined = rows.filter((r) => r.status !== 'granted').map((r) => r.permission);
    const canSeePages = granted.includes('pages_show_list');

    const lines = ['No Facebook Page was returned for this account.', ''];
    lines.push(`  granted : ${granted.length ? granted.join(', ') : '(none)'}`);
    if (declined.length) lines.push(`  declined: ${declined.join(', ')}`);
    lines.push('');
    if (!canSeePages) {
      lines.push('  Cause: pages_show_list was NOT granted. On the Facebook consent screen you must');
      lines.push('  expand the permissions and give access to your Page - the default is often "no Pages".');
      lines.push('  Re-run and use "Edit access" if the dialog offers it.');
    } else {
      lines.push('  Cause: the permission was granted but no Page came back, which means this Facebook');
      lines.push('  account does not administer a Page. A personal profile cannot be posted to.');
      lines.push('  Create one (free) at https://www.facebook.com/pages/create, then re-run.');
      lines.push('  Pick any name - it can match your channel.');
    }
    throw new Error(lines.join('\n'));
  }

  let page = list[0];
  if (args.page) {
    const wanted = String(args.page).toLowerCase();
    const found = list.find((p) => p.name.toLowerCase() === wanted) ?? list.find((p) => p.id === String(args.page));
    if (!found) throw new Error(`No Page named "${args.page}". Available: ${list.map((p) => p.name).join(', ')}`);
    page = found;
  } else if (list.length > 1) {
    log(`\nFound ${list.length} Pages: ${list.map((p, i) => `\n  ${i + 1}. ${p.name} (${p.id})`).join('')}`);
    const pick = await ask(`Which Page? [1-${list.length}] (default 1): `);
    page = list[Number(pick || 1) - 1] ?? list[0];
  }

  // Page tokens derived from a long-lived user token do not expire.
  const pageToken = page.access_token;

  let ig = null;
  try {
    const detail = await graphGet(
      `/${page.id}?fields=name,instagram_business_account{id,username}`,
      pageToken,
      'Meta page detail',
    );
    if (detail?.instagram_business_account) ig = detail.instagram_business_account;
  } catch { /* IG is optional; Facebook still works. */ }

  updatePlatform('meta', {
    app_id: appId,
    app_secret: appSecret,
    page_id: page.id,
    page_name: page.name,
    page_token: pageToken,
    user_token: userToken,
    token_expires_at: long?.expires_in ? Date.now() + long.expires_in * 1000 : null,
    ig_user_id: ig?.id ?? null,
    ig_username: ig?.username ?? null,
  });

  return { page: { id: page.id, name: page.name }, instagram: ig };
}

/**
 * Ask the Page for its linked Instagram account and cache the answer.
 * Done live because linking happens in Business Suite, long after auth - the
 * stored id would otherwise be stale until the next full re-authorisation.
 */
async function linkedInstagram(creds) {
  const page = await graphGet(
    `/${creds.page_id}?fields=instagram_business_account{id,username,followers_count,media_count}`,
    creds.page_token,
    'Meta page Instagram link',
  );
  const ig = page?.instagram_business_account ?? null;
  if (ig?.id) {
    if (ig.id !== creds.ig_user_id) updatePlatform('meta', { ig_user_id: ig.id, ig_username: ig.username ?? null });
  } else if (creds.ig_user_id) {
    // The link was removed in Business Suite.
    updatePlatform('meta', { ig_user_id: null, ig_username: null });
  }
  return ig;
}

export async function status(creds) {
  const page = await graphGet(
    `/${creds.page_id}?fields=name,fan_count,instagram_business_account{id,username,followers_count,media_count}`,
    creds.page_token,
    'Meta page check',
  );
  let ig = page?.instagram_business_account ?? null;
  if (ig?.id && ig.id !== creds.ig_user_id) {
    updatePlatform('meta', { ig_user_id: ig.id, ig_username: ig.username ?? null });
  }
  return { page, instagram: ig };
}

// ------------------------------------------------------- facebook video -----

/** Short vertical clips go to Reels; anything else to a normal Page video. */
export async function publishFacebookReel({ clip, meta, creds, log }) {
  const start = await graphPost(
    `/${creds.page_id}/video_reels?${new URLSearchParams({
      upload_phase: 'start',
      file_size: String(clip.sizeBytes),
      access_token: creds.page_token,
    })}`,
    null,
    'Facebook Reel start',
  );
  if (!start?.video_id || !start?.upload_url) {
    throw new Error(`Facebook did not return a Reel upload session. Response: ${JSON.stringify(start).slice(0, 400)}`);
  }

  log('  uploading to Facebook Reels ...');
  const blob = await fs.openAsBlob(clip.path, { type: 'video/mp4' });
  await fetch(start.upload_url, {
    method: 'POST',
    headers: {
      Authorization: `OAuth ${creds.page_token}`,
      offset: '0',
      file_size: String(clip.sizeBytes),
      'Content-Type': 'application/octet-stream',
    },
    body: blob,
    signal: AbortSignal.timeout(30 * 60_000),
  }).then(async (r) => {
    if (!r.ok) throw new Error(`Facebook Reel upload failed: ${r.status} ${(await r.text()).slice(0, 400)}`);
  });

  const finish = await graphPost(
    `/${creds.page_id}/video_reels?${new URLSearchParams({
      upload_phase: 'finish',
      video_id: start.video_id,
      video_state: meta.privacy === 'unlisted' ? 'DRAFT' : 'PUBLISHED',
      description: meta.caption ?? meta.description ?? '',
      ...(meta.title ? { title: meta.title } : {}),
      access_token: creds.page_token,
    })}`,
    null,
    'Facebook Reel finish',
  );
  if (finish?.success === false) {
    throw new Error(`Facebook rejected the Reel at the finish step: ${JSON.stringify(finish).slice(0, 400)}`);
  }

  return { id: start.video_id, url: `https://www.facebook.com/reel/${start.video_id}` };
}

export async function publishFacebookVideo({ clip, meta, creds, log }) {
  const caption = meta.caption ?? meta.description ?? '';
  const SIMPLE_LIMIT = 50 * 1024 * 1024;

  if (clip.sizeBytes <= SIMPLE_LIMIT) {
    log('  uploading to Facebook Page video ...');
    const form = new FormData();
    form.append('description', caption);
    if (meta.title) form.append('title', meta.title);
    form.append('source', await fs.openAsBlob(clip.path, { type: 'video/mp4' }), clip.fileName);

    const { body } = await request(`${GRAPH_VIDEO}/${creds.page_id}/videos`, {
      label: 'Facebook video upload',
      method: 'POST',
      retries: 1,
      timeoutMs: 30 * 60_000,
      headers: { Authorization: `Bearer ${creds.page_token}` },
      body: form,
    });
    return { id: body?.id, url: body?.id ? `https://www.facebook.com/${body.id}` : null };
  }

  // Large files: Meta's resumable session (start -> transfer chunks -> finish).
  // A single multipart POST gets HTTP 413 once the body is around 100 MB.
  log(`  uploading ${clip.sizeMb.toFixed(0)} MB to Facebook in chunks ...`);
  const start = await graphPost(
    `/${creds.page_id}/videos?${new URLSearchParams({
      upload_phase: 'start',
      file_size: String(clip.sizeBytes),
      access_token: creds.page_token,
    })}`,
    null,
    'Facebook video start',
  );
  const sessionId = start?.upload_session_id;
  if (!sessionId || !start?.video_id) {
    throw new Error(`Facebook did not start an upload session. Response: ${JSON.stringify(start).slice(0, 400)}`);
  }

  // Both offsets move: Facebook returns the next range after every chunk.
  let endOffset = Number(start.end_offset ?? clip.sizeBytes);
  let offset = Number(start.start_offset ?? 0);
  const handle = await fs.promises.open(clip.path, 'r');
  let chunkNo = 0;

  try {
    while (offset < endOffset) {
      // Facebook decides how much to accept per request: it returns
      // start_offset/end_offset and expects exactly that range next. Sending a
      // self-chosen chunk size is rejected.
      const length = endOffset - offset;
      const buf = Buffer.allocUnsafe(length);
      await handle.read(buf, 0, length, offset);

      const form = new FormData();
      form.append('upload_phase', 'transfer');
      form.append('start_offset', String(offset));
      form.append('upload_session_id', sessionId);
      form.append('access_token', creds.page_token);
      form.append('video_file_chunk', new Blob([buf], { type: 'application/octet-stream' }), 'chunk.bin');

      const res = await fetch(`${GRAPH_VIDEO}/${start.video_id}`, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(10 * 60_000),
      });
      const text = await res.text();
      chunkNo++;
      if (!res.ok) {
        throw new Error(`Facebook chunk ${chunkNo} failed at offset ${offset}: ${res.status} ${text.slice(0, 300)}`);
      }

      let next = {};
      try {
        next = JSON.parse(text);
      } catch { /* finish-style responses may be empty */ }

      const prevOffset = offset;
      offset = Number(next.start_offset ?? offset + length);
      endOffset = Number(next.end_offset ?? endOffset);
      if (offset <= prevOffset) {
        throw new Error(`Facebook upload stalled at ${offset} bytes (session ${sessionId}).`);
      }
      if (offset > clip.sizeBytes) {
        throw new Error(`Facebook asked for offset ${offset}, beyond the ${clip.sizeBytes}-byte file.`);
      }
      if (chunkNo % 20 === 0) {
        log(`    ${(offset / 1024 / 1024).toFixed(0)} / ${(clip.sizeBytes / 1024 / 1024).toFixed(0)} MB`);
      }
    }
  } finally {
    await handle.close();
  }

  const finish = await graphPost(
    `/${creds.page_id}/videos?${new URLSearchParams({
      upload_phase: 'finish',
      upload_session_id: sessionId,
      description: caption,
      ...(meta.title ? { title: meta.title } : {}),
      access_token: creds.page_token,
    })}`,
    null,
    'Facebook video finish',
  );
  if (finish?.success === false) {
    throw new Error(`Facebook rejected the video at the finish step: ${JSON.stringify(finish).slice(0, 400)}`);
  }

  const id = start.video_id;
  return { id, url: id ? `https://www.facebook.com/${id}` : null };
}

// ---------------------------------------------------- instagram reels -------
//
// Instagram ingests a Reel synchronously inside the upload request, and that
// work is bounded. Measured against a real account:
//
//   1080x1920  30s  (1.87 G pixel-frames)  -> FINISHED in 24.7s
//   1080x1920  45s  (2.80 G)               -> ProcessingFailedError
//   1080x1920  60s  (3.73 G)               -> ProcessingFailedError
//   1080x1920  66s  (4.11 G)               -> ProcessingFailedError
//    720x1280  66s  (1.82 G)               -> FINISHED in 24.7s
//
// So the constraint is pixels x frames, not duration, size or bitrate. Stay
// under the budget and long vertical clips upload fine.
// Instagram's ingest budget tightens as clips get longer (measured on a real
// account). Under ~90s the ceiling is higher than for very long ones:
//
//   1080x1920  30s  1.87 G  OK      480x854  135s  1.66 G  OK
//    720x1280  66s  1.82 G  OK      506x900  135s  1.85 G  FAIL
//                                   540x960  135s  2.33 G  FAIL
//
// Duration is NOT a hard limit - a 135s clip ingests fine once it is small
// enough. These two budgets are the safe side of the measurements.
export const IG_PIXEL_FRAME_BUDGET = 1.85e9;
export const IG_LONG_CLIP_BUDGET = 1.6e9;
export const IG_LONG_CLIP_SECONDS = 90;

// Below this width the Reel is too degraded to be worth posting; past it, the
// clip is too long to fit Instagram at all.
export const IG_MIN_WIDTH = 360;

export function instagramBudgetFor(duration) {
  return Number(duration) > IG_LONG_CLIP_SECONDS ? IG_LONG_CLIP_BUDGET : IG_PIXEL_FRAME_BUDGET;
}

/**
 * Scale factor (<= 1) that brings a clip inside Instagram's ingest budget.
 * Returns 1 when the clip already fits, so no transcode is needed.
 */
/**
 * Scale factor for Instagram: 1 means "upload as-is".
 * A downscale below 0.98 would be a pointless quality loss, so near-misses are
 * treated as fitting.
 */
export function instagramScaleFactor({ width, height, fps, fpsNum, duration }) {
  const rate = Number(fpsNum) || Number(fps) || 30;
  const secs = Number(duration) || 0;
  const pixelFrames = (width || 0) * (height || 0) * rate * secs;
  if (!pixelFrames || pixelFrames <= instagramBudgetFor(secs)) return 1;
  const factor = Math.sqrt(instagramBudgetFor(secs) / pixelFrames);
  return factor >= 0.98 ? 1 : factor;
}

/**
 * Produce an Instagram-uploadable file. Most clips pass through untouched;
 * oversized ones are downscaled just enough to fit the budget.
 */
export async function fitForInstagram(clip, log, { tighten = 1 } = {}) {
  const base = instagramScaleFactor(clip);
  // tighten < 1 is used on retries: Instagram's refusal near its ingest limit
  // is not deterministic, so a slightly different encode can slip through where
  // the identical one failed.
  const factor = Math.min(1, base) * tighten;
  if (factor >= 0.98) return { path: clip.path, sizeBytes: clip.sizeBytes, scaled: false };

  const even = (n) => Math.max(2, Math.floor(n / 2) * 2);
  const width = even(clip.width * factor);
  const height = even(clip.height * factor);
  const out = path.join(os.tmpdir(), `clip-uploader-ig-${process.pid}-${Date.now()}.mp4`);

  // Refuse only when fitting would degrade the clip beyond usefulness.
  if (width < IG_MIN_WIDTH) {
    throw new Error(
      `This clip is too long for Instagram to ingest: ${clip.duration.toFixed(0)}s.\n` +
        `  Fitting it would mean shrinking to ${width}x${height}, below any usable resolution.\n` +
        '  Options:\n' +
        '    - trim / split the clip\n' +
        '    - skip Instagram for this one: --platforms youtube,facebook,tiktok',
    );
  }

  log(`  clip is too large for Instagram to ingest (${clip.width}x${clip.height}, ${clip.duration.toFixed(0)}s)`);
  log(`  downscaling to ${width}x${height} for this upload only ...`);

  const res = capture(
    'ffmpeg',
    [
      '-y', '-v', 'error',
      '-i', clip.path,
      '-vf', `scale=${width}:${height}`,
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-b:v', '4M',
      '-maxrate', '5M',
      '-bufsize', '10M',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-b:a', '96k',
      '-movflags', '+faststart',
      out,
    ],
    { timeoutMs: 15 * 60_000 },
  );

  if (res.status !== 0) {
    throw new Error(`Could not prepare the clip for Instagram (ffmpeg failed): ${(res.stderr || '').trim().slice(0, 300)}`);
  }
  return { path: out, sizeBytes: fs.statSync(out).size, scaled: true, width, height };
}

export async function publishInstagramReel({ clip, meta, creds, log }) {
  // Resolve the link live: you can connect Instagram in Business Suite at any
  // time, and it should not require re-authorising the whole app.
  let igUserId = creds.ig_user_id;
  if (!igUserId) {
    const ig = await linkedInstagram(creds).catch(() => null);
    igUserId = ig?.id ?? null;
  }
  if (!igUserId) {
    throw new Error(
      'No Instagram account is linked to this Page, so there is nothing to post to.\n' +
        '  Fix: business.facebook.com -> Settings -> Accounts -> Instagram accounts -> Add\n' +
        '  The Instagram account must be Creator or Business (not personal), and the link is\n' +
        '  made from the Page. Once linked, just re-run this upload - no re-auth needed.',
    );
  }

  // Instagram ingests inside the upload request; shrink oversized clips first.
  // Near its ingest limit Instagram fails non-deterministically: the same
  // geometry can succeed one minute and fail the next (measured: 480x854 passed
  // while 470x838 failed). So each retry re-encodes a little smaller rather than
  // resending identical bytes that already failed.
  const MAX_ATTEMPTS = 3;
  let containerId = null;
  let lastError = null;
  let fitted = null;

  try {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const tighten = Math.pow(0.92, attempt - 1);
      if (fitted?.scaled) {
        try {
          fs.unlinkSync(fitted.path);
        } catch { /* best effort */ }
      }
      fitted = await fitForInstagram(clip, log, { tighten });

      try {
        const create = await graphPost(
          `/${igUserId}/media?${new URLSearchParams({
            media_type: 'REELS',
            upload_type: 'resumable',
            caption: meta.caption ?? meta.description ?? '',
            share_to_feed: 'true',
            access_token: creds.page_token,
          })}`,
          null,
          'Instagram Reel container',
        );
        containerId = create?.id;
        const uploadUrl = create?.uri;
        if (!containerId || !uploadUrl) {
          throw new Error(
            `Instagram did not return a container id + upload URI. Response: ${JSON.stringify(create).slice(0, 400)}`,
          );
        }

        log(`  uploading to Instagram${attempt > 1 ? ` (attempt ${attempt}/${MAX_ATTEMPTS})` : ''} ...`);
        const blob = await fs.openAsBlob(fitted.path, { type: 'video/mp4' });
        const upRes = await fetch(uploadUrl, {
          method: 'POST',
          headers: {
            Authorization: `OAuth ${creds.page_token}`,
            offset: '0',
            file_size: String(fitted.sizeBytes),
            'Content-Type': 'application/octet-stream',
          },
          body: blob,
          signal: AbortSignal.timeout(30 * 60_000),
        });
        if (!upRes.ok) {
          const detail = (await upRes.text()).slice(0, 400);
          const err = new Error(`Instagram upload failed: ${upRes.status} ${detail}`);
          err.ingestRefused = /ProcessingFailedError|ProcessingFailed|PartialRequest/.test(detail);
          throw err;
        }

        log('  waiting for Instagram to finish processing ...');
        const deadline = Date.now() + 8 * 60_000;
        let lastStatus = 'IN_PROGRESS';
        while (Date.now() < deadline) {
          const st = await graphGet(`/${containerId}?fields=status_code,status`, creds.page_token, 'Instagram status');
          lastStatus = st?.status_code ?? lastStatus;
          if (lastStatus === 'FINISHED') break;
          if (lastStatus === 'ERROR' || lastStatus === 'EXPIRED') {
            const err = new Error(`Instagram could not process this video (status: ${lastStatus}).`);
            err.ingestRefused = true;
            throw err;
          }
          await new Promise((r) => setTimeout(r, 5000));
        }
        if (lastStatus !== 'FINISHED') throw new Error(`Instagram still processing after 8 minutes (${lastStatus}).`);

        lastError = null;
        break;
      } catch (err) {
        lastError = err;
        if (!err.ingestRefused) throw err;
        if (attempt === MAX_ATTEMPTS) break;
        log(`  Instagram refused the file (attempt ${attempt}/${MAX_ATTEMPTS}) - retrying with a smaller encode ...`);
        await new Promise((r) => setTimeout(r, 8000));
      }
    }

    if (lastError) {
      throw new Error(
        `${lastError.message}\n` +
          `  Instagram rejected this clip ${MAX_ATTEMPTS} times. It is at the edge of what Instagram will\n` +
          `  ingest (${fitted.scaled ? `${fitted.width}x${fitted.height}` : `${clip.width}x${clip.height}`}, ${clip.duration.toFixed(0)}s).\n` +
          '  Instagram is unreliable this long; trimming it is the dependable fix.',
      );
    }

    const published = await graphPost(
      `/${igUserId}/media_publish?${new URLSearchParams({
        creation_id: containerId,
        access_token: creds.page_token,
      })}`,
      null,
      'Instagram publish',
    );
    if (!published?.id) {
      throw new Error(`Instagram did not confirm the publish. Response: ${JSON.stringify(published).slice(0, 400)}`);
    }

    const id = published.id;
    const info = await graphGet(`/${id}?fields=permalink`, creds.page_token, 'Instagram permalink').catch(() => null);

    return {
      id,
      url: info?.permalink ?? (creds.ig_username ? `https://www.instagram.com/${creds.ig_username}/` : null),
      note: fitted.scaled
        ? `Uploaded a ${fitted.width}x${fitted.height} copy (downscaled to fit Instagram's ingest limit)`
        : undefined,
    };
  } finally {
    if (fitted?.scaled) {
      try {
        fs.unlinkSync(fitted.path);
      } catch { /* temp file, best effort */ }
    }
  }
}

export default {
  name: 'meta',
  label: 'Meta',
  authenticate,
  status,
  publishFacebookReel,
  publishFacebookVideo,
  publishInstagramReel,
};
