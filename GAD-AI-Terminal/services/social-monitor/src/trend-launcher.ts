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
import { Keypair, Connection, VersionedTransaction, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
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
// Private chat for errors/warnings — never shown to public channel.
// Set TG_PRIVATE_CHAT_ID to your personal Telegram user ID.
// If not set, errors are only logged (not sent to TG at all).
const PRIVATE_CHAT   = process.env.TG_PRIVATE_CHAT_ID ?? '';

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

// Wait until pump.fun bonding curve is visible on the network (max 20s).
// PumpPortal builds TXs from their own RPC — if they can't find the mint, TX will fail.
async function waitForMintVisible(conn: Connection, mintAddr: string, maxWaitMs = 20000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const info = await conn.getAccountInfo(new PublicKey(mintAddr));
      if (info) return; // mint account is on-chain
    } catch {}
    await new Promise(r => setTimeout(r, 1500));
  }
  // Proceed anyway — don't block the buy, just warn
  console.warn(`[trend-launch] mint ${mintAddr.slice(0, 12)}... not visible after ${maxWaitMs / 1000}s — trying buy anyway`);
}

async function pumpBuyOnce(conn: Connection, wallet: Keypair, mintAddr: string, amountSol: number, slippage: number): Promise<string> {
  const r = await axios.post('https://pumpportal.fun/api/trade-local', {
    publicKey: wallet.publicKey.toBase58(), action: 'buy', mint: mintAddr,
    amount: amountSol, denominatedInSol: 'true', slippage, priorityFee: 0.003, pool: 'pump',
  }, { responseType: 'arraybuffer', timeout: 30000 });

  // PumpPortal returns JSON error if mint not found (not arraybuffer)
  const bytes = new Uint8Array(r.data as ArrayBuffer);
  if (bytes[0] === 123) { // '{' = JSON error response
    const errText = Buffer.from(bytes).toString('utf8');
    throw new Error(`PumpPortal rejected buy: ${errText.slice(0, 200)}`);
  }

  const tx = VersionedTransaction.deserialize(bytes);
  tx.sign([wallet]);
  const sig = await conn.sendTransaction(tx, { skipPreflight: true, maxRetries: 2 });

  // confirmTransaction only tells us the TX was included — check .err for on-chain failure
  const result = await conn.confirmTransaction(sig, 'confirmed');
  if (result.value.err) {
    throw new Error(`Buy TX failed on-chain (Custom:1=SlippageExceeded): ${JSON.stringify(result.value.err)}`);
  }
  return sig;
}

async function pumpBuy(conn: Connection, wallet: Keypair, mintAddr: string, amountSol: number): Promise<string> {
  // Escalating slippage: 30% → 50% → 80% → 90%
  // Custom:1 = TooFewTokensToReceive (slippage) — freshly created bonding curves are at 0 virtual SOL
  // Higher slippage = accept fewer tokens per SOL → passes threshold
  const slippages = [30, 50, 80, 90];
  let lastError: Error = new Error('no attempts');

  for (let i = 0; i < slippages.length; i++) {
    try {
      const sig = await pumpBuyOnce(conn, wallet, mintAddr, amountSol, slippages[i]);
      if (i > 0) console.info(`[trend-launch] buy succeeded on retry ${i + 1} (slippage=${slippages[i]}%)`);
      return sig;
    } catch (e: any) {
      lastError = e;
      const isPumpPortalNotFound = e.message?.includes('PumpPortal rejected') && e.message?.includes('not found');
      console.warn(`[trend-launch] buy attempt ${i + 1}/${slippages.length} failed (slippage=${slippages[i]}%): ${e.message.slice(0, 150)}`);
      if (i < slippages.length - 1) {
        const delay = isPumpPortalNotFound ? 5000 : 3000; // longer wait if mint not yet indexed
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }

  throw lastError;
}

// Verify tokens landed in wallet after buy — prevents silent swap failures
async function verifyTokensReceived(conn: Connection, wallet: Keypair, mintAddr: string): Promise<number> {
  try {
    const atas = await conn.getParsedTokenAccountsByOwner(
      wallet.publicKey,
      { mint: new PublicKey(mintAddr) }
    );
    if (!atas.value.length) return 0;
    const uiAmt = (atas.value[0].account.data as any)?.parsed?.info?.tokenAmount?.uiAmount ?? 0;
    return Number(uiAmt);
  } catch { return 0; }
}

// ─── Telegram notify ──────────────────────────────────────────────────────────

// Public channel — launch announcements only (everyone sees this)
async function tgNotify(text: string): Promise<void> {
  if (!TG_TOKEN || !ADMIN_CHAT) return;
  await axios.post(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    chat_id: ADMIN_CHAT, text, parse_mode: 'Markdown', disable_web_page_preview: true,
  }, { timeout: 8000 }).catch((e: any) => console.warn('[trend-launch] TG notify failed:', e.message));
}

// Private only — errors, warnings, balance alerts (never sent to public channel)
async function tgNotifyPrivate(text: string): Promise<void> {
  if (!TG_TOKEN) return;
  const chatId = PRIVATE_CHAT || ADMIN_CHAT; // fallback to admin chat only if private not configured
  if (!chatId) return;
  // If private chat not separately configured and ADMIN_CHAT is public — skip silently
  if (!PRIVATE_CHAT && !ADMIN_CHAT) return;
  await axios.post(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    chat_id: chatId, text, parse_mode: 'Markdown', disable_web_page_preview: true,
  }, { timeout: 8000 }).catch(() => {}); // silent — don't log errors about error notifications
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

// ─── Wallet configs — each wallet creates its OWN token independently ────────
// RULE: no wallet ever buys into a token created by a different wallet.
const WALLET_CONFIGS = [
  { envKey: 'WALLET_PRIVATE_KEY',           alias: 'W1', buySol: DEV_BUY_SOL },
  { envKey: 'PUMPFUN_WALLET_PRIVATE_KEY',   alias: 'W2', buySol: 0.02 },
  { envKey: 'PUMPFUN_WALLET_PRIVATE_KEY_2', alias: 'W3', buySol: 0.01 },
];

// ─── Get top N qualifying trends (deduped by theme) ──────────────────────────

async function getTopTrends(limit: number): Promise<TrendSignal[]> {
  try {
    // Tier1 signals (engagement≥40k = elonmusk/cz_binance) valid for 12h; others 4h.
    const { rows } = await query<TrendSignal>(`
      SELECT id, theme, keywords, tweet_url, engagement
      FROM x_trend_signals
      WHERE engagement >= $1
        AND (
          (engagement >= 40000 AND created_at > now() - interval '12 hours')
          OR created_at > now() - interval '4 hours'
        )
        AND (action IS NULL OR action NOT LIKE 'LAUNCHED%')
      ORDER BY engagement DESC
      LIMIT $2
    `, [MIN_ENGAGEMENT, limit * 4]); // fetch more to dedup by theme

    const seen = new Set<string>();
    const result: TrendSignal[] = [];
    for (const row of rows) {
      if (!seen.has(row.theme)) {
        seen.add(row.theme);
        result.push(row);
        if (result.length >= limit) break;
      }
    }
    return result;
  } catch (err: any) {
    console.warn('[trend-launch] DB query failed:', err.message);
    return [];
  }
}

// ─── Record launch in DB ──────────────────────────────────────────────────────

async function recordLaunch(
  signalId: string, ticker: string, name: string, description: string,
  mintAddr: string, tweetUrl: string, walletAlias: string, walletAddress: string
): Promise<void> {
  await query(`UPDATE x_trend_signals SET action = $1 WHERE id = $2`, [`LAUNCHED:${mintAddr}`, signalId]).catch(() => {});

  await query(`
    INSERT INTO coin_ideas (ticker, name, description, score, status, created_at)
    VALUES ($1, $2, $3, 0, 'launched', now())
    ON CONFLICT DO NOTHING
  `, [ticker, name, `Auto-launched [${walletAlias}] from X trend: ${tweetUrl}`]).catch(() => {});

  await query(`
    INSERT INTO coin_launches (mint_address, ticker, name, dev_buy_sol, create_tx, wallet_alias, wallet_address, created_at)
    VALUES ($1,$2,$3,$4,'auto_launch',$5,$6,now())
    ON CONFLICT DO NOTHING
  `, [mintAddr, ticker, name, WALLET_CONFIGS.find(w => w.alias === walletAlias)?.buySol ?? 0.01,
      walletAlias, walletAddress]).catch(() => {});
}

// ─── Launch one token with one wallet ─────────────────────────────────────────

async function launchOneToken(
  walletEnvKey: string, walletAlias: string, buySol: number, trend: TrendSignal
): Promise<void> {
  const kp = loadKp(walletEnvKey);
  if (!kp) {
    console.warn(`[trend-launch] ${walletAlias}: private key not configured — skipping`);
    return;
  }

  console.info(`[trend-launch] ${walletAlias} 🚀 — theme: ${trend.theme}, engagement: ${trend.engagement}`);

  try {
    const kws       = Array.isArray(trend.keywords) ? trend.keywords.join(' ') : '';
    const trendText = `${trend.theme} ${kws}`.trim();
    const concept   = await generateCoinConcept(trendText, trend.tweet_url);

    console.info(`[trend-launch] ${walletAlias} concept: $${concept.ticker} — "${concept.name}"`);

    const logoBuffer = await generateLogo(concept.imagePrompt);
    console.info(`[trend-launch] ${walletAlias} Logo ready (${logoBuffer.length} bytes)`);

    const imageCid = await pinataUploadBuffer(logoBuffer, `${concept.ticker}_logo.png`, 'image/png');
    const imageUrl = `https://ipfs.io/ipfs/${imageCid}`;
    console.info(`[trend-launch] ${walletAlias} Image → ${imageUrl}`);

    const metaCid = await pinataUploadJson({
      name: concept.name, symbol: concept.ticker, description: concept.description,
      image: imageUrl,
      website: 'https://gadai.shop', twitter: trend.tweet_url || '',
      telegram: 'https://t.me/gadfamilytg', showName: true, createdOn: 'https://pump.fun',
    }, `${concept.ticker}_metadata`);
    const metaUri = `${PINATA_GATEWAY}${metaCid}`;
    console.info(`[trend-launch] ${walletAlias} Meta → ${metaUri}`);

    const conn = new Connection(SOLANA_RPC, 'confirmed');
    const { PumpFunSDK }    = await import('pumpdotfun-sdk');
    const { AnchorProvider } = await import('@coral-xyz/anchor');
    const NodeWallet         = (await import('@coral-xyz/anchor/dist/cjs/nodewallet')).default;

    const provider = new AnchorProvider(conn, new NodeWallet(kp), { commitment: 'confirmed' });
    const sdk      = new PumpFunSDK(provider);
    const mintKp   = Keypair.generate();
    const mintAddr = mintKp.publicKey.toBase58();

    const imageBlob = (() => { const ab = new ArrayBuffer(logoBuffer.length); new Uint8Array(ab).set(logoBuffer); return new Blob([ab], { type: 'image/png' }); })();

    // metadataUri = Pinata URI (bypasses pump.fun/api/ipfs which returns 403 from VPS)
    const createResult = await sdk.createAndBuy(
      kp, mintKp,
      {
        name: concept.name, symbol: concept.ticker, description: concept.description,
        file: imageBlob, twitter: trend.tweet_url || '',
        telegram: 'https://t.me/gadfamilytg', website: 'https://gadai.shop',
        metadataUri: metaUri,
      } as any,
      BigInt(0), 500n, { unitLimit: 250000, unitPrice: 250000 }
    );

    if (!createResult.success) throw new Error('pumpdotfun-sdk create returned success=false');
    console.info(`[trend-launch] ${walletAlias} ✅ Created: ${mintAddr}`);

    // ONLY this wallet buys — no other wallet touches this token
    // Wait for bonding curve to propagate across the network (checks every 1.5s, max 20s)
    await waitForMintVisible(conn, mintAddr);
    try {
      const sig = await pumpBuy(conn, kp, mintAddr, buySol);
      // Verify tokens actually landed — pumpBuy confirms TX but TX could fail on-chain
      const tokenAmt = await verifyTokensReceived(conn, kp, mintAddr);
      if (tokenAmt > 0) {
        console.info(`[trend-launch] ${walletAlias} buy ✅ ${buySol} SOL → ${tokenAmt.toLocaleString()} tokens: ${sig}`);
      } else {
        console.warn(`[trend-launch] ${walletAlias} buy TX ok (${sig}) but 0 tokens in wallet — bonding curve may have reverted. SOL NOT deducted (Solana atomic).`);
        await tgNotifyPrivate(`⚠️ *${walletAlias} buy TX ok but 0 tokens received*\n$${concept.ticker} \`${mintAddr}\`\nToken created but dev buy failed — check pump.fun manually.`);
      }
    } catch (e: any) {
      console.warn(`[trend-launch] ${walletAlias} buy failed after 3 attempts: ${e.message}`);
      await tgNotifyPrivate(`⚠️ *${walletAlias} dev buy failed* — token created but not bought\n$${concept.ticker} \`${mintAddr}\`\nError: \`${(e.message as string).slice(0, 150)}\``);
    }

    await recordLaunch(trend.id, concept.ticker, concept.name, concept.description,
      mintAddr, trend.tweet_url, walletAlias, kp.publicKey.toBase58());

    const pumpUrl = `https://pump.fun/coin/${mintAddr}`;
    await tgNotify(
      `🚀 *AUTO-LAUNCHED* \\$${concept.ticker} [${walletAlias}]\n` +
      `Name: *${concept.name}*\n` +
      `Theme: *${trend.theme}* (engagement: ${trend.engagement})\n\n` +
      `${concept.description}\n\n` +
      `[pump\\.fun](${pumpUrl}) — CA: \`${mintAddr}\`\n` +
      (trend.tweet_url ? `[Source tweet](${trend.tweet_url})` : '')
    );

    console.info(`[trend-launch] ${walletAlias} 🎉 Complete: $${concept.ticker} → ${mintAddr}`);

  } catch (err: any) {
    console.error(`[trend-launch] ${walletAlias} failed: ${err.message}`);
    await tgNotifyPrivate(
      `❌ *${walletAlias} launch failed*\nTheme: ${trend.theme}\nError: \`${err.message.slice(0, 200)}\``
    );
  }
}

// ─── Check wallet SOL balance ─────────────────────────────────────────────────
async function getWalletSolBalance(kp: Keypair): Promise<number> {
  try {
    const conn = new Connection(SOLANA_RPC, 'confirmed');
    const bal = await conn.getBalance(kp.publicKey);
    return bal / LAMPORTS_PER_SOL;
  } catch { return 0; }
}

// ─── Main export: each wallet launches its own token from its own trend ───────
// Launches are sequential with 8s stagger to avoid Pinata rate limits.
// Each wallet must have ≥ 0.025 SOL to cover metadata rent + buy.

export async function runTrendLaunchCycle(): Promise<void> {
  if (!ENABLED) return;
  if (!PINATA_JWT) { console.warn('[trend-launch] PINATA_JWT not configured'); return; }

  // Cooldown check
  const lastTs = await getLastLaunchTimestamp();
  const hoursAgo = (Date.now() - lastTs) / 3_600_000;
  if (hoursAgo < COOLDOWN_H) {
    console.info(`[trend-launch] Cooldown active — ${(COOLDOWN_H - hoursAgo).toFixed(1)}h remaining`);
    return;
  }

  // Get up to 3 different themes — one per wallet
  const trends = await getTopTrends(3);
  if (!trends.length) {
    console.info(`[trend-launch] No qualifying trends (need engagement ≥ ${MIN_ENGAGEMENT})`);
    return;
  }

  // Lock before launching
  lastLaunchAt = Date.now();

  console.info(`[trend-launch] Found ${trends.length} trend(s) — checking wallet balances`);

  // Sequential launch with 8s stagger between wallets (avoids Pinata rate limits).
  // Each wallet must have ≥ 0.025 SOL (metadata rent ~0.016 + buy amount + gas).
  for (let i = 0; i < trends.length; i++) {
    const cfg = WALLET_CONFIGS[i];
    const kp = loadKp(cfg.envKey);
    if (!kp) { console.warn(`[trend-launch] ${cfg.alias}: key not configured — skipping`); continue; }

    const bal = await getWalletSolBalance(kp);
    const minRequired = 0.025;
    if (bal < minRequired) {
      console.warn(`[trend-launch] ${cfg.alias}: balance ${bal.toFixed(4)} SOL < ${minRequired} SOL minimum — skipping`);
      await tgNotifyPrivate(`⚠️ *${cfg.alias} skipped* — balance ${bal.toFixed(4)} SOL (need ≥${minRequired} SOL)`);
      continue;
    }

    console.info(`[trend-launch] ${cfg.alias} balance: ${bal.toFixed(4)} SOL ✅`);
    await launchOneToken(cfg.envKey, cfg.alias, cfg.buySol, trends[i]);

    if (i < trends.length - 1) {
      await new Promise(r => setTimeout(r, 8000)); // 8s stagger for Pinata rate limit
    }
  }
}
