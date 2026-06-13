/**
 * GAD AI Terminal — Twitter/X Auto-Poster (OAuth 2.0)
 *
 * Uses OAuth 2.0 Access Token + Refresh Token for posting.
 * Auto-refreshes token when expired and saves new tokens back to .env on VPS.
 *
 * Required env vars:
 *   TWITTER_CLIENT_ID, TWITTER_CLIENT_SECRET
 *   TWITTER_ACCESS_TOKEN, TWITTER_REFRESH_TOKEN
 *
 * Usage:
 *   npx ts-node -p tsconfig.launch.json scripts/twitter-post.ts test
 *   npx ts-node -p tsconfig.launch.json scripts/twitter-post.ts gadai <mint>
 *   npx ts-node -p tsconfig.launch.json scripts/twitter-post.ts launch <mint> <ticker> <name>
 *   npx ts-node -p tsconfig.launch.json scripts/twitter-post.ts alert <ticker> <score> <liq> <mint>
 *   npx ts-node -p tsconfig.launch.json scripts/twitter-post.ts custom "text"
 */

import dotenv from 'dotenv';
import axios, { AxiosError } from 'axios';
import fs from 'fs';
import path from 'path';

dotenv.config();

const CLIENT_ID     = process.env.TWITTER_CLIENT_ID     ?? '';
const CLIENT_SECRET = process.env.TWITTER_CLIENT_SECRET ?? '';
let   ACCESS_TOKEN  = process.env.TWITTER_ACCESS_TOKEN  ?? '';
let   REFRESH_TOKEN = process.env.TWITTER_REFRESH_TOKEN ?? '';

const ENV_PATH = path.resolve(__dirname, '../.env');

// ── Token refresh ──────────────────────────────────────────────────────────
async function refreshAccessToken(): Promise<void> {
  if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN) {
    throw new Error('Missing TWITTER_CLIENT_ID / CLIENT_SECRET / REFRESH_TOKEN');
  }

  console.log('[twitter] Access token expired — refreshing...');

  const creds = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const resp = await axios.post(
    'https://api.twitter.com/2/oauth2/token',
    new URLSearchParams({
      grant_type:    'refresh_token',
      refresh_token: REFRESH_TOKEN,
      client_id:     CLIENT_ID,
    }).toString(),
    {
      headers: {
        'Authorization': `Basic ${creds}`,
        'Content-Type':  'application/x-www-form-urlencoded',
      },
    }
  );

  ACCESS_TOKEN  = resp.data.access_token;
  REFRESH_TOKEN = resp.data.refresh_token ?? REFRESH_TOKEN;

  // Write new tokens back to .env so they persist
  if (fs.existsSync(ENV_PATH)) {
    let env = fs.readFileSync(ENV_PATH, 'utf8');
    env = env.replace(/^TWITTER_ACCESS_TOKEN=.*/m,  `TWITTER_ACCESS_TOKEN=${ACCESS_TOKEN}`);
    env = env.replace(/^TWITTER_REFRESH_TOKEN=.*/m, `TWITTER_REFRESH_TOKEN=${REFRESH_TOKEN}`);
    fs.writeFileSync(ENV_PATH, env, 'utf8');
    console.log('[twitter] ✅ Tokens refreshed and saved to .env');
  }
}

// ── Post tweet ─────────────────────────────────────────────────────────────
async function tweet(text: string): Promise<void> {
  if (!ACCESS_TOKEN) {
    console.log('⚠️  No TWITTER_ACCESS_TOKEN — preview mode:\n');
    console.log('─'.repeat(60));
    console.log(text);
    console.log('─'.repeat(60));
    return;
  }

  async function doPost(token: string): Promise<any> {
    return axios.post(
      'https://api.twitter.com/2/tweets',
      { text },
      { headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );
  }

  try {
    const resp = await doPost(ACCESS_TOKEN);
    const id = resp.data?.data?.id;
    console.log(`✅ Tweet posted: https://x.com/gadaisol/status/${id}`);
  } catch (err: any) {
    const status = (err as AxiosError)?.response?.status;
    if (status === 401) {
      // Token expired — refresh and retry once
      await refreshAccessToken();
      const resp = await doPost(ACCESS_TOKEN);
      const id = resp.data?.data?.id;
      console.log(`✅ Tweet posted (after refresh): https://x.com/gadaisol/status/${id}`);
    } else {
      const body = JSON.stringify((err as AxiosError)?.response?.data ?? err.message);
      throw new Error(`Twitter API error ${status}: ${body}`);
    }
  }
}

// ── Tweet templates ────────────────────────────────────────────────────────
function tmplGadai(mint: string): string {
  return `🤖 $GADAI — GAD AI Terminal is LIVE on pump.fun!

Real-time Solana memecoin scanner
📊 AI scoring 0-100 per token
⚡️ Auto-buy with TP/SL
🐋 Whale tracker
📈 Futures signals

Your edge in the memecoin casino.

🔗 https://pump.fun/coin/${mint}
🤖 Bot: @gadai_sol_bot
🌐 gadai.shop

$SOL $GADAI #Solana #AI #memecoins`;
}

function tmplLaunch(mint: string, ticker: string, name: string): string {
  return `🚀 $${ticker} — ${name} just launched on pump.fun!

Scanned & tracked by GAD AI Terminal 🤖
📊 AI Score: updating...

🔗 https://pump.fun/coin/${mint}
Bot: @gadai_sol_bot | gadai.shop

$SOL #Solana #${ticker} #memecoins`;
}

function tmplAlert(ticker: string, score: number, liq: number, mint: string): string {
  const emoji = score >= 70 ? '🔥🔥' : score >= 55 ? '🔥' : '📈';
  return `${emoji} $${ticker} — GAD Score ${score}/100

💧 Liquidity: $${(liq / 1000).toFixed(0)}k
🤖 GAD AI Terminal alpha alert

🔗 https://pump.fun/coin/${mint}
Bot: @gadai_sol_bot | gadai.shop

$SOL #Solana #memecoins`;
}

function tmplTest(): string {
  return `🤖 GAD AI Terminal Twitter integration test

If you see this — posting works! 🎉
Bot: @gadai_sol_bot | gadai.shop

$SOL #Solana`;
}

// ── CLI ─────────────────────────────────────────────────────────────────────
async function main() {
  const [,, cmd, ...args] = process.argv;

  switch (cmd) {
    case 'test':
      await tweet(tmplTest());
      break;

    case 'gadai': {
      const [mint] = args;
      if (!mint) { console.error('Usage: twitter-post.ts gadai <mint_address>'); process.exit(1); }
      await tweet(tmplGadai(mint));
      break;
    }

    case 'launch': {
      const [mint, ticker = 'TOKEN', name = ticker] = args;
      if (!mint) { console.error('Usage: twitter-post.ts launch <mint> <ticker> [name]'); process.exit(1); }
      await tweet(tmplLaunch(mint, ticker, name));
      break;
    }

    case 'alert': {
      const [ticker, scoreStr, liqStr, mint] = args;
      if (!ticker || !mint) { console.error('Usage: twitter-post.ts alert <ticker> <score> <liq_usd> <mint>'); process.exit(1); }
      await tweet(tmplAlert(ticker, Number(scoreStr), Number(liqStr), mint));
      break;
    }

    case 'custom': {
      const text = args.join(' ');
      if (!text) { console.error('Usage: twitter-post.ts custom "Your tweet text"'); process.exit(1); }
      await tweet(text);
      break;
    }

    default:
      console.log(`GAD AI Terminal — Twitter Poster (OAuth 2.0)
Commands:
  test                              — post test tweet
  gadai <mint>                      — $GADAI launch announcement
  launch <mint> <ticker> [name]     — any token launch
  alert <ticker> <score> <liq> <mint> — scanner alert
  custom "text"                     — any text`);
  }
}

main().catch(err => {
  console.error('❌', err.message);
  process.exit(1);
});
