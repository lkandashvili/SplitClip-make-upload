// Check what TikTok thinks happened to a publish_id.
//   node tools/tiktok-status.mjs v_inbox_file~v2.123456789
import { loadTokens, credsFor } from '../lib/config.mjs';
import { accessToken } from '../lib/platforms/tiktok.mjs';

const publishId = process.argv[2];
if (!publishId) {
  console.error('usage: node tools/tiktok-status.mjs <publish_id>');
  process.exit(1);
}

const creds = credsFor('tiktok', loadTokens());
const token = await accessToken(creds);

const res = await fetch('https://open.tiktokapis.com/v2/post/publish/status/fetch/', {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=UTF-8' },
  body: JSON.stringify({ publish_id: publishId }),
});

console.log('HTTP', res.status);
console.log(await res.text());
