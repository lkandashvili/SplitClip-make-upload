// TikTok Content Posting API v2.
//
// Current reality: until your developer app passes TikTok's audit, posts are
// forced to privacy_level=SELF_ONLY (a private draft in your inbox) no matter
// what you request. This module is wired for both; `meta.tiktokScope` decides.

import fs from 'node:fs';
import { request } from '../http.mjs';
import { startLoopback, browserHint, pkcePair, randomString, resolveRedirect, parseRedirectInput } from '../oauth.mjs';
import { updatePlatform, cleanCredential } from '../config.mjs';

const AUTH_URL = 'https://www.tiktok.com/v2/auth/authorize/';
const TOKEN_URL = 'https://open.tiktokapis.com/v2/oauth/token/';
const INIT_URL = 'https://open.tiktokapis.com/v2/post/publish/video/init/'; // Direct Post, needs video.publish
const INBOX_INIT_URL = 'https://open.tiktokapis.com/v2/post/publish/inbox/video/init/'; // draft, needs video.upload
const STATUS_URL = 'https://open.tiktokapis.com/v2/post/publish/status/fetch/';
// Only fields covered by user.info.basic. Asking for `username` needs
// user.info.profile, and TikTok rejects the entire request without it.
const USER_URL = 'https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name,avatar_url';

const TEN_MB = 10 * 1024 * 1024;
const MIN_CHUNK = 5 * 1024 * 1024;
const MAX_CHUNK = 64 * 1024 * 1024;

export async function accessToken(creds, { force = false } = {}) {
  if (!creds?.client_key || !creds?.client_secret) {
    throw new Error('TikTok credentials are incomplete (no client key/secret stored). Re-run: node upload.mjs auth tiktok');
  }
  const now = Date.now();
  if (!force && creds.access_token && creds.expires_at && creds.expires_at - 120_000 > now) {
    return creds.access_token;
  }
  if (!creds.refresh_token) throw new Error('TikTok: no refresh token stored. Run: node upload.mjs auth tiktok');

  const { body } = await request(TOKEN_URL, {
    label: 'TikTok token refresh',
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_key: creds.client_key,
      client_secret: creds.client_secret,
      grant_type: 'refresh_token',
      refresh_token: creds.refresh_token,
    }).toString(),
  });
  if (!body?.access_token) {
    throw new Error(`TikTok refresh failed: ${body?.error_description ?? body?.error ?? 'unknown error'}`);
  }

  updatePlatform('tiktok', {
    access_token: body.access_token,
    refresh_token: body.refresh_token ?? creds.refresh_token,
    expires_at: Date.now() + (body.expires_in ?? 86400) * 1000,
    refresh_expires_at: body.refresh_expires_in
      ? Date.now() + body.refresh_expires_in * 1000
      : creds.refresh_expires_at,
  });
  return body.access_token;
}

export async function authenticate({ ask, log, args }) {
  const clientKey = cleanCredential(args['client-key'] ?? (await ask('TikTok Client Key: ')));
  const clientSecret = cleanCredential(args['client-secret'] ?? (await ask('TikTok Client Secret: ')));
  if (!clientKey || !clientSecret) throw new Error('Both the Client Key and Secret are required.');

  const manual = Boolean(args.manual);
  const explicitRedirect = typeof args['redirect-uri'] === 'string' ? args['redirect-uri'] : null;

  // TikTok refuses http://localhost redirect URIs, so a public https page is
  // the only option. That rules out a local listener: the code is displayed by
  // that page and pasted back here (--manual).
  let redirectUri;
  let waitForCode = null;
  let close = () => {};

  if (manual) {
    if (!explicitRedirect) {
      throw new Error(
        'TikTok does not accept localhost redirect URIs, so --manual needs a public one:\n' +
          '  node upload.mjs auth tiktok --manual --redirect-uri https://YOUR-SITE/redirect.html',
      );
    }
    redirectUri = explicitRedirect;
  } else {
    const redirect = resolveRedirect(explicitRedirect, Number(args.port ?? 8722), '/callback');
    if (redirect.host !== '127.0.0.1' && redirect.host !== 'localhost') {
      throw new Error(
        `Cannot catch a redirect to ${redirect.host} with a local listener. Add --manual to paste the code instead.`,
      );
    }
    const started = await startLoopback({ ...redirect, timeoutMs: 180_000 });
    redirectUri = started.redirectUri;
    waitForCode = started.waitForCode;
    close = started.close;
  }

  const { verifier, challenge } = pkcePair();
  const state = randomString(16);
  // video.upload = draft to inbox (works pre-audit). video.publish = direct post.
  const scope = args.scope ?? 'user.info.basic,video.upload';

  const url = `${AUTH_URL}?${new URLSearchParams({
    client_key: clientKey,
    scope,
    response_type: 'code',
    redirect_uri: redirectUri,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  })}`;

  log(`  redirect URI: ${redirectUri}`);
  log(browserHint(url, { open: !args['no-browser'] }));

  let code;
  if (manual) {
    log(`--manual: approve in the browser. TikTok will send you to ${redirectUri}`);
    log('which displays a one-time code. Copy it (or the whole address bar) and paste it here.');
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
      throw new Error(
        `${err.message}\n\n` +
          'TikTok rejected the authorization after login. Most likely causes:\n' +
          '  1. Wrong client_key - or the Production key used while the app is still pending review.\n' +
          '     Unreviewed apps must use the SANDBOX key pair; Sandbox and Production keys differ.\n' +
          '  2. The TikTok account you are signed in as is not a test user for this app.\n' +
          '     In Sandbox, add your account as a test user first.\n' +
          `  3. The redirect URI is not registered exactly as: ${redirectUri}`,
      );
    }
  }

  const { body } = await request(TOKEN_URL, {
    label: 'TikTok code exchange',
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_key: clientKey,
      client_secret: clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }).toString(),
  });

  if (!body?.access_token) {
    throw new Error(`TikTok code exchange failed: ${body?.error_description ?? body?.error ?? 'unknown error'}`);
  }

  updatePlatform('tiktok', {
    client_key: clientKey,
    client_secret: clientSecret,
    access_token: body.access_token,
    refresh_token: body.refresh_token,
    open_id: body.open_id,
    scope: body.scope,
    expires_at: Date.now() + (body.expires_in ?? 86400) * 1000,
    refresh_expires_at: Date.now() + (body.refresh_expires_in ?? 31536000) * 1000,
  });

  const user = await whoami(body.access_token).catch(() => null);
  if (user) updatePlatform('tiktok', { display_name: user.display_name, avatar_url: user.avatar_url });
  return user;
}

export async function whoami(token) {
  try {
    const { body } = await request(USER_URL, {
      label: 'TikTok user lookup',
      headers: { Authorization: `Bearer ${token}` },
    });
    return body?.data?.user ?? null;
  } catch (err) {
    // A token without user.info.basic is still perfectly usable for posting.
    if (err?.body?.error?.code === 'scope_not_authorized') return null;
    throw err;
  }
}

export async function status(creds) {
  const token = await accessToken(creds);
  return whoami(token);
}

/**
 * TikTok's rule (Media Transfer Guide):
 *  - total_chunk_count = video_size / chunk_size ROUNDED DOWN
 *  - every non-final chunk is 5..64 MB; the final chunk absorbs the remainder
 *    and may exceed chunk_size (up to 128 MB)
 *  - under 5 MB: one whole chunk; over 64 MB: must be chunked
 *
 * Rounding UP here (as an earlier version did) makes the count one too high
 * whenever the division leaves a remainder, and TikTok rejects it outright with
 * "The total chunk count is invalid".
 */
export function chunkPlan(sizeBytes) {
  if (sizeBytes <= MAX_CHUNK) return { chunkSize: sizeBytes, totalChunkCount: 1 };
  return { chunkSize: TEN_MB, totalChunkCount: Math.max(1, Math.floor(sizeBytes / TEN_MB)) };
}

/**
 * Direct Post needs video.publish; the inbox draft needs video.upload.
 * Sending the wrong scope to the wrong endpoint is rejected by TikTok.
 */
export function endpointForScope(scope) {
  return /video\.publish/.test(String(scope ?? '')) ? INIT_URL : INBOX_INIT_URL;
}

export async function publish({ clip, meta, creds, log }) {
  const token = await accessToken(creds);
  const { chunkSize, totalChunkCount } = chunkPlan(clip.sizeBytes);

  // TikTok exposes two endpoints guarded by two different scopes, and mixing
  // them is rejected:
  //   video.publish -> Direct Post   (/v2/post/publish/video/init/)
  //   video.upload  -> inbox draft   (/v2/post/publish/inbox/video/init/)
  // We pick the endpoint from the scope actually granted at authorization.
  const canDirectPost = /video\.publish/.test(String(creds.scope ?? ''));

  // Unaudited apps are forced to SELF_ONLY by TikTok regardless of what we ask.
  const requested = meta.privacy === 'private' ? 'SELF_ONLY' : (meta.tiktokPrivacy ?? 'SELF_ONLY');

  const sourceInfo = {
    source: 'FILE_UPLOAD',
    video_size: clip.sizeBytes,
    chunk_size: chunkSize,
    total_chunk_count: totalChunkCount,
  };

  // The inbox endpoint takes no post_info; the draft is completed in the app.
  const directBody = {
    post_info: {
      title: (meta.caption ?? meta.title ?? '').slice(0, 2200),
      privacy_level: requested,
      disable_duet: false,
      disable_comment: false,
      disable_stitch: false,
      video_cover_timestamp_ms: 1000,
    },
    source_info: sourceInfo,
  };
  const inboxBody = { source_info: sourceInfo };

  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=UTF-8' };
  const call = (url, payload) =>
    request(url, { label: 'TikTok upload init', method: 'POST', retries: 1, headers, body: JSON.stringify(payload) });

  // Direct Post is only usable by audited apps; an unaudited one is told to
  // post privately. Rather than fail, drop back to the inbox draft when the
  // token also carries video.upload.
  let usedDirect = canDirectPost;
  let init;
  try {
    init = await call(usedDirect ? INIT_URL : INBOX_INIT_URL, usedDirect ? directBody : inboxBody);
  } catch (err) {
    const unaudited = /unaudited_client_can_only_post_to_private_accounts/i.test(err.message);
    const canInbox = /video\.upload/.test(String(creds.scope ?? ''));
    if (usedDirect && unaudited && canInbox) {
      log('  TikTok refused Direct Post (app is not audited yet) - sending to your inbox instead ...');
      usedDirect = false;
      init = await call(INBOX_INIT_URL, inboxBody);
    } else if (usedDirect && unaudited) {
      throw new Error(
        `${err.message}\n` +
          '  Direct Post needs an audited app. Re-authorise with the upload scope as well:\n' +
          '    node upload.mjs auth tiktok --scope user.info.basic,video.upload,video.publish',
      );
    } else {
      throw err;
    }
  }

  const publishId = init.body?.data?.publish_id;
  const uploadUrl = init.body?.data?.upload_url;
  if (!publishId || !uploadUrl) {
    const detail = init.body?.error?.message ?? init.body?.error?.code ?? 'no publish_id returned';
    throw new Error(`TikTok init failed: ${detail}`);
  }

  log(`  uploading ${totalChunkCount} chunk(s) of ${(chunkSize / 1024 / 1024).toFixed(1)} MB ...`);
  const handle = await fs.promises.open(clip.path, 'r');
  try {
    for (let i = 0; i < totalChunkCount; i++) {
      const start = i * chunkSize;
      // The final chunk takes everything that remains, which may exceed
      // chunk_size - exactly what TikTok's round-down rule expects.
      const isLast = i === totalChunkCount - 1;
      const end = isLast ? clip.sizeBytes - 1 : start + chunkSize - 1;
      const length = end - start + 1;
      const buffer = Buffer.allocUnsafe(length);
      await handle.read(buffer, 0, length, start);

      const res = await fetch(uploadUrl, {
        method: 'PUT',
        headers: {
          'Content-Type': clip.ext === '.mov' ? 'video/quicktime' : 'video/mp4',
          'Content-Length': String(length),
          'Content-Range': `bytes ${start}-${end}/${clip.sizeBytes}`,
        },
        body: buffer,
        signal: AbortSignal.timeout(10 * 60_000),
      });
      if (!res.ok) {
        const text = (await res.text()).slice(0, 400);
        throw new Error(`TikTok chunk ${i + 1}/${totalChunkCount} failed: ${res.status} ${text}`);
      }
    }
  } finally {
    await handle.close();
  }

  // Poll until TikTok reports the post reached its final state.
  log('  waiting for TikTok to confirm ...');
  const deadline = Date.now() + 5 * 60_000;
  let state = 'PROCESSING_UPLOAD';
  while (Date.now() < deadline) {
    const { body } = await request(STATUS_URL, {
      label: 'TikTok publish status',
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify({ publish_id: publishId }),
    });
    state = body?.data?.status ?? state;
    if (state === 'PUBLISH_COMPLETE' || state === 'FAILED') break;
    await new Promise((r) => setTimeout(r, 4000));
  }

  if (state === 'FAILED') throw new Error('TikTok reported the upload as FAILED. Check the app dashboard for the reason.');

  return {
    id: publishId,
    // A draft has no public URL - TikTok only issues one once the user posts it.
    // Returning a made-up profile link here was misleading; show nothing.
    url: null,
    note: usedDirect
      ? `TikTok status: ${state} (privacy requested: ${requested})`
      : `Draft is in your TikTok inbox (${state}) - app: Inbox (top right), or Profile > menu > Drafts.`,
  };
}

export default { name: 'tiktok', label: 'TikTok', authenticate, publish, status, chunkPlan };
