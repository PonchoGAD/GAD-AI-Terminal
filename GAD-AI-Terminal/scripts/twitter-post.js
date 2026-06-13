#!/usr/bin/env node
/**
 * GAD AI Terminal — Twitter/X poster (plain Node.js, no dependencies)
 * Uses OAuth 2.0 access token from .env
 *
 * Usage:
 *   node scripts/twitter-post.js test
 *   node scripts/twitter-post.js gadai <mint>
 *   node scripts/twitter-post.js launch <mint> <ticker> [name]
 *   node scripts/twitter-post.js alert <ticker> <score> <liq> <mint>
 *   node scripts/twitter-post.js custom "text"
 */

'use strict';

const https   = require('https');
const fs      = require('fs');
const path    = require('path');

// Load .env manually (no dotenv dependency needed)
const envPath = path.resolve(__dirname, '../.env');
const env = {};
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const m = line.match(/^([^#=\s]+)\s*=\s*(.*)/);
    if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  });
}

const CLIENT_ID     = env.TWITTER_CLIENT_ID     || process.env.TWITTER_CLIENT_ID     || '';
const CLIENT_SECRET = env.TWITTER_CLIENT_SECRET || process.env.TWITTER_CLIENT_SECRET || '';
let   ACCESS_TOKEN  = env.TWITTER_ACCESS_TOKEN  || process.env.TWITTER_ACCESS_TOKEN  || '';
let   REFRESH_TOKEN = env.TWITTER_REFRESH_TOKEN || process.env.TWITTER_REFRESH_TOKEN || '';

// ── Minimal HTTPS request helper ──────────────────────────────────────────────
function httpsRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, data }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ── Token refresh ─────────────────────────────────────────────────────────────
async function refreshAccessToken() {
  if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN) {
    throw new Error('Missing TWITTER_CLIENT_ID / CLIENT_SECRET / REFRESH_TOKEN');
  }
  console.log('[twitter] Access token expired — refreshing...');

  const creds = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const body  = new URLSearchParams({
    grant_type:    'refresh_token',
    refresh_token: REFRESH_TOKEN,
    client_id:     CLIENT_ID,
  }).toString();

  const res = await httpsRequest({
    hostname: 'api.twitter.com',
    path:     '/2/oauth2/token',
    method:   'POST',
    headers: {
      'Authorization': `Basic ${creds}`,
      'Content-Type':  'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body),
    },
  }, body);

  if (res.status !== 200) {
    throw new Error(`Token refresh failed ${res.status}: ${JSON.stringify(res.data)}`);
  }

  ACCESS_TOKEN  = res.data.access_token;
  REFRESH_TOKEN = res.data.refresh_token || REFRESH_TOKEN;

  // Persist new tokens to .env
  if (fs.existsSync(envPath)) {
    let envContent = fs.readFileSync(envPath, 'utf8');
    envContent = envContent.replace(/^TWITTER_ACCESS_TOKEN=.*/m,  `TWITTER_ACCESS_TOKEN=${ACCESS_TOKEN}`);
    envContent = envContent.replace(/^TWITTER_REFRESH_TOKEN=.*/m, `TWITTER_REFRESH_TOKEN=${REFRESH_TOKEN}`);
    fs.writeFileSync(envPath, envContent, 'utf8');
    console.log('[twitter] ✅ Tokens refreshed and saved to .env');
  }
}

// ── Post tweet ────────────────────────────────────────────────────────────────
async function tweet(text) {
  if (!ACCESS_TOKEN) {
    console.log('⚠️  No TWITTER_ACCESS_TOKEN — preview mode:\n');
    console.log('─'.repeat(60));
    console.log(text);
    console.log('─'.repeat(60));
    return;
  }

  const body = JSON.stringify({ text });

  async function doPost(token) {
    return httpsRequest({
      hostname: 'api.twitter.com',
      path:     '/2/tweets',
      method:   'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type':  'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, body);
  }

  let res = await doPost(ACCESS_TOKEN);
  if (res.status === 401) {
    await refreshAccessToken();
    res = await doPost(ACCESS_TOKEN);
  }

  if (res.status === 201) {
    const id = res.data?.data?.id;
    console.log(`✅ Tweet posted: https://x.com/gadaisol/status/${id}`);
  } else {
    throw new Error(`Twitter API error ${res.status}: ${JSON.stringify(res.data)}`);
  }
}

// ── Templates ─────────────────────────────────────────────────────────────────
function tmplTest() {
  return `🤖 GAD AI Terminal Twitter integration test\n\nIf you see this — posting works! 🎉\nBot: @gadai_sol_bot | gadai.shop\n\n$SOL #Solana`;
}

function tmplGadai(mint) {
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

function tmplLaunch(mint, ticker, name) {
  return `🚀 $${ticker} — ${name} just launched on pump.fun!

Scanned & tracked by GAD AI Terminal 🤖
📊 AI Score: updating...

🔗 https://pump.fun/coin/${mint}
Bot: @gadai_sol_bot | gadai.shop

$SOL #Solana #${ticker} #memecoins`;
}

function tmplAlert(ticker, score, liq, mint) {
  const emoji = score >= 70 ? '🔥🔥' : score >= 55 ? '🔥' : '📈';
  return `${emoji} $${ticker} — GAD Score ${score}/100

💧 Liquidity: $${Math.round(liq / 1000)}k
🤖 GAD AI Terminal alpha alert

🔗 https://pump.fun/coin/${mint}
Bot: @gadai_sol_bot | gadai.shop

$SOL #Solana #memecoins`;
}

// ── CLI ───────────────────────────────────────────────────────────────────────
async function main() {
  const [,, cmd, ...args] = process.argv;

  switch (cmd) {
    case 'test':
      await tweet(tmplTest());
      break;

    case 'gadai': {
      const [mint] = args;
      if (!mint) { console.error('Usage: twitter-post.js gadai <mint>'); process.exit(1); }
      await tweet(tmplGadai(mint));
      break;
    }

    case 'launch': {
      const [mint, ticker = 'TOKEN', name = ticker] = args;
      if (!mint) { console.error('Usage: twitter-post.js launch <mint> <ticker> [name]'); process.exit(1); }
      await tweet(tmplLaunch(mint, ticker, name));
      break;
    }

    case 'alert': {
      const [ticker, scoreStr, liqStr, mint] = args;
      if (!ticker || !mint) { console.error('Usage: twitter-post.js alert <ticker> <score> <liq_usd> <mint>'); process.exit(1); }
      await tweet(tmplAlert(ticker, Number(scoreStr), Number(liqStr), mint));
      break;
    }

    case 'custom': {
      const text = args.join(' ');
      if (!text) { console.error('Usage: twitter-post.js custom "text"'); process.exit(1); }
      await tweet(text);
      break;
    }

    default:
      console.log(`GAD AI Terminal — Twitter Poster (OAuth 2.0)
Commands:
  test                                — post test tweet
  gadai <mint>                        — $GADAI launch announcement
  launch <mint> <ticker> [name]       — any token launch
  alert <ticker> <score> <liq> <mint> — scanner alpha alert
  custom "text"                       — any text`);
  }
}

main().catch(err => {
  console.error('❌', err.message);
  process.exit(1);
});
