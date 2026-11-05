// Verify the Instagram pre-fit step WITHOUT uploading or publishing anything:
// runs fitForInstagram on the real clip and reports what it produced.
import fs from 'node:fs';
import { probe } from '../lib/probe.mjs';
import { fitForInstagram, instagramScaleFactor } from '../lib/platforms/meta.mjs';

const file = process.argv[2];
if (!file) {
  console.error('usage: node tests/check-ig-fit.mjs <video>');
  process.exit(1);
}

const clip = probe(file);
console.log(`input : ${clip.width}x${clip.height}  ${clip.duration.toFixed(1)}s  fps ${clip.fpsNum}  ${clip.sizeMb.toFixed(1)} MB`);
console.log(`scale : ${instagramScaleFactor(clip).toFixed(3)}`);

const fitted = await fitForInstagram(clip, (m) => console.log(m));
console.log(`output: scaled=${fitted.scaled}  ${fitted.scaled ? `${fitted.width}x${fitted.height}` : 'unchanged'}  ${(fitted.sizeBytes / 1024 / 1024).toFixed(1)} MB`);

if (fitted.scaled) {
  const out = probe(fitted.path);
  console.log(`verify: ${out.width}x${out.height}  ${out.duration.toFixed(1)}s  ${out.sizeMb.toFixed(1)} MB  ${out.videoCodec}`);
  const px = out.width * out.height * out.fpsNum * out.duration;
  console.log(`pixel-frames: ${(px / 1e9).toFixed(2)} G  (budget 1.85 G, proven-good 1.87 G, proven-failing 2.80 G)`);
  fs.unlinkSync(fitted.path);
  console.log('temp file removed');
}
