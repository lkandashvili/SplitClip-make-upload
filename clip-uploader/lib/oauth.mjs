// Local OAuth helper: spins a loopback listener, opens your browser, catches
// the redirect. No copy-pasting codes, no public callback URL to register.
//
// Two hard-won details live here:
//  1. Google rejects http://127.0.0.1 for Desktop-app clients with a bare
//     "Error 400: invalid_request"; http://localhost is accepted. So localhost
//     is the default for Google flows.
//  2. "localhost" resolves to ::1 or 127.0.0.1 depending on the browser, so the
//     listener binds BOTH loopback addresses.

import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

export function randomString(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function pkcePair() {
  const verifier = randomString(48);
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/**
 * Decide which loopback address to advertise.
 * Returns { port, path, host, uri } where `uri` is sent to the provider verbatim.
 */
export function resolveRedirect(explicit, defaultPort, defaultPath, defaultHost = '127.0.0.1') {
  if (!explicit) {
    return {
      port: defaultPort,
      path: defaultPath,
      host: defaultHost,
      uri: `http://${defaultHost}:${defaultPort}${defaultPath}`,
    };
  }

  let u;
  try {
    u = new URL(explicit);
  } catch {
    throw new Error(
      `--redirect-uri must be a full URL, e.g. --redirect-uri http://${defaultHost}:${defaultPort}${defaultPath} (got "${explicit}")`,
    );
  }
  if (u.protocol !== 'http:') {
    throw new Error(
      `--redirect-uri must be an http:// loopback URL so this tool can serve it (got "${explicit}").`,
    );
  }

  return {
    port: Number(u.port || 80),
    path: u.pathname || '/',
    host: u.hostname,
    uri: explicit,
  };
}

/**
 * Pull the authorization code out of whatever the user pasted: a full redirect
 * URL, or just the raw code. Returns { code, state }.
 */
export function parseRedirectInput(text) {
  const raw = String(text ?? '').trim();
  if (!raw) throw new Error('Nothing was pasted.');

  if (/^https?:\/\//i.test(raw) || raw.includes('code=')) {
    let url;
    try {
      url = new URL(raw.startsWith('http') ? raw : `http://localhost/?${raw.replace(/^\?/, '')}`);
    } catch {
      throw new Error('That does not look like a valid redirect URL.');
    }
    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error');
    if (error) throw new Error(`Authorization was refused: ${url.searchParams.get('error_description') || error}`);
    if (!code) throw new Error('That URL has no "code=" parameter in it.');
    return { code, state: url.searchParams.get('state') };
  }

  if (/\s/.test(raw)) throw new Error('The pasted value contains spaces - copy it again without line breaks.');
  return { code: raw, state: null };
}

/**
 * Open the browser WITHOUT a shell.
 *
 * This matters: launching via `cmd /c start "" <url>` lets cmd.exe treat the
 * "&" between query parameters as a command separator, so the browser receives
 * a truncated URL (e.g. only ?client_id=...) and Google replies
 * "Required parameter is missing: response_type". Passing the URL straight to
 * rundll32 avoids any shell parsing.
 */
function openBrowser(url) {
  const opts = { stdio: 'ignore', detached: true };
  try {
    if (process.platform === 'win32') {
      // Primary: no shell involved, so & ? = are passed through untouched.
      const child = spawn('rundll32', ['url.dll,FileProtocolHandler', url], opts);
      child.on('error', () => {});
      child.unref();
      // Secondary: explorer also parses argv directly (not via cmd.exe).
      const alt = spawn('explorer.exe', [url], opts);
      alt.on('error', () => {});
      alt.unref();
      return;
    }
    const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
    const child = spawn(cmd, [url], opts);
    child.on('error', () => {});
    child.unref();
  } catch { /* the URL is always printed as a fallback */ }
}

function bindServer(handler, port, host) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve(server);
    });
  });
}

/**
 * Start the loopback server and wait for the browser to be redirected back.
 * Binds both 127.0.0.1 and ::1 so "localhost" works whichever way it resolves.
 */
export async function startLoopback({
  port = 8720,
  path: cbPath = '/callback',
  uri,
  host = '127.0.0.1',
  timeoutMs = 180_000,
} = {}) {
  let resolveResult;
  let rejectResult;
  const done = new Promise((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  const handler = (req, res) => {
    const url = new URL(req.url, `http://${host}:${port}`);
    if (url.pathname !== cbPath) {
      res.writeHead(404).end('Not the callback path.');
      return;
    }
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const error = url.searchParams.get('error');
    const errorDescription = url.searchParams.get('error_description');

    if (error) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html(`<h3>Authorization failed</h3><p>${escapeHtml(errorDescription || error)}</p>`));
      rejectResult(new Error(`Authorization denied: ${errorDescription || error}`));
      return;
    }
    if (!code) {
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end(html('<h3>No authorization code in the redirect.</h3>'));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html('<h3>Done - you can close this tab.</h3><p>Returning to the terminal.</p>'));
    resolveResult({ code, state });
  };

  const servers = [];
  try {
    // IPv4 must succeed: it is the address a user can always reach.
    servers.push(await bindServer(handler, port, '127.0.0.1'));
  } catch (err) {
    if (err.code === 'EADDRINUSE') {
      throw new Error(`Port ${port} is already in use. Close the other app, or pass --port with a free one.`);
    }
    throw err;
  }
  // IPv6 is best effort - needed when the browser resolves localhost to ::1.
  try {
    servers.push(await bindServer(handler, port, '::1'));
  } catch { /* IPv4 alone is enough on most systems */ }

  const timer = setTimeout(() => {
    rejectResult(
      new Error(
        'Timed out waiting for the browser redirect.\n' +
          'If the browser showed "Error 400: invalid_request" or "redirect_uri_mismatch", the provider\n' +
          'refused the redirect URI, so nothing came back to this listener. The value being sent is:\n' +
          `  ${uri ?? `http://${host}:${port}${cbPath}`}\n` +
          'Try again with --manual to paste the code by hand instead.',
      ),
    );
  }, timeoutMs);

  const shutdown = () => {
    clearTimeout(timer);
    for (const s of servers) s.close();
  };

  return {
    redirectUri: uri ?? `http://${host}:${port}${cbPath}`,
    waitForCode: () => done.finally(shutdown),
    close: shutdown,
  };
}

export function browserHint(url, { open = true } = {}) {
  if (open) openBrowser(url);
  return [
    '',
    'Opening your browser to authorize.',
    'If it does not open, or the page shows an error, copy this ENTIRE url into your browser:',
    '',
    url,
    '',
    '   ^ the line above is one single URL, even if it wraps.',
    '',
  ].join('\n');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

function html(body) {
  return `<!doctype html><meta charset="utf-8"><title>clip-uploader</title>
<body style="font-family:system-ui;max-width:34rem;margin:4rem auto;line-height:1.5">${body}</body>`;
}
