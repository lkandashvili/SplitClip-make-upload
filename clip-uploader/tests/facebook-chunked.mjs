// Exercises Facebook's chunked resumable upload with a stubbed network.
// No real requests, no publishing - it verifies the control flow only.
//
// Run: node tests/facebook-chunked.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { publishFacebookVideo } from '../lib/platforms/meta.mjs';

const CHUNK = 1024 * 1024;
const tmp = path.join(os.tmpdir(), `fb-chunk-test-${process.pid}.bin`);
fs.writeFileSync(tmp, Buffer.alloc(3 * CHUNK)); // 3 real MB on disk

// Pretend the file is 60 MB so the >50 MB chunked path is chosen. The loop only
// ever reads what the stubbed offsets ask for, so the short file is enough.
const clip = {
  path: tmp,
  sizeBytes: 60 * 1024 * 1024,
  sizeMb: 60,
  fileName: 'test.mp4',
  ext: '.mp4',
};

const calls = [];
const realFetch = globalThis.fetch;

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  calls.push({ url: u, method: opts.method ?? 'GET' });

  const json = (obj) => ({ ok: true, status: 200, text: async () => JSON.stringify(obj), json: async () => obj });

  // start phase
  if (u.includes('/videos?') && u.includes('upload_phase=start')) {
    return json({ video_id: 'vid1', upload_session_id: 'sess1', start_offset: '0', end_offset: String(CHUNK) });
  }

  // finish phase
  if (u.includes('/videos?') && u.includes('upload_phase=finish')) {
    return json({ success: true });
  }

  // transfer phase: emulate a server that accepts 1 MB at a time and stops
  // asking once the (pretend) file is fully delivered.
  if (u.includes('graph-video.facebook.com')) {
    const TOTAL = 3 * CHUNK;
    const startField = Number(opts.body?.get?.('start_offset'));
    const nextStart = Math.min(startField + CHUNK, TOTAL);
    const nextEnd = Math.min(nextStart + CHUNK, TOTAL);
    return json({ start_offset: String(nextStart), end_offset: String(nextEnd) });
  }

  return { ok: false, status: 404, text: async () => 'unexpected call' };
};

let result;
try {
  result = await publishFacebookVideo({
    clip,
    meta: { caption: 'hello', title: 'hello' },
    creds: { page_id: 'page1', page_token: 'tok1' },
    log: () => {},
  });
} finally {
  globalThis.fetch = realFetch;
  fs.rmSync(tmp, { force: true });
}

const label = (s) => `  ${s}`;
let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  pass  ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL  ${name}\n${label(err.message)}`);
  }
}

console.log('\nfacebook chunked upload');
check('it completed and returned the video id', () => {
  assert.equal(result.id, 'vid1');
  assert.equal(result.url, 'https://www.facebook.com/vid1');
});

check('it called start, transfers, then finish in that order', () => {
  const phases = calls.map((c) => {
    if (c.url.includes('upload_phase=start')) return 'start';
    if (c.url.includes('upload_phase=finish')) return 'finish';
    if (c.url.includes('graph-video')) return 'transfer';
    return 'other';
  });
  assert.equal(phases[0], 'start', `first call was ${phases[0]}`);
  assert.equal(phases[phases.length - 1], 'finish', `last call was ${phases.at(-1)}`);
  assert.ok(phases.filter((p) => p === 'transfer').length >= 1, 'no transfer calls were made');
});

check('the follow-up offsets from Facebook are honoured (not a fixed chunk size)', () => {
  const transfers = calls.filter((c) => c.url.includes('graph-video'));
  assert.equal(transfers.length, 3, `expected 3 transfer calls, got ${transfers.length}`);
});

// --- scenario 2: a session that never advances must abort, not spin ---
const tmp2 = path.join(os.tmpdir(), `fb-chunk-stall-${process.pid}.bin`);
fs.writeFileSync(tmp2, Buffer.alloc(CHUNK));

globalThis.fetch = async (url) => {
  const u = String(url);
  const json = (obj) => ({ ok: true, status: 200, text: async () => JSON.stringify(obj) });
  if (u.includes('upload_phase=start')) {
    return json({ video_id: 'v2', upload_session_id: 's2', start_offset: '0', end_offset: String(CHUNK) });
  }
  if (u.includes('graph-video')) {
    return json({ start_offset: '0', end_offset: '1048576' }); // never advances
  }
  return { ok: false, status: 404, text: async () => 'unexpected' };
};

let stalled = false;
try {
  await publishFacebookVideo({
    clip: { ...clip, path: tmp2, sizeBytes: 60 * 1024 * 1024 },
    meta: { caption: 'x' },
    creds: { page_id: 'page1', page_token: 'tok1' },
    log: () => {},
  });
} catch (err) {
  stalled = /stalled/i.test(err.message);
} finally {
  globalThis.fetch = realFetch;
  fs.rmSync(tmp2, { force: true });
}

check('a stalled session aborts instead of looping forever', () => {
  assert.ok(stalled, 'expected a "stalled" error, but the call resolved');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
