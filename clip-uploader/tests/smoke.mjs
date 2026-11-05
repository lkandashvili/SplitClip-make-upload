// Offline checks: the parts that can be verified without platform credentials.
// Run with: node tests/smoke.mjs

import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { probe, validate } from '../lib/probe.mjs';
import { credsFor, cleanCredential } from '../lib/config.mjs';
import { chunkPlan, endpointForScope, accessToken as tiktokToken } from '../lib/platforms/tiktok.mjs';
import { accessToken as youtubeToken } from '../lib/platforms/youtube.mjs';
import * as ytMod from '../lib/platforms/youtube.mjs';
import * as metaMod from '../lib/platforms/meta.mjs';
import { instagramScaleFactor } from '../lib/platforms/meta.mjs';
import * as ttMod from '../lib/platforms/tiktok.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
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

// Every function dispatch() in upload.mjs reaches for must actually be
// exported. A missing `export` fails only at runtime, on a real upload.
console.log('\nplatform exports - every dispatch target must be callable');
for (const [name, mod, fn] of [
  ['youtube.publish', ytMod, 'publish'],
  ['youtube.authenticate', ytMod, 'authenticate'],
  ['youtube.status', ytMod, 'status'],
  ['meta.authenticate', metaMod, 'authenticate'],
  ['meta.status', metaMod, 'status'],
  ['meta.publishFacebookReel', metaMod, 'publishFacebookReel'],
  ['meta.publishFacebookVideo', metaMod, 'publishFacebookVideo'],
  ['meta.publishInstagramReel', metaMod, 'publishInstagramReel'],
  ['tiktok.publish', ttMod, 'publish'],
  ['tiktok.authenticate', ttMod, 'authenticate'],
  ['tiktok.status', ttMod, 'status'],
]) {
  await test(name, () => {
    assert.equal(typeof mod[fn], 'function', `${name} is ${typeof mod[fn]}, not a function`);
  });
}

console.log('\nchunkPlan (TikTok requires 5MB <= chunk <= 64MB, count = ceil(size/chunk))');
await test('small file is one chunk', () => {
  const p = chunkPlan(3 * 1024 * 1024);
  assert.equal(p.totalChunkCount, 1);
  assert.equal(p.chunkSize, 3 * 1024 * 1024);
});
await test('12MB uploads as a single chunk (under the 64MB whole-file limit)', () => {
  assert.equal(chunkPlan(12 * 1024 * 1024).totalChunkCount, 1);
});
await test('exactly 64MB is still one chunk', () => {
  assert.equal(chunkPlan(64 * 1024 * 1024).totalChunkCount, 1);
});
await test('just over 64MB must be chunked', () => {
  assert.ok(chunkPlan(64 * 1024 * 1024 + 1).totalChunkCount > 1);
});
await test('200MB count equals size/chunk ROUNDED DOWN', () => {
  const size = 200 * 1024 * 1024;
  const p = chunkPlan(size);
  assert.ok(p.chunkSize <= 64 * 1024 * 1024, 'chunk exceeds cap');
  assert.ok(p.chunkSize >= 5 * 1024 * 1024, 'chunk below minimum');
  assert.equal(p.totalChunkCount, Math.floor(size / p.chunkSize), 'count must be floor, not ceil');
});
await test('every plan leaves a final chunk of at most 128MB', () => {
  for (const mb of [65, 100, 200, 500, 1000]) {
    const size = mb * 1024 * 1024;
    const p = chunkPlan(size);
    const last = size - (p.totalChunkCount - 1) * p.chunkSize;
    assert.ok(last > 0 && last <= 128 * 1024 * 1024, `${mb}MB plan left a ${(last / 1024 ** 2).toFixed(1)}MB final chunk`);
    assert.ok(last >= p.chunkSize, `${mb}MB final chunk smaller than chunk_size`);
  }
});
await test('REGRESSION: the 86,647,587-byte clip that TikTok rejected', () => {
  // Real failure: ceil() gave 9 chunks and TikTok replied
  // "The total chunk count is invalid". Spec wants floor -> 8.
  const size = 86_647_587;
  const p = chunkPlan(size);
  assert.equal(p.totalChunkCount, 8);
  assert.equal(p.chunkSize, 10 * 1024 * 1024);
  const last = size - (p.totalChunkCount - 1) * p.chunkSize;
  assert.equal(last, 13_247_267, 'final chunk must absorb the remainder');
  assert.ok(last <= 128 * 1024 * 1024);
});

console.log('\nendpointForScope - the endpoint must match the granted scope');
await test('video.upload goes to the inbox (draft) endpoint', () => {
  assert.match(endpointForScope('user.info.basic,video.upload'), /\/inbox\/video\/init\/$/);
});
await test('video.publish goes to the direct post endpoint', () => {
  const url = endpointForScope('user.info.basic,video.publish');
  assert.match(url, /\/publish\/video\/init\/$/);
  assert.doesNotMatch(url, /inbox/);
});
await test('REGRESSION: inbox and direct endpoints are never the same', () => {
  assert.notEqual(endpointForScope('video.upload'), endpointForScope('video.publish'));
});
await test('an unknown/absent scope safely defaults to the draft endpoint', () => {
  assert.match(endpointForScope(undefined), /\/inbox\/video\/init\/$/);
  assert.match(endpointForScope(null), /\/inbox\/video\/init\/$/);
});

console.log('\ncleanCredential - paste artifacts must not become auth failures');
await test('trims surrounding whitespace', () => {
  assert.equal(cleanCredential('  aw123abc  '), 'aw123abc');
});
await test('strips wrapping double quotes', () => {
  assert.equal(cleanCredential('"aw123abc"'), 'aw123abc');
});
await test('strips wrapping single quotes and backticks', () => {
  assert.equal(cleanCredential("'aw123abc'"), 'aw123abc');
  assert.equal(cleanCredential('`aw123abc`'), 'aw123abc');
});
await test('strips a pasted key=value prefix', () => {
  assert.equal(cleanCredential('client_key=aw123abc'), 'aw123abc');
  assert.equal(cleanCredential('app_secret = GOCSPX-fakefixture2'), 'GOCSPX-fakefixture2');
});
await test('handles a prefix AND quotes together', () => {
  assert.equal(cleanCredential('"client_key=aw123abc"'), 'aw123abc');
});
await test('leaves a clean value untouched', () => {
  assert.equal(cleanCredential('GOCSPX-fakefixture1'), 'GOCSPX-fakefixture1');
});
await test('does not eat an inner equals sign', () => {
  assert.equal(cleanCredential('abc=def'), 'abc=def');
});
await test('undefined becomes an empty string, not "undefined"', () => {
  assert.equal(cleanCredential(undefined), '');
  assert.equal(cleanCredential(null), '');
});

console.log('\ninstagramScaleFactor - fit long clips inside IG ingest budget');
await test('a 30s 1080x1920 clip is uploaded untouched (proven to work)', () => {
  assert.equal(instagramScaleFactor({ width: 1080, height: 1920, fpsNum: 30, duration: 30 }), 1);
});
await test('a 66s 1080x1920 clip is downscaled (proven to fail)', () => {
  const f = instagramScaleFactor({ width: 1080, height: 1920, fpsNum: 30, duration: 66 });
  assert.ok(f < 0.8, `expected a real downscale, got ${f}`);
  const w = Math.floor((1080 * f) / 2) * 2;
  const h = Math.floor((1920 * f) / 2) * 2;
  assert.ok(w >= 640, 'do not shrink below 640px wide');
  assert.ok((w * h * 30 * 66) / 1e9 <= 1.95, 'result should sit at the budget');
});
await test('a 60s clip at 60fps is scaled harder than at 30fps', () => {
  const a = instagramScaleFactor({ width: 1080, height: 1920, fpsNum: 30, duration: 60 });
  const b = instagramScaleFactor({ width: 1080, height: 1920, fpsNum: 60, duration: 60 });
  assert.ok(b < a, 'higher frame rate needs more scaling');
});
await test('a coarse "30/1" fps string still works', () => {
  assert.ok(instagramScaleFactor({ width: 1080, height: 1920, fps: '30/1', duration: 66 }) < 0.8);
});
await test('an already-small clip is untouched', () => {
  assert.equal(instagramScaleFactor({ width: 1080, height: 1920, fpsNum: 30, duration: 8 }), 1);
});

console.log('\ncredsFor - each platform gets ONLY its own block');
const tokens = {
  youtube: { client_id: 'yt', refresh_token: 'r' },
  meta: { page_token: 'pg', ig_user_id: 'ig' },
  tiktok: { client_key: 'tk', refresh_token: 'r2' },
};
await test('youtube gets the youtube block', () => {
  assert.deepEqual(credsFor('youtube', tokens), tokens.youtube);
});
await test('facebook gets the meta block', () => {
  assert.deepEqual(credsFor('facebook', tokens), tokens.meta);
});
await test('instagram gets the meta block', () => {
  assert.deepEqual(credsFor('instagram', tokens), tokens.meta);
});
await test('tiktok gets the tiktok block', () => {
  assert.deepEqual(credsFor('tiktok', tokens), tokens.tiktok);
});
await test('an unknown platform gets an empty object, not everything', () => {
  assert.deepEqual(credsFor('myspace', tokens), {});
});
await test('REGRESSION: the whole tokens file must never leak as one block', async () => {
  // This is the bug that produced "The OAuth client was not found":
  // dispatch handed youtube the entire tokens object, so client_id was undefined.
  const leaked = tokens;
  assert.notEqual(credsFor('youtube', tokens), leaked, 'credsFor returned the parent object');
  assert.equal(credsFor('youtube', tokens).client_id, 'yt');
});
await test('REGRESSION: incomplete credentials fail loudly, not with a provider error', async () => {
  await assert.rejects(youtubeToken({}), /incomplete|not authorized/i);
  await assert.rejects(youtubeToken(undefined), /incomplete|not authorized/i);
  await assert.rejects(tiktokToken({}), /incomplete/i);
});

console.log('\nprobe on the generated sample');
const sample = path.join(here, '..', 'samples', 'test_vertical_8s.mp4');
const clip = probe(sample);
await test('reads dimensions', () => {
  assert.equal(clip.width, 1080);
  assert.equal(clip.height, 1920);
});
await test('classifies orientation', () => assert.equal(clip.orientation, 'vertical'));
await test('reads duration and audio', () => {
  assert.ok(clip.duration > 7 && clip.duration < 9, `duration was ${clip.duration}`);
  assert.equal(clip.hasAudio, true);
});

console.log('\nvalidate rejects impossible targets');
await test('tiktok rejects a 20 minute clip', () => {
  assert.ok(validate({ ...clip, duration: 1200 }, 'tiktok').some((m) => /exceeds/.test(m)));
});
await test('tiktok rejects a .mkv', () => {
  assert.ok(validate({ ...clip, ext: '.mkv' }, 'tiktok').some((m) => /not accepted/.test(m)));
});
await test('instagram rejects a 2 second clip', () => {
  assert.ok(validate({ ...clip, duration: 2 }, 'instagram', { postType: 'reel' }).some((m) => /shorter/.test(m)));
});
await test('instagram warns when a reel is horizontal', () => {
  assert.ok(
    validate({ ...clip, orientation: 'horizontal' }, 'instagram', { postType: 'reel' }).some((m) => /9:16/.test(m)),
  );
});
await test('a valid vertical tiktok clip has no warnings', () => {
  assert.deepEqual(validate(clip, 'tiktok'), []);
});

console.log('\nprobe error paths');
await test('missing file throws clearly', () => {
  assert.throws(() => probe(path.join(here, 'nope.mp4')), /File not found/);
});
await test('non-video file throws clearly', () => {
  assert.throws(() => probe(path.join(here, 'smoke.mjs')), /could not read|no video stream/);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
