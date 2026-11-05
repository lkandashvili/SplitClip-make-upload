// Is the stored Meta page token still alive?
import { loadTokens, credsFor } from '../lib/config.mjs';

const creds = credsFor('facebook', loadTokens());
if (!creds.page_token) {
  console.log('no meta token stored');
  process.exit(0);
}

console.log('page_id      :', creds.page_id, `(${creds.page_name ?? '?'})`);
console.log('ig_user_id   :', creds.ig_user_id ?? '(none)');
console.log('token length :', creds.page_token.length);
console.log('token prefix :', creds.page_token.slice(0, 8) + '...');
console.log('token expiry :', creds.token_expires_at ? new Date(creds.token_expires_at).toISOString() : '(none recorded)');
console.log('');

async function probe(label, url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
  const text = (await r.text()).slice(0, 400);
  console.log(`${label}: ${r.status} ${text}`);
}

await probe('page lookup  ', `https://graph.facebook.com/v21.0/${creds.page_id}?fields=name,fan_count&access_token=${creds.page_token}`);
await probe('page reels   ', `https://graph.facebook.com/v21.0/${creds.page_id}/video_reels?upload_phase=start&file_size=1000&access_token=${creds.page_token}`);
await probe(
  'debug_token  ',
  `https://graph.facebook.com/v21.0/debug_token?input_token=${creds.page_token}&access_token=${creds.page_token}`,
);
