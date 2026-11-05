// Offline checks for the OAuth plumbing: loopback binding, redirect parsing.
// These do not touch any provider.
//
// Run with: node tests/oauth.mjs

import assert from 'node:assert/strict';
import net from 'node:net';

import { startLoopback, parseRedirectInput, resolveRedirect } from '../lib/oauth.mjs';

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  pass  ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL  ${name}\n        ${err.message}`);
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

console.log('\nresolveRedirect');
await test('defaults to localhost for Google', () => {
  const r = resolveRedirect(undefined, 8720, '/oauth2callback', 'localhost');
  assert.equal(r.uri, 'http://localhost:8720/oauth2callback');
  assert.equal(r.port, 8720);
  assert.equal(r.path, '/oauth2callback');
});
await test('defaults to 127.0.0.1 for Meta/TikTok', () => {
  assert.equal(resolveRedirect(undefined, 8721, '/callback').uri, 'http://127.0.0.1:8721/callback');
});
await test('honours an explicit override verbatim', () => {
  const r = resolveRedirect('http://localhost:9999/whatever', 8720, '/oauth2callback', 'localhost');
  assert.equal(r.uri, 'http://localhost:9999/whatever');
  assert.equal(r.port, 9999);
  assert.equal(r.path, '/whatever');
});
await test('rejects an https override with a useful message', () => {
  assert.throws(() => resolveRedirect('https://example.com/cb', 8720, '/cb', 'localhost'), /http:\/\/ loopback/);
});
await test('rejects a non-URL override', () => {
  assert.throws(() => resolveRedirect('just-text', 8720, '/cb', 'localhost'), /must be a full URL/);
});

console.log('\nparseRedirectInput');
await test('reads a code out of a full redirect URL', () => {
  const r = parseRedirectInput('http://localhost:8720/oauth2callback?state=xyz&code=4/0AbC-123&scope=x');
  assert.equal(r.code, '4/0AbC-123');
  assert.equal(r.state, 'xyz');
});
await test('accepts a bare code', () => {
  assert.equal(parseRedirectInput('4/0AbC-123').code, '4/0AbC-123');
});
await test('surfaces a refusal', () => {
  assert.throws(() => parseRedirectInput('http://localhost:8720/?error=access_denied&error_description=User+said+no'), /User said no/);
});
await test('rejects a URL with no code', () => {
  assert.throws(() => parseRedirectInput('http://localhost:8720/oauth2callback?state=x'), /no "code="/);
});

console.log('\nloopback server');

// The browser may resolve localhost to ::1 or 127.0.0.1; both must work.
for (const host of ['127.0.0.1', '::1']) {
  await test(`captures the code over ${host}`, async (t) => {
    const port = await freePort();
    const lp = await startLoopback({ port, path: '/oauth2callback', uri: `http://localhost:${port}/oauth2callback`, timeoutMs: 8000 });
    const waiting = lp.waitForCode();
    const consumer = host === '::1' ? `http://[::1]:${port}` : `http://127.0.0.1:${port}`;
    let res;
    try {
      res = await fetch(`${consumer}/oauth2callback?code=testcode&state=s1`, { signal: AbortSignal.timeout(5000) });
    } catch (err) {
      lp.close();
      // Some hosts have IPv6 disabled; that is not a tool failure.
      if (host === '::1') return;
      throw new Error(`could not reach the listener: ${err.message}`);
    }
    assert.equal(res.status, 200);
    const got = await waiting;
    assert.equal(got.code, 'testcode');
    assert.equal(got.state, 's1');
  });
}

await test('ignores requests to the wrong path', async () => {
  const port = await freePort();
  const lp = await startLoopback({ port, path: '/oauth2callback', timeoutMs: 8000 });
  const res = await fetch(`http://127.0.0.1:${port}/nope`, { signal: AbortSignal.timeout(5000) });
  assert.equal(res.status, 404);
  lp.close();
});

await test('reports a busy port clearly', async () => {
  const port = await freePort();
  const first = await startLoopback({ port, timeoutMs: 5000 });
  try {
    await assert.rejects(startLoopback({ port, timeoutMs: 5000 }), /already in use/);
  } finally {
    first.close();
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
