// Is a given YouTube video a Short? Queries the public pages and reports what
// YouTube itself says.
//
//   node tools/check-shorts.mjs xpGc8-oLdYs
//
// Useful because a Short opened via a youtu.be / watch link renders in the
// normal player, which looks identical to a regular video.

const id = process.argv[2];
if (!id) {
  console.error('Usage: node tools/check-shorts.mjs <videoId>');
  process.exit(1);
}

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
};

function firstMatch(text, re) {
  const m = text.match(re);
  return m ? m[0] : null;
}

async function inspect(url, label) {
  const res = await fetch(url, { headers: HEADERS, redirect: 'manual' });
  const html = await res.text();

  const eligible = firstMatch(html, /"isShortsEligible"\s*:\s*(true|false)/);
  const pageType = firstMatch(html, /"webPageType"\s*:\s*"([A-Z_]+)"/);
  const playerType = firstMatch(html, /"playerType"\s*:\s*"([A-Z_]+)"/);

  console.log(`\n${label}`);
  console.log(`  http status        : ${res.status}${res.headers.get('location') ? ` -> ${res.headers.get('location')}` : ''}`);
  console.log(`  html bytes         : ${html.length}`);
  console.log(`  isShortsEligible   : ${eligible ? eligible.split(':')[1].trim() : '(not present)'}`);
  console.log(`  webPageType        : ${pageType ? pageType.split(':')[1].trim() : '(not present)'}`);
  console.log(`  playerType         : ${playerType ? playerType.split(':')[1].trim() : '(not present)'}`);
  console.log(`  shorts player data : ${/reelWatchEndpoint|shortsPlayer/.test(html) ? 'yes' : 'no'}`);

  const title = firstMatch(html, /<meta name="title" content="([^"]*)"/);
  if (title) console.log(`  page title         : ${title.replace(/<meta name="title" content="/, '').replace(/"$/, '')}`);

  return { status: res.status, html };
}

const shorts = await inspect(`https://www.youtube.com/shorts/${id}`, `/shorts/${id}`);
const watch = await inspect(`https://www.youtube.com/watch?v=${id}`, `/watch?v=${id}`);

console.log('\nVerdict');
const eligibleTrue = /"isShortsEligible"\s*:\s*true/.test(shorts.html);
const eligibleFalse = /"isShortsEligible"\s*:\s*false/.test(shorts.html);
if (eligibleTrue) {
  console.log('  YES - YouTube marks this video as Shorts-eligible.');
  console.log('  A Short opened from a direct/watch link still renders in the normal player,');
  console.log('  so it can look like a regular video. Check the channel\'s Shorts tab.');
} else if (eligibleFalse) {
  console.log('  NO - YouTube reports isShortsEligible=false for this video.');
} else if (shorts.status === 200 && watch.status === 200) {
  console.log('  INCONCLUSIVE - no explicit flag in the HTML (YouTube may be serving a');
  console.log('  simplified or consent page). Open the channel page and look for a Shorts tab.');
} else {
  console.log(`  LIKELY NO - /shorts/ returned ${shorts.status}, which is what a non-Short does.`);
}
