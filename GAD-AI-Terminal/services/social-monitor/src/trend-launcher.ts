/**
 * Trend Launcher — X Trend → pump.fun Auto-Launcher
 *
 * Pipeline:
 *   1. Scan x_trend_signals for high-engagement trends not yet launched
 *   2. Generate coin concept via Claude claude-haiku-4-5-20251001 (or template fallback)
 *   3. Generate logo via Pollinations.ai (free, no API key required)
 *   4. Upload image + metadata to Pinata IPFS
 *   5. Launch token on pump.fun via pumpdotfun-sdk (W1 dev buy)
 *   6. Record result in DB, send Telegram notification
 *
 * Config ENV (add to VPS .env):
 *   TREND_AUTO_LAUNCH_ENABLED=true    master switch (default false)
 *   TREND_LAUNCH_COOLDOWN_H=4         hours between launches (default 4)
 *   TREND_LAUNCH_DEV_BUY_SOL=0.03    SOL for dev buy (default 0.03)
 *   TREND_MIN_ENGAGEMENT=10000        minimum engagement to trigger (default 10000)
 *   ANTHROPIC_API_KEY=<key>           for concept generation (has template fallback)
 */

import axios from 'axios';
import FormData from 'form-data';
import bs58 from 'bs58';
import { Keypair, Connection, VersionedTransaction } from '@solana/web3.js';
import { query } from '@lib/db';

// ─── Config ───────────────────────────────────────────────────────────────────

const ENABLED        = process.env.TREND_AUTO_LAUNCH_ENABLED === 'true';
const COOLDOWN_H     = Number(process.env.TREND_LAUNCH_COOLDOWN_H ?? '4');
const DEV_BUY_SOL   = Number(process.env.TREND_LAUNCH_DEV_BUY_SOL ?? '0.03');
const MIN_ENGAGEMENT = Number(process.env.TREND_MIN_ENGAGEMENT ?? '10000');
const SOLANA_RPC     = process.env.SOLANA_RPC ?? 'https://api.mainnet-beta.solana.com';
const PINATA_JWT     = process.env.PINATA_JWT ?? '';
const PINATA_GATEWAY = process.env.PINATA_GATEWAY ?? 'https://gateway.pinata.cloud/ipfs/';
const TG_TOKEN       = process.env.TELEGRAM_BOT_TOKEN ?? '';
const ADMIN_CHAT     = process.env.ADMIN_CHAT_ID ?? process.env.TELEGRAM_ADMIN_CHAT_ID ?? '';

// In-process cooldown guard — blocks duplicate launches during the async operation
let lastLaunchAt = 0;

// ─── Types ────────────────────────────────────────────────────────────────────

interface CoinConcept {
  ticker:      string; // 3-6 uppercase chars
  name:        string; // display name
  description: string; // 100-200 chars
  imagePrompt: string; // Pollinations.ai prompt
}

interface TrendSignal {
  id:         string;
  theme:      string;
  keywords:   string[] | null;
  tweet_url:  string;
  engagement: number;
}

// ─── Concept generation via Claude ───────────────────────────────────────────

async function generateCoinConcept(trendText: string, tweetUrl: string): Promise<CoinConcept> {
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (apiKey) {
    try {
      const Anthropic = (await import('@anthropic-ai/sdk')).default;
      const client = new Anthropic({ apiKey });

      const msg = await client.messages.create({
        model:      'claude-haiku-4-5-20251001',
        max_tokens: 256,
        messages: [{
          role:    'user',
          content:
            `Based on this viral X (Twitter) post/trend, create a meme coin concept for pump.fun.\n` +
            `Keep it fun, punchy, crypto-community style. Must be unique and memorable.\n\n` +
            `Trend: "${trendText.slice(0, 300)}"\n` +
            `Source: ${tweetUrl || 'trending news'}\n\n` +
            `Reply with ONLY valid JSON (no markdown fences):\n` +
            `{"ticker":"TICK","name":"Full Token Name","description":"Fun description under 180 chars with crypto humor","imagePrompt":"simple meme coin logo, cartoon style, {theme imagery}, cute, vibrant colors, white background, flat illustration"}`,
        }],
      });

      const raw = ((msg.content[0] as any).text ?? '').trim();
      const jsonStr = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
      const parsed = JSON.parse(jsonStr) as CoinConcept;

      // Sanitize ticker: uppercase, 3-6 alphanumeric
      parsed.ticker = parsed.ticker.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
      if (parsed.ticker.length < 2) parsed.ticker = 'TREND';

      console.info(`[trend-launch] Claude concept: $${parsed.ticker} — "${parsed.name}"`);
      return parsed;
    } catch (err: any) {
      console.warn(`[trend-launch] Claude failed: ${err.message} — using template fallback`);
    }
  } else {
    console.info('[trend-launch] ANTHROPIC_API_KEY not set — using template concept');
  }

  return buildTemplateConcept(trendText);
}

function buildTemplateConcept(trendText: string): CoinConcept {
  const words  = trendText.replace(/[^a-zA-Z ]/g, ' ').split(/\s+/).filter(w => w.length > 3);
  const base   = (words[0] ?? 'MEME').toUpperCase().slice(0, 5);
  const ticker = (base + 'AI').slice(0, 6);

  return {
    ticker,
    name:        `${base} Ai Coin`,
    description: `Born from the hottest trend on X. Community-powered, GAD AI Terminal approved. To the moon! 🚀`,
    imagePrompt: `cute cartoon meme coin mascot, ${base.toLowerCase()} theme, vibrant colors, crypto logo style, white background, simple flat illustration`,
  };
}

// ─── Logo via Pollinations.ai (free, no API key) ──────────────────────────────

async function generateLogo(imagePrompt: string): Promise<Buffer> {
  const seed = Date.now() % 99999;
  const url  = `https://image.pollinations.ai/prompt/${encodeURIComponent(imagePrompt)}?width=500&height=500&nologo=true&seed=${seed}`;
  console.info('[trend-launch] Generating logo via Pollinations.ai…');
  const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 60000 });
  const buf = Buffer.from(res.data as ArrayBuffer);
  console.info(`[trend-launch] Logo ready (${buf.length} bytes)`);
  return buf;
}

// ─── Pinata IPFS upload ───────────────────────────────────────────────────────

async function pinataUploadBuffer(buf: Buffer, filename: string, mimetype: string): Promise<string> {
  const form = new FormData();
  form.append('file', buf, { filename, contentType: mimetype });
  form.append('pinataOptions', JSON.stringify({ cidVersion: 0 }));
  const res = await axios.post('https://api.pinata.cloud/pinning/pinFileToIPFS', form, {
    headers: { ...form.getHeaders(), Authorization: `Bearer ${PINATA_JWT}` },
    maxBodyLength: Infinity, timeout: 45000,
  });
  return res.data.IpfsHash as string;
}

async function pinataUploadJson(obj: object, name: string): Promise<string> {
  const res = await axios.post(
    'https://api.pinata.cloud/pinning/pinJSONToIPFS',
    { pinataContent: obj, pinataMetadata: { name }, pinataOptions: { cidVersion: 0 } },
    { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${PINATA_JWT}` }, timeout: 15000 }
  );
  return res.data.IpfsHash as string;
}

// ─── Keypair loader ───────────────────────────────────────────────────────────

function loadKp(envKey: string): Keypair | null {
  const pk = process.env[envKey];
  if (!pk) return null;
  try { return Keypair.fromSecretKey(bs58.decode(pk)); }
  catch { return null; }
}

// ─── PumpPortal buy ───────────────────────────────────────────────────────────

async function pumpBuy(conn: Connection, wallet: Keypair, mintAddr: string, amountSol: number): Promise<string> {
  const r = await axios.post('https://pumpportal.fun/api/trade-local', {
    publicKey: wallet.publicKey.toBase58(), action: 'buy', mint: mintAddr,
    amount: amountSol, denominatedInSol: 'true', slippage: 30, priorityFee: 0.003, pool: 'pump',
  }, { responseType: 'arraybuffer', timeout: 25000 });

  const bytes = new Uint8Array(r.data as ArrayBuffer);
  const tx = VersionedTransaction.deserialize(bytes);
  tx.sign([wallet]);
  const sig = await conn.sendTransaction(tx, { skipPreflight: true, maxRetries: 3 });
  await conn.confirmTransaction(sig, 'confirmed');
  return sig;
}

// ─── Telegram notify ──────────────────────────────────────────────────────────

async function tgNotify(text: string): Promise<void> {
  if (!TG_TOKEN || !ADMIN_CHAT) return;
  await axios.post(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    chat_id: ADMIN_CHAT, text, parse_mode: 'Markdown', disable_web_page_preview: true,
  }, { timeout: 8000 }).catch((e: any) => console.warn('[trend-launch] TG notify failed:', e.message));
}

// ─── Cooldown check ───────────────────────────────────────────────────────────

async function getLastLaunchTimestamp(): Promise<number> {
  if (lastLaunchAt > 0) return lastLaunchAt;
  try {
    const { rows } = await query<{ created_at: string }>(`
      SELECT created_at FROM coin_ideas
      WHERE source = 'trend_auto_launch'
      ORDER BY created_at DESC LIMIT 1
    `, []);
    if (rows[0]) return new Date(rows[0].created_at).getTime();
  } catch {}
  return 0;
}

// ─── Get best qualifying trend from DB ───────────────────────────────────────

async function getBestTrend(): Promise<TrendSignal | null> {
  try {
    const { rows } = await query<TrendSignal>(`
      SELECT id, theme, keywords, tweet_url, engagement
      FROM x_trend_signals
      WHERE engagement >= $1
        AND created_at > now() - interval '2 hours'
        AND (action IS NULL OR action NOT LIKE 'LAUNCHED%')
      ORDER BY engagement DESC
      LIMIT 1
    `, [MIN_ENGAGEMENT]);
    return rows[0] ?? null;
  } catch (err: any) {
    console.warn('[trend-launch] DB query failed:', err.message);
    return null;
  }
}

// ─── Record launch in DB ──────────────────────────────────────────────────────

async function recordLaunch(
  signalId: string, ticker: string, name: string, description: string,
  mintAddr: string, tweetUrl: string
): Promise<void> {
  await query(`UPDATE x_trend_signals SET action = $1 WHERE id = $2`, [`LAUNCHED:${mintAddr}`, signalId]).catch(() => {});

  await query(`
    INSERT INTO coin_ideas (ticker, name, description, source, status, created_at)
    VALUES ($1, $2, $3, 'trend_auto_launch', 'launched', now())
    ON CONFLICT DO NOTHING
  `, [ticker, name, `Auto-launched from X trend: ${tweetUrl}`]).catch(() => {});

  // Also record in coin_launches if that table exists
  await query(`
    INSERT INTO coin_launches (mint_address, ticker, name, dev_buy_sol, create_tx, created_at)
    VALUES ($1,$2,$3,$4,'auto_launch',now())
    ON CONFLICT DO NOTHING
  `, [mintAddr, ticker, name, DEV_BUY_SOL]).catch(() => {});
}

// ─── Main export: runs one launch cycle ──────────────────────────────────────

export async function runTrendLaunchCycle(): Promise<void> {
  if (!ENABLED) return;
  if (!PINATA_JWT) { console.warn('[trend-launch] PINATA_JWT not configured — skipping'); return; }

  const w1 = loadKp('WALLET_PRIVATE_KEY');
  if (!w1) { console.warn('[trend-launch] WALLET_PRIVATE_KEY not set — skipping'); return; }

  // Cooldown check
  const lastTs = await getLastLaunchTimestamp();
  const hoursAgo = (Date.now() - lastTs) / 3_600_000;
  if (hoursAgo < COOLDOWN_H) {
    const remaining = (COOLDOWN_H - hoursAgo).toFixed(1);
    console.info(`[trend-launch] Cooldown active — ${remaining}h until next launch`);
    return;
  }

  // Find qualifying trend
  const trend = await getBestTrend();
  if (!trend) {
    console.info(`[trend-launch] No qualifying trends (need engagement ≥ ${MIN_ENGAGEMENT})`);
    return;
  }

  console.info(`[trend-launch] 🚀 Auto-launch triggered — theme: ${trend.theme}, engagement: ${trend.engagement}`);

  // Lock immediately to prevent concurrent launches
  lastLaunchAt = Date.now();

  try {
    // 1. Generate coin concept
    const kws        = Array.isArray(trend.keywords) ? trend.keywords.join(' ') : '';
    const trendText  = `${trend.theme} ${kws}`.trim();
    const concept    = await generateCoinConcept(trendText, trend.tweet_url);

    // 2. Generate logo (Pollinations.ai)
    const logoBuffer = await generateLogo(concept.imagePrompt);

    // 3. Upload image to Pinata
    const imageCid = await pinataUploadBuffer(logoBuffer, `${concept.ticker}_logo.png`, 'image/png');
    const imageUrl = `https://ipfs.io/ipfs/${imageCid}`;
    console.info(`[trend-launch] Image → ${imageUrl}`);

    // 4. Upload metadata JSON to Pinata
    const metaCid = await pinataUploadJson({
      name: concept.name, symbol: concept.ticker, description: concept.description,
      image: imageUrl,
      website:  'https://gadai.shop',
      twitter:  trend.tweet_url || '',
      telegram: 'https://t.me/gadfamilytg',
      showName: true, createdOn: 'https://pump.fun',
    }, `${concept.ticker}_metadata`);
    const metaUri = `${PINATA_GATEWAY}${metaCid}`;

    // 5. Create token via pumpdotfun-sdk
    const conn = new Connection(SOLANA_RPC, 'confirmed');
    const { PumpFunSDK }   = await import('pumpdotfun-sdk');
    const { AnchorProvider } = await import('@coral-xyz/anchor');
    const NodeWallet         = (await import('@coral-xyz/anchor/dist/cjs/nodewallet')).default;

    const provider = new AnchorProvider(conn, new NodeWallet(w1), { commitment: 'confirmed' });
    const sdk      = new PumpFunSDK(provider);
    const mintKp   = Keypair.generate();
    const mintAddr = mintKp.publicKey.toBase58();

    const createResult = await sdk.createAndBuy(
      w1, mintKp,
      {
        name:        concept.name,
        symbol:      concept.ticker,
        description: concept.description,
        file:        (() => { const ab = new ArrayBuffer(logoBuffer.length); new Uint8Array(ab).set(logoBuffer); return new Blob([ab], { type: 'image/png' }); })(),
        twitter:     trend.tweet_url || '',
        telegram:    'https://t.me/gadfamilytg',
        website:     'https://gadai.shop',
      },
      BigInt(Math.round(DEV_BUY_SOL * 1e9)),
      500n, // 5% slippage
      { unitLimit: 250000, unitPrice: 250000 }
    );

    if (!createResult.success) {
      throw new Error('pumpdotfun-sdk createAndBuy returned success=false');
    }

    console.info(`[trend-launch] ✅ Token created: ${mintAddr} | TX: ${createResult.signature}`);

    // 6. Record in DB
    await recordLaunch(trend.id, concept.ticker, concept.name, concept.description, mintAddr, trend.tweet_url);

    // 7. Notify admin via Telegram
    const pumpUrl = `https://pump.fun/coin/${mintAddr}`;
    await tgNotify(
      `🚀 *AUTO-LAUNCHED* \\$${concept.ticker}\n` +
      `Name: *${concept.name}*\n` +
      `Theme: *${trend.theme}* (engagement: ${trend.engagement})\n\n` +
      `${concept.description}\n\n` +
      `[pump\\.fun](${pumpUrl}) — CA: \`${mintAddr}\`\n` +
      (trend.tweet_url ? `[Source tweet](${trend.tweet_url})` : '')
    );

    console.info(`[trend-launch] 🎉 Complete: $${concept.ticker} → ${mintAddr}`);

    // 8. Small W3 support buy after 5 min (non-blocking, optional)
    const w3 = loadKp('PUMPFUN_WALLET_PRIVATE_KEY_2');
    if (w3) {
      setTimeout(async () => {
        try {
          const sig = await pumpBuy(conn, w3, mintAddr, 0.01);
          console.info(`[trend-launch] W3 support buy ✅ ${sig}`);
        } catch (e: any) { console.warn(`[trend-launch] W3 buy failed: ${e.message}`); }
      }, 5 * 60 * 1000);
    }

  } catch (err: any) {
    console.error(`[trend-launch] Launch failed: ${err.message}`);
    lastLaunchAt = 0; // reset cooldown so we can retry next cycle
    await tgNotify(
      `❌ *Trend auto-launch failed*\nTheme: ${trend.theme}\nError: \`${err.message.slice(0, 200)}\``
    );
  }
}
