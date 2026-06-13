/**
 * GAD AI Terminal — Twitter/X Auto-Poster
 *
 * Posts token alerts, launch announcements, and daily stats to @gadaisol.
 *
 * Required env vars:
 *   TWITTER_API_KEY, TWITTER_API_SECRET   — Consumer Key/Secret
 *   TWITTER_ACCESS_TOKEN, TWITTER_ACCESS_SECRET — User Access Token/Secret
 *
 * Usage:
 *   npx ts-node -p tsconfig.launch.json scripts/twitter-post.ts launch <mint>
 *   npx ts-node -p tsconfig.launch.json scripts/twitter-post.ts alert <text>
 *   npx ts-node -p tsconfig.launch.json scripts/twitter-post.ts stats
 */

import dotenv from 'dotenv';
import crypto from 'crypto';
import axios from 'axios';

dotenv.config();

const API_KEY    = process.env.TWITTER_API_KEY    ?? '';
const API_SECRET = process.env.TWITTER_API_SECRET ?? '';
const ACC_TOKEN  = process.env.TWITTER_ACCESS_TOKEN  ?? '';
const ACC_SECRET = process.env.TWITTER_ACCESS_SECRET ?? '';

// ── OAuth 1.0a signature ───────────────────────────────────────────────────
function oauthSign(method: string, url: string, params: Record<string, string>): string {
  const nonce = crypto.randomBytes(16).toString('hex');
  const ts    = Math.floor(Date.now() / 1000).toString();

  const oauthParams: Record<string, string> = {
    oauth_consumer_key:     API_KEY,
    oauth_nonce:            nonce,
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp:        ts,
    oauth_token:            ACC_TOKEN,
    oauth_version:          '1.0',
  };

  const all = { ...params, ...oauthParams };
  const base = Object.keys(all).sort()
    .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(all[k])}`)
    .join('&');

  const sigBase = `${method}&${encodeURIComponent(url)}&${encodeURIComponent(base)}`;
  const sigKey  = `${encodeURIComponent(API_SECRET)}&${encodeURIComponent(ACC_SECRET)}`;
  const sig     = crypto.createHmac('sha1', sigKey).update(sigBase).digest('base64');

  oauthParams.oauth_signature = sig;

  const header = 'OAuth ' + Object.keys(oauthParams).sort()
    .map(k => `${encodeURIComponent(k)}="${encodeURIComponent(oauthParams[k])}"`)
    .join(', ');

  return header;
}

async function tweet(text: string): Promise<void> {
  if (!API_KEY || !ACC_TOKEN || !ACC_SECRET) {
    console.error('❌ Twitter credentials not configured. Need TWITTER_ACCESS_TOKEN + TWITTER_ACCESS_SECRET.');
    console.log('📋 Tweet that would be posted:\n');
    console.log(text);
    return;
  }

  const url = 'https://api.twitter.com/2/tweets';
  const auth = oauthSign('POST', url, {});

  const resp = await axios.post(url, { text }, {
    headers: {
      'Authorization': auth,
      'Content-Type': 'application/json',
    },
  });

  console.log(`✅ Posted: https://x.com/gadaisol/status/${resp.data.data.id}`);
}

// ── Post templates ─────────────────────────────────────────────────────────

function launchTweet(mint: string, name: string, ticker: string): string {
  return `🚀 $${ticker} — ${name} is LIVE on pump.fun!

🤖 Scanned & verified by GAD AI Terminal
📊 AI Score: tracking...
🔗 Trade: https://pump.fun/coin/${mint}

Bot: @gadai_sol_bot | Site: gadai.shop
$SOL #Solana #memecoins #${ticker}`;
}

function alertTweet(ticker: string, score: number, stage: string, liq: number, mint: string): string {
  const emoji = score >= 70 ? '🔥' : score >= 50 ? '📈' : '👀';
  return `${emoji} $${ticker} — GAD Score ${score}/100

Stage: ${stage}
Liquidity: $${(liq/1000).toFixed(0)}k

🤖 GAD AI Terminal alpha alert
🔗 https://pump.fun/coin/${mint}

@gadai_sol_bot | gadai.shop
$SOL #Solana`;
}

function gadaiAnnounceTweet(mint: string): string {
  return `🤖 $GADAI — GAD AI Terminal is live!

Real-time Solana memecoin scanner
• AI scoring 0-100
• Auto-buy with smart TP/SL
• Whale tracker
• Futures signals

Your edge in the memecoin casino 📈

🔗 https://pump.fun/coin/${mint}
Bot: @gadai_sol_bot
Site: gadai.shop

$SOL #Solana #AI #memecoins`;
}

// ── CLI ─────────────────────────────────────────────────────────────────────
async function main() {
  const [,, cmd, ...args] = process.argv;

  if (cmd === 'launch') {
    const [mint, name = 'GAD AI Terminal', ticker = 'GADAI'] = args;
    if (!mint) { console.error('Usage: twitter-post.ts launch <mint> [name] [ticker]'); process.exit(1); }
    await tweet(launchTweet(mint, name, ticker));

  } else if (cmd === 'gadai') {
    const [mint] = args;
    if (!mint) { console.error('Usage: twitter-post.ts gadai <mint>'); process.exit(1); }
    await tweet(gadaiAnnounceTweet(mint));

  } else if (cmd === 'alert') {
    const [ticker, scoreStr, stage, liqStr, mint] = args;
    if (!ticker || !mint) { console.error('Usage: twitter-post.ts alert <ticker> <score> <stage> <liq> <mint>'); process.exit(1); }
    await tweet(alertTweet(ticker, Number(scoreStr), stage, Number(liqStr), mint));

  } else if (cmd === 'custom') {
    const text = args.join(' ');
    if (!text) { console.error('Usage: twitter-post.ts custom "Your tweet text"'); process.exit(1); }
    await tweet(text);

  } else {
    console.log('GAD AI Terminal Twitter Poster');
    console.log('Commands:');
    console.log('  launch <mint> [name] [ticker]        — post token launch tweet');
    console.log('  gadai <mint>                         — post $GADAI announcement');
    console.log('  alert <ticker> <score> <stage> <liq> <mint> — post scanner alert');
    console.log('  custom "text"                        — post any tweet');
  }
}

main().catch(err => { console.error('❌', err.message); process.exit(1); });
