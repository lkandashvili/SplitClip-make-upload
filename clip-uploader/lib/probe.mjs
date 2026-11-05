// Reads the clip with ffprobe so we can refuse a file that a platform will
// reject anyway, and so we can pick the right post type automatically.

import fs from 'node:fs';
import path from 'node:path';
import { capture } from './exec.mjs';

export function ffprobeVersion() {
  const res = capture('ffprobe', ['-version'], { timeoutMs: 15_000 });
  if (res.error?.code === 'ENOENT') return null;
  if (res.status !== 0) return null;
  return (res.stdout.split('\n')[0] ?? '').replace('ffprobe version ', '').split(' ')[0] || 'unknown';
}

export function probe(filePath) {
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) throw new Error(`File not found: ${abs}`);

  const stat = fs.statSync(abs);
  const res = capture('ffprobe', [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    abs,
  ]);

  if (res.error?.code === 'ENOENT') {
    throw new Error('ffprobe is not on PATH. Install ffmpeg (or add it to PATH) and re-run.');
  }
  if (res.error) {
    throw new Error(`Could not run ffprobe: ${res.error.message}`);
  }
  if (res.status !== 0) {
    const detail = (res.stderr || '').trim();
    throw new Error(`ffprobe could not read this file - is it a valid video?${detail ? `\n${detail}` : ''}`);
  }

  let data;
  try {
    data = JSON.parse(res.stdout);
  } catch {
    throw new Error('ffprobe returned output this tool could not parse.');
  }

  const video = (data.streams ?? []).find((s) => s.codec_type === 'video');
  const audio = (data.streams ?? []).find((s) => s.codec_type === 'audio');
  if (!video) throw new Error('That file has no video stream.');

  const width = Number(video.width) || 0;
  const height = Number(video.height) || 0;
  const duration = Number(data.format?.duration ?? video.duration ?? 0);

  // avg_frame_rate arrives as "30000/1001"; keep a numeric form for maths.
  const rate = String(video.avg_frame_rate ?? '');
  const [num, den] = rate.split('/').map(Number);
  const fpsNum = num && den ? num / den : 0;

  return {
    path: abs,
    fileName: path.basename(abs),
    ext: path.extname(abs).toLowerCase(),
    sizeBytes: stat.size,
    sizeMb: stat.size / 1024 / 1024,
    duration,
    width,
    height,
    aspect: height > width ? (height / width).toFixed(2) : (width / height).toFixed(2),
    orientation: height > width ? 'vertical' : width === height ? 'square' : 'horizontal',
    videoCodec: video.codec_name,
    audioCodec: audio?.codec_name ?? null,
    hasAudio: Boolean(audio),
    bitrate: Number(data.format?.bit_rate ?? 0),
    fps: video.avg_frame_rate,
    fpsNum,
  };
}

/** Platform limits, kept in one place so the rules are auditable. */
export const LIMITS = {
  youtube: { maxBytes: 256 * 1024 ** 3, maxSeconds: 12 * 3600 },
  // Reels: 3s min. The API accepts longer, but 15 min is the practical ceiling.
  instagram: { maxBytes: 1024 ** 3, minSeconds: 3, maxSeconds: 900, requireVerticalRatio: true },
  facebook: { maxBytes: 10 * 1024 ** 3, maxSeconds: 4 * 3600 },
  // Content Posting API: mp4/mov, <= 4GB, <= 10 min.
  tiktok: { maxBytes: 4 * 1024 ** 3, maxSeconds: 600, exts: ['.mp4', '.mov', '.webm'] },
};

/** Returns warnings for a target platform. A warning blocks that platform only. */
export function validate(clip, platform, { postType } = {}) {
  const L = LIMITS[platform];
  const warnings = [];
  if (!L) return warnings;

  if (L.maxBytes && clip.sizeBytes > L.maxBytes) {
    warnings.push(`${clip.sizeMb.toFixed(0)} MB exceeds the ${platform} limit of ${(L.maxBytes / 1024 ** 3).toFixed(0)} GB`);
  }
  if (L.maxSeconds && clip.duration > L.maxSeconds) {
    warnings.push(`${clip.duration.toFixed(0)}s exceeds the ${platform} limit of ${L.maxSeconds}s`);
  }
  if (L.minSeconds && clip.duration < L.minSeconds) {
    warnings.push(`${clip.duration.toFixed(1)}s is shorter than the ${platform} minimum of ${L.minSeconds}s`);
  }
  if (L.exts && !L.exts.includes(clip.ext)) {
    warnings.push(`${clip.ext} is not accepted by ${platform} (allowed: ${L.exts.join(', ')})`);
  }
  if (L.requireVerticalRatio && postType === 'reel' && clip.orientation !== 'vertical') {
    warnings.push(`Reels are 9:16; this clip is ${clip.orientation} ${clip.width}x${clip.height} (it will letterbox)`);
  }
  if (!clip.hasAudio && (platform === 'tiktok' || platform === 'instagram')) {
    warnings.push('No audio track. Both platforms accept it, but reach is usually worse.');
  }
  return warnings;
}
