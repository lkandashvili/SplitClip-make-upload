// YouTube: OAuth (loopback) + resumable upload.
// Uploads cost 1600 quota units against a default 10,000/day, so ~6 per day
// unless you request a quota increase.

import fs from 'node:fs';
import { request } from '../http.mjs';
import { startLoopback, browserHint, resolveRedirect, parseRedirectInput } from '../oauth.mjs';
import { updatePlatform, cleanCredential } from '../config.mjs';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const UPLOAD_URL = 'https://www.googleapis.com/upload/youtube/v3/videos';
const SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.readonly',
];

export const CATEGORIES = {
  '1': 'Film & Animation', '2': 'Autos & Vehicles', '10': 'Music', '15': 'Pets & Animals',
  '17': 'Sports', '19': 'Travel & Events', '20': 'Gaming', '22': 'People & Blogs',
  '23': 'Comedy', '24': 'Entertainment', '25': 'News & Politics', '26': 'Howto & Style',
  '27': 'Education', '28': 'Science & Technology',
};

async function exchange(params, label) {
  const { body } = await request(TOKEN_URL, {
    label,
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  if (!body?.access_token) throw new Error(`${label}: token endpoint returned no access_token`);
  return body;
}

export async function accessToken(creds, { force = false } = {}) {
  // Fail actionably instead of letting Google report "The OAuth client was not
  // found" for a request that actually sent client_id=undefined.
  if (!creds?.client_id || !creds?.client_secret) {
    throw new Error('YouTube credentials are incomplete (no client id/secret stored). Re-run: node upload.mjs auth youtube');
  }
  if (!creds.refresh_token) {
    throw new Error('YouTube is not authorized yet. Run: node upload.mjs auth youtube');
  }
  const now = Date.now();
  if (!force && creds.access_token && creds.expires_at && creds.expires_at - 60_000 > now) {
    return creds.access_token;
  }
  const fresh = await exchange(
    {
      client_id: creds.client_id,
      client_secret: creds.client_secret,
      refresh_token: creds.refresh_token,
      grant_type: 'refresh_token',
    },
    'YouTube token refresh',
  );
  updatePlatform('youtube', {
    access_token: fresh.access_token,
    expires_at: now + (fresh.expires_in ?? 3600) * 1000,
  });
  return fresh.access_token;
}

export async function authenticate({ ask, log, args }) {
  const clientId = cleanCredential(args['client-id'] ?? (await ask('Google OAuth Client ID: ')));
  const clientSecret = cleanCredential(args['client-secret'] ?? (await ask('Google OAuth Client Secret: ')));
  if (!clientId || !clientSecret) throw new Error('Both the client ID and secret are required.');

  // 'localhost', not 127.0.0.1: Google rejects the bare IP for Desktop clients
  // with "Error 400: invalid_request". Override with --redirect-uri if needed.
  const redirect = resolveRedirect(
    args['redirect-uri'],
    Number(args.port ?? 8720),
    '/oauth2callback',
    'localhost',
  );
  const { redirectUri, waitForCode, close } = await startLoopback({ ...redirect, timeoutMs: 180_000 });

  const state = Math.random().toString(36).slice(2);
  const url = `${AUTH_URL}?${new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    state,
  })}`;

  log(`  redirect URI: ${redirectUri}`);
  log(browserHint(url, { open: !args['no-browser'] }));

  let code;
  if (args.manual) {
    close();
    log('--manual: approve in the browser, then paste the address bar contents from the');
    log('page you land on (it starts with ' + redirectUri + '...). It may show an error page.');
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

  const token = await exchange(
    {
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    },
    'YouTube code exchange',
  );

  if (!token.refresh_token) {
    throw new Error(
      'Google did not return a refresh token. Remove the app at https://myaccount.google.com/permissions and try again.',
    );
  }

  updatePlatform('youtube', {
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: token.refresh_token,
    access_token: token.access_token,
    expires_at: Date.now() + (token.expires_in ?? 3600) * 1000,
  });

  const channel = await whoami(token.access_token).catch(() => null);
  if (channel) updatePlatform('youtube', { channel });
  return channel;
}

export async function whoami(token) {
  const { body } = await request(
    'https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&mine=true',
    { label: 'YouTube channel lookup', headers: { Authorization: `Bearer ${token}` } },
  );
  const item = body?.items?.[0];
  if (!item) return null;
  return { id: item.id, title: item.snippet?.title, subscribers: item.statistics?.subscriberCount };
}

/** Probe the channel via a cheap call, so `doctor` reports real state. */
export async function status(creds) {
  const token = await accessToken(creds);
  return whoami(token);
}

export async function publish({ clip, meta, creds, log }) {
  const token = await accessToken(creds);

  const title = (meta.title ?? clip.fileName).slice(0, 100);
  const description = (meta.description ?? '').slice(0, 5000);
  const isShort = clip.orientation === 'vertical' && clip.duration <= 180;

  // Do not inject "#Shorts" into the description: Shorts status is decided by
  // geometry + duration alone, and silently editing your description is rude.
  const snippet = {
    title,
    description,
    categoryId: String(meta.categoryId ?? '20'),
    ...(meta.tags?.length ? { tags: meta.tags.map((t) => t.replace(/^#/, '')).slice(0, 15) } : {}),
  };

  const initRes = await request(`${UPLOAD_URL}?uploadType=resumable&part=snippet,status`, {
    label: 'YouTube upload init',
    method: 'POST',
    retries: 1,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Length': String(clip.sizeBytes),
      'X-Upload-Content-Type': 'video/*',
    },
    body: JSON.stringify({
      snippet,
      status: {
        privacyStatus: meta.privacy ?? 'public',
        selfDeclaredMadeForKids: Boolean(meta.madeForKids),
        madeForKids: Boolean(meta.madeForKids),
      },
    }),
  });

  const session = initRes.headers.get('location');
  if (!session) throw new Error('YouTube did not return a resumable upload session URL.');

  log(`  uploading ${clip.sizeMb.toFixed(1)} MB ...`);
  const blob = await fs.openAsBlob(clip.path, { type: 'video/mp4' });
  const { body } = await request(session, {
    label: 'YouTube upload',
    method: 'PUT',
    retries: 2,
    timeoutMs: 30 * 60_000,
    headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(clip.sizeBytes) },
    body: blob,
  });

  return {
    id: body?.id,
    url: body?.id ? `https://youtu.be/${body.id}` : null,
    note: isShort ? 'Uploaded as a Short (vertical, <=180s)' : undefined,
  };
}

export default { name: 'youtube', label: 'YouTube', authenticate, publish, status };
