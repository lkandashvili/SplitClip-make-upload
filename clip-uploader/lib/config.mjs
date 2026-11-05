// Paths, credential storage and the upload ledger.
// Everything sensitive lives in .creds/ which is gitignored.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CRED_DIR = path.join(ROOT, '.creds');
export const TOKENS_FILE = path.join(CRED_DIR, 'tokens.json');
export const LEDGER_FILE = path.join(CRED_DIR, 'uploads.jsonl');

const EMPTY = { youtube: null, meta: null, tiktok: null };

export function ensureCredDir() {
  fs.mkdirSync(CRED_DIR, { recursive: true, mode: 0o700 });
}

export function loadTokens() {
  try {
    const raw = fs.readFileSync(TOKENS_FILE, 'utf8');
    return { ...EMPTY, ...JSON.parse(raw) };
  } catch (err) {
    if (err.code === 'ENOENT') return { ...EMPTY };
    throw new Error(`Could not read ${TOKENS_FILE}: ${err.message}`);
  }
}

export function saveTokens(tokens) {
  ensureCredDir();
  const tmp = `${TOKENS_FILE}.tmp`;
  // 0o600: best effort on Windows, real protection on POSIX.
  fs.writeFileSync(tmp, JSON.stringify(tokens, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, TOKENS_FILE);
}

/** Mutate one platform's credential block and persist it. */
export function updatePlatform(platform, patch) {
  const tokens = loadTokens();
  tokens[platform] = { ...(tokens[platform] ?? {}), ...patch };
  saveTokens(tokens);
  return tokens[platform];
}

/**
 * Each platform owns exactly one block of tokens.json. Handing a platform the
 * whole file makes it read undefined for its own fields, which surfaces as a
 * misleading provider error ("The OAuth client was not found"). Always slice.
 */
const CREDS_BY_PLATFORM = { youtube: 'youtube', facebook: 'meta', instagram: 'meta', tiktok: 'tiktok' };

export function credsFor(platform, tokens) {
  const key = CREDS_BY_PLATFORM[platform];
  return key ? (tokens?.[key] ?? {}) : {};
}

/**
 * Credentials get copied out of dashboards, docs and chat, so they arrive with
 * surrounding quotes, a "client_key=" prefix, or a trailing space. Normalise
 * once, here, instead of debugging a mysterious provider error later.
 */
const PARAM_PREFIX =
  /^(client_key|client_secret|app_id|app_secret|client_id|client-id|client-secret|app-id|app-secret)\s*=\s*/i;
const EDGE_QUOTES = /^["'`\u2018\u2019\u201c\u201d]+|["'`\u2018\u2019\u201c\u201d]+$/g;

export function cleanCredential(value) {
  let s = String(value ?? '').trim();
  // Quotes first, then the prefix, then quotes again: the input may be
  // '"client_key=abc"', where the prefix is only reachable after unquoting.
  s = s.replace(EDGE_QUOTES, '').trim();
  s = s.replace(PARAM_PREFIX, '');
  s = s.replace(EDGE_QUOTES, '').trim();
  return s;
}

// ---------------------------------------------------------------- ledger ----
// The ledger stops a double upload when you re-run a command by accident.

export function fileKey(filePath) {
  const abs = path.resolve(filePath);
  const st = fs.statSync(abs);
  return `${abs}::${st.size}`;
}

export function readLedger() {
  let raw = '';
  try {
    raw = fs.readFileSync(LEDGER_FILE, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  return raw
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export function alreadyPublished(filePath, platform) {
  const key = fileKey(filePath);
  return readLedger().find((e) => e.key === key && e.platform === platform && e.ok === true) ?? null;
}

export function recordUpload(entry) {
  ensureCredDir();
  fs.appendFileSync(LEDGER_FILE, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
}
