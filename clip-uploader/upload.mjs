#!/usr/bin/env node
// clip-uploader - publish one finished clip to YouTube, Instagram, Facebook and TikTok.
//
//   node upload.mjs doctor
//   node upload.mjs auth youtube | meta | tiktok | all
//   node upload.mjs upload --file "C:\clips\ep12.mp4" --title "..." --tags gaming,funny
//
// Runs entirely on your machine. No server, no third party sees your tokens.

import path from 'node:path';
import fs from 'node:fs';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

import { probe, validate, ffprobeVersion } from './lib/probe.mjs';
import { loadTokens, alreadyPublished, recordUpload, ROOT, credsFor } from './lib/config.mjs';
import * as youtube from './lib/platforms/youtube.mjs';
import * as meta from './lib/platforms/meta.mjs';
import * as tiktok from './lib/platforms/tiktok.mjs';

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};

const log = (msg = '') => console.log(msg);
const ok = (msg) => console.log(`  ${C.green('OK')}   ${msg}`);
const bad = (msg) => console.log(`  ${C.red('FAIL')} ${msg}`);
const skip = (msg) => console.log(`  ${C.yellow('SKIP')} ${msg}`);

// ------------------------------------------------------------------ args ----

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        args[key] = true;
      } else {
        args[key] = next;
        i++;
      }
    } else {
      args._.push(token);
    }
  }
  return args;
}

function splitList(value) {
  if (value === undefined || value === true) return [];
  return String(value)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

const ALL_PLATFORMS = ['youtube', 'instagram', 'facebook', 'tiktok'];

function makeAsk() {
  if (!stdin.isTTY) {
    return async () => {
      throw new Error('This step needs an interactive terminal (a value is missing). Re-run in your terminal, or pass the flag explicitly.');
    };
  }
  const rl = readline.createInterface({ input: stdin, output: stdout });
  const ask = (q) => rl.question(q);
  ask.close = () => rl.close();
  return ask;
}

// -------------------------------------------------------------- metadata ----

const LIMIT_CAPTION = 2200;
const LIMIT_DESC = 5000;

/**
 * Turn the handful of flags you pass into per-platform fields.
 * Hashtags are derived from --tags and appended where the platform expects them.
 */
function buildMeta(args, clip) {
  const title = typeof args.title === 'string' ? args.title.trim() : path.basename(clip.fileName, clip.ext);
  let description = typeof args.description === 'string' ? args.description.trim() : '';
  if (typeof args['description-file'] === 'string') {
    description = fs.readFileSync(args['description-file'], 'utf8').trim();
  }
  let caption = typeof args.caption === 'string' ? args.caption.trim() : '';
  if (typeof args['caption-file'] === 'string') {
    caption = fs.readFileSync(args['caption-file'], 'utf8').trim();
  }
  if (!caption) caption = description || title;
  if (!description) description = caption;

  const tags = splitList(args.tags).map((t) => t.replace(/^#+/, '').replace(/\s+/g, ''));
  const hashtags = tags.map((t) => `#${t}`).join(' ');

  const withTags = (text) => {
    const base = (text ?? '').trim();
    if (!hashtags) return base;
    return base.toLowerCase().includes(hashtags.split(' ')[0].toLowerCase()) ? base : `${base}\n\n${hashtags}`;
  };

  return {
    title,
    description: description.slice(0, LIMIT_DESC),
    caption: withTags(caption).slice(0, LIMIT_CAPTION),
    tags,
    hashtags,
    privacy: typeof args.privacy === 'string' ? args.privacy : undefined,
    categoryId: typeof args.category === 'string' ? args.category : '20',
    madeForKids: Boolean(args['made-for-kids']),
    tiktokPrivacy: typeof args['tiktok-privacy'] === 'string' ? args['tiktok-privacy'] : 'SELF_ONLY',
  };
}

/** Vertical + <=90s goes to Reels; everything else is a long-form video. */
function pickPostType(clip, platform) {
  if (platform === 'instagram') return 'reel';
  if (platform === 'facebook') return clip.orientation === 'vertical' && clip.duration <= 90 ? 'reel' : 'video';
  if (platform === 'youtube') return clip.orientation === 'vertical' && clip.duration <= 180 ? 'short' : 'video';
  return 'video';
}

// ------------------------------------------------------------------ auth ----

const AUTHABLE = {
  youtube: () => youtube.authenticate,
  meta: () => meta.authenticate,
  tiktok: () => tiktok.authenticate,
};

// ---------------------------------------------------------------- doctor ----

async function cmdDoctor() {
  const tokens = loadTokens();
  log(C.bold('\nclip-uploader doctor\n'));

  log(C.bold('Runtime'));
  ok(`node ${process.version}`);
  const ff = checkFfmpeg();
  ff.ok ? ok(`ffmpeg ${ff.version}`) : bad('ffmpeg/ffprobe not found on PATH');
  log(C.dim(`  project: ${ROOT}`));

  log(C.bold('\nCredentials'));

  if (tokens.youtube?.refresh_token) {
    try {
      const ch = await youtube.status(tokens.youtube);
      ok(`YouTube  ${C.dim(`${ch?.title ?? '?'} (${ch?.subscribers ?? '?'} subs)`)}`);
    } catch (err) {
      bad(`YouTube  ${err.message}`);
    }
  } else {
    skip('YouTube  not authorized -> node upload.mjs auth youtube');
  }

  if (tokens.meta?.page_token) {
    try {
      const st = await meta.status(tokens.meta);
      ok(`Facebook ${C.dim(`${st.page?.name ?? '?'} (${st.page?.fan_count ?? 0} followers)`)}`);
      if (st.instagram) {
        ok(`Instagram ${C.dim(`@${st.instagram.username} - ${st.instagram.followers_count ?? 0} followers`)}`);
      } else {
        skip('Instagram no business account linked to this Page -> link it in Meta Business Suite');
      }
    } catch (err) {
      bad(`Meta     ${err.message}`);
    }
  } else {
    skip('Meta     not authorized -> node upload.mjs auth meta');
  }

  if (tokens.tiktok?.refresh_token) {
    try {
      const u = await tiktok.status(tokens.tiktok);
      if (u) {
        ok(`TikTok   ${C.dim(`${u.display_name ?? 'connected'} (open_id ${String(tokens.tiktok.open_id ?? '').slice(0, 6)}...)`)}`);
      } else {
        ok(`TikTok   ${C.dim('connected (profile not readable - fine for posting)')}`);
      }
      if (!/video\.publish/.test(tokens.tiktok.scope ?? '')) {
        log(C.dim('         scope is video.upload: posts land as private drafts by design'));
      }
    } catch (err) {
      bad(`TikTok   ${err.message}`);
    }
  } else {
    skip('TikTok   not authorized -> node upload.mjs auth tiktok');
  }

  log('');
}

function checkFfmpeg() {
  const version = ffprobeVersion();
  return version ? { ok: true, version } : { ok: false };
}

// ---------------------------------------------------------------- upload ----

async function cmdUpload(args) {
  const file = args.file;
  if (!file || file === true) {
    throw new Error('Missing --file. Example: node upload.mjs upload --file "C:\\clips\\ep12.mp4" --title "My clip"');
  }

  let clip;
  try {
    clip = probe(file);
  } catch (err) {
    throw new Error(err.message);
  }

  const m = buildMeta(args, clip);
  const requested = splitList(args.platforms).length ? splitList(args.platforms) : ALL_PLATFORMS;
  const unknown = requested.filter((p) => !ALL_PLATFORMS.includes(p));
  if (unknown.length) throw new Error(`Unknown platform(s): ${unknown.join(', ')}. Choose from ${ALL_PLATFORMS.join(', ')}`);

  log(C.bold(`\n${clip.fileName}`));
  log(
    C.dim(
      `  ${clip.width}x${clip.height} (${clip.orientation}), ${clip.duration.toFixed(1)}s, ` +
        `${clip.sizeMb.toFixed(1)} MB, ${clip.videoCodec}${clip.hasAudio ? ` + ${clip.audioCodec}` : ', no audio'}`,
    ),
  );
  log(C.dim(`  title: ${m.title}`));
  if (m.tags.length) log(C.dim(`  tags:  ${m.tags.join(', ')}`));

  const tokens = loadTokens();
  const results = [];
  const dryRun = Boolean(args['dry-run']);
  if (dryRun) log(C.yellow('\nDRY RUN - nothing will be uploaded\n'));

  for (const platform of requested) {
    log(C.bold(`\n${platform}`));
    const postType = pickPostType(clip, platform);

    const warnings = validate(clip, platform, { postType });
    if (warnings.length) {
      for (const w of warnings) skip(w);
      results.push({ platform, ok: false, status: 'invalid', reason: warnings.join('; ') });
      continue;
    }

    // Dry run reports the plan even for platforms that are not connected yet,
    // so you can verify the metadata before doing any setup.
    if (dryRun) {
      log(C.dim(`  post type: ${postType}${isAuthenticated(platform, tokens) ? '' : ' (not connected yet)'}`));
      log(C.dim(`  would upload with: ${JSON.stringify(previewPayload(platform, m, clip), null, 2).replace(/\n/g, '\n  ')}`));
      results.push({ platform, ok: true, status: 'dry-run' });
      continue;
    }

    if (!isAuthenticated(platform, tokens)) {
      skip(`not connected -> node upload.mjs auth ${platform === 'instagram' || platform === 'facebook' ? 'meta' : platform}`);
      results.push({ platform, ok: false, status: 'not-authorized' });
      continue;
    }

    const prior = alreadyPublished(clip.path, platform);
    if (prior && !args.force) {
      skip(`already uploaded ${new Date(prior.at).toLocaleString()} -> ${prior.url ?? prior.id ?? ''} (use --force to redo)`);
      results.push({ platform, ok: true, status: 'already-done', url: prior.url, id: prior.id });
      continue;
    }

    log(C.dim(`  post type: ${postType}`));

    try {
      const started = Date.now();
      const out = await dispatch(platform, postType, {
        clip,
        meta: m,
        creds: credsFor(platform, tokens),
        log,
      });
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      ok(`${out.id ?? 'published'} ${C.dim(`(${secs}s)`)}`);
      if (out.url) log(C.dim(`       ${out.url}`));
      if (out.note) log(C.dim(`       ${out.note}`));

      recordUpload({ key: `${clip.path}::${clip.sizeBytes}`, platform, ok: true, id: out.id, url: out.url });
      results.push({ platform, ok: true, status: 'uploaded', url: out.url, id: out.id, note: out.note });
    } catch (err) {
      bad(err.message);
      const hints = hintsFor(err, platform);
      for (const h of hints) log(C.yellow(`       hint: ${h}`));
      recordUpload({ key: `${clip.path}::${clip.sizeBytes}`, platform, ok: false, error: err.message });
      results.push({ platform, ok: false, status: 'failed', error: err.message });
    }
  }

  summarise(results, dryRun);
  const failed = results.filter((r) => r.status === 'failed');
  return failed.length ? 1 : 0;
}

function isAuthenticated(platform, tokens) {
  if (platform === 'youtube') return Boolean(tokens.youtube?.refresh_token);
  if (platform === 'facebook' || platform === 'instagram') return Boolean(tokens.meta?.page_token);
  if (platform === 'tiktok') return Boolean(tokens.tiktok?.refresh_token);
  return false;
}

async function dispatch(platform, postType, ctx) {
  switch (platform) {
    case 'youtube':
      return youtube.publish(ctx);
    case 'facebook':
      return postType === 'reel' ? meta.publishFacebookReel(ctx) : meta.publishFacebookVideo(ctx);
    case 'instagram':
      return meta.publishInstagramReel(ctx);
    case 'tiktok':
      return tiktok.publish(ctx);
    default:
      throw new Error(`No handler for ${platform}`);
  }
}

function previewPayload(platform, m, clip) {
  switch (platform) {
    case 'youtube':
      return {
        title: m.title,
        description: m.description.slice(0, 120) + (m.description.length > 120 ? '...' : ''),
        tags: m.tags,
        categoryId: m.categoryId,
        privacyStatus: m.privacy ?? 'public',
      };
    case 'facebook':
      return { caption: m.caption, privacy: m.privacy ?? 'public' };
    case 'instagram':
      return { media_type: 'REELS', caption: m.caption };
    case 'tiktok':
      return {
        title: m.caption,
        privacy_level: m.tiktokPrivacy,
        video_size: clip.sizeBytes,
        ...tiktok.chunkPlan(clip.sizeBytes),
      };
    default:
      return {};
  }
}

function hintsFor(err, platform) {
  const msg = String(err.message ?? '');
  const hints = [];

  // An internal failure is our bug, not a platform or account problem - say so
  // instead of offering irrelevant advice.
  if (/is not a function|cannot read propert|undefined is not/i.test(msg)) {
    return ['this is a bug in the tool itself, not your account - the platform was never contacted'];
  }

  if (/Cannot call API for app/i.test(msg)) {
    hints.push('Meta revoked this token. Resetting the App Secret invalidates every token already issued.');
    return [...hints, 'Re-run: node upload.mjs auth meta'];
  }
  if (/expired|session has expired|validating access token|OAuthException/i.test(msg)) {
    hints.push(
      platform === 'youtube'
        ? 'node upload.mjs auth youtube'
        : platform === 'tiktok'
          ? 'node upload.mjs auth tiktok'
          : 'node upload.mjs auth meta',
    );
  }
  if (/quota/i.test(msg) && platform === 'youtube') {
    hints.push('YouTube allows ~6 uploads/day on the default quota. Request a quota increase in Google Cloud Console.');
  }
  if (/permission|permission_denied|scope/i.test(msg)) {
    hints.push('Your app may be missing a permission, or the account lost its role on the app.');
  }
  if (/ProcessingFailedError|processing/i.test(msg) && platform === 'instagram') {
    hints.push('Instagram refused to ingest the file. Its limit is pixels x frames, so long clips fail');
    hints.push('regardless of file size. Trim the clip, or leave Instagram out for this one.');
  }
  if (/not a business account|professional/i.test(msg)) {
    hints.push('Convert the Instagram account to Business/Creator in the Instagram app, then re-auth Meta.');
  }
  if (/reel|aspect|duration|resolution/i.test(msg)) {
    hints.push('Check the clip against the platform limits printed above (9:16, 3s-15min for Reels).');
  }
  return hints;
}

function summarise(results, dryRun) {
  log(C.bold('\nSummary'));
  const width = Math.max(...results.map((r) => r.platform.length));
  for (const r of results) {
    const label = r.platform.padEnd(width);
    if (r.status === 'uploaded') log(`  ${C.green('uploaded')}  ${label}  ${r.url ?? r.id ?? ''}`);
    else if (r.status === 'already-done') log(`  ${C.dim('already')}   ${label}  ${C.dim(r.url ?? '')}`);
    else if (r.status === 'dry-run') log(`  ${C.cyan('dry-run')}   ${label}`);
    else if (r.status === 'not-authorized') log(`  ${C.yellow('skipped')}   ${label}  ${C.dim('not connected')}`);
    else if (r.status === 'invalid') log(`  ${C.yellow('skipped')}   ${label}  ${C.dim(r.reason ?? '')}`);
    else log(`  ${C.red('failed')}    ${label}  ${C.dim(r.error ?? '')}`);
  }
  if (!dryRun) log(C.dim(`\n  log: ${path.join(ROOT, '.creds', 'uploads.jsonl')}\n`));
}

// ------------------------------------------------------------------ main ----

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];

  if (!cmd || cmd === 'help' || args.help) {
    log(`
${C.bold('clip-uploader')} - one clip, four platforms.

${C.bold('Setup')}
  node upload.mjs doctor              Check what is connected and what is missing
  node upload.mjs auth youtube        Connect YouTube (Google Cloud OAuth client)
  node upload.mjs auth meta           Connect Facebook Page + Instagram
  node upload.mjs auth tiktok         Connect TikTok

  TikTok refuses localhost redirects. Host legal/redirect.html, then:
  node upload.mjs auth tiktok --manual --redirect-uri https://YOUR-SITE/redirect.html
  node upload.mjs auth all            Do all three

${C.bold('If a login page shows an error')}
  node upload.mjs auth youtube --no-browser   print the URL instead of auto-opening it
  node upload.mjs auth youtube --manual       paste the code back by hand
  node upload.mjs auth youtube --redirect-uri http://localhost:8720/oauth2callback

${C.bold('Publish')}
  node upload.mjs upload --file "C:\\clips\\ep12.mp4" --title "Insane finish" --tags gaming,clutch

${C.bold('Flags')}
  --file <path>            required, the finished clip
  --title <text>           YouTube title (max 100 chars)
  --caption <text>         Instagram/TikTok/Facebook caption
  --caption-file <path>    read caption from a .txt file
  --description <text>     YouTube/Facebook description
  --description-file <p>   read description from a .txt file
  --tags a,b,c             hashtags for IG/TikTok, tags for YouTube
  --platforms y,t,i,f      default: all four
  --privacy public|unlisted|private
  --category <id>          YouTube category, default 20 (Gaming)
  --tiktok-privacy SELF_ONLY|PUBLIC_TO_EVERYONE
  --made-for-kids          sets the YouTube kids flag
  --force                  ignore the "already uploaded" ledger
  --dry-run                show what would happen, upload nothing
`);
    return 0;
  }

  switch (cmd) {
    case 'doctor':
      await cmdDoctor();
      return 0;
    case 'auth': {
      const ask = makeAsk();
      try {
        await cmdAuthWithSharedAsk(args, ask);
      } finally {
        ask.close?.();
      }
      return 0;
    }
    case 'upload':
      return await cmdUpload(args);
    default:
      throw new Error(`Unknown command "${cmd}". Try: node upload.mjs help`);
  }
}

// cmdAuth rebuilds its own ask; reuse a single readline instance instead.
async function cmdAuthWithSharedAsk(args, ask) {
  const target = args._[1] ?? 'all';
  const names = target === 'all' ? Object.keys(AUTHABLE) : [target];

  for (const name of names) {
    const fn = AUTHABLE[name];
    if (!fn) throw new Error(`Unknown platform "${name}". Use: youtube, meta, tiktok, all`);
    log(`\n${C.bold(`Authorizing ${name}...`)}`);
    const result = await fn()({ ask, log, args });
    ok(`${name} connected${result ? ` ${C.dim(JSON.stringify(result))}` : ''}`);
  }
  log(C.dim(`\n  saved to ${path.join(ROOT, '.creds', 'tokens.json')}`));
}

main()
  .then((code) => process.exit(code ?? 0))
  .catch((err) => {
    console.error(`\n${C.red('error')} ${err.message}\n`);
    process.exit(1);
  });
