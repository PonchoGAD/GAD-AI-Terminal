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
import {
  Keypair, Connection, PublicKey, LAMPORTS_PER_SOL,
  Transaction, ComputeBudgetProgram, VersionedTransaction,
} from '@solana/web3.js';
import { query } from '@lib/db';
import { cleanAndSlimTrendText } from '../utils/text-cleaner';

// ─── Config ───────────────────────────────────────────────────────────────────

const ENABLED        = process.env.TREND_AUTO_LAUNCH_ENABLED === 'true';
// DRY_RUN: runs full pipeline (concept gen, logo, Pinata upload) but skips createAndBuy.
// Set TREND_DRY_RUN=true to verify the pipeline without spending any SOL.
const DRY_RUN        = process.env.TREND_DRY_RUN === 'true';
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

// ─── Concept generation via Claude (primary) → OpenAI (fallback) → template ──

async function generateCoinConcept(trendText: string, tweetUrl: string): Promise<CoinConcept> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  // Clean text before sending to LLM — removes URLs/@mentions/special chars, caps at 250 chars
  const cleanText = cleanAndSlimTrendText(trendText, 250);

  const CONCEPT_PROMPT = (text: string) =>
    `X trend: "${text}"\n` +
    `Create pump.fun meme coin. Reply ONLY valid JSON:\n` +
    `{"ticker":"TICK","name":"Name","description":"<180 chars","imagePrompt":"cartoon meme coin logo, {theme}, cute, vibrant, white bg"}`;

  function parseConcept(raw: string): CoinConcept {
    const jsonStr = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
    const parsed = JSON.parse(jsonStr) as CoinConcept;
    parsed.ticker = parsed.ticker.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
    if (parsed.ticker.length < 2) parsed.ticker = 'TREND';
    return parsed;
  }

  // 1. Try Claude Haiku
  if (apiKey) {
    try {
      const Anthropic = (await import('@anthropic-ai/sdk')).default;
      const client = new Anthropic({ apiKey });
      const msg = await client.messages.create({
        model: 'claude-haiku-4-5-20251001', max_tokens: 150,
        messages: [{ role: 'user', content: CONCEPT_PROMPT(cleanText) }],
      });
      const parsed = parseConcept(((msg.content[0] as any).text ?? '').trim());
      console.info(`[trend-launch] Claude concept: $${parsed.ticker} — "${parsed.name}"`);
      return parsed;
    } catch (err: any) {
      const isCredits = err.status === 400 || (err.message ?? '').toLowerCase().includes('credit');
      console.warn(`[trend-launch] Claude failed: ${err.message}${isCredits ? ' — trying OpenAI fallback' : ''}`);

      // 2. OpenAI gpt-4o-mini fallback (only on credit errors)
      if (isCredits && process.env.OPENAI_API_KEY) {
        try {
          const res = await axios.post(
            'https://api.openai.com/v1/chat/completions',
            { model: 'gpt-4o-mini', max_tokens: 150,
              messages: [{ role: 'user', content: CONCEPT_PROMPT(cleanText) }] },
            { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
              timeout: 20000 }
          );
          const parsed = parseConcept((res.data.choices[0]?.message?.content ?? '').trim());
          console.info(`[trend-launch] OpenAI fallback concept: $${parsed.ticker} — "${parsed.name}"`);
          return parsed;
        } catch (oaiErr: any) {
          console.warn(`[trend-launch] OpenAI fallback failed: ${oaiErr.message} — using template`);
        }
      }
    }
  } else {
    console.info('[trend-launch] ANTHROPIC_API_KEY not set — using template concept');
  }

  // 3. Local template (last resort)
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
  const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 45000 });
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

// Private only — errors/warnings go ONLY to TG_PRIVATE_CHAT_ID, never to public channel.
// If TG_PRIVATE_CHAT_ID is not set, just logs to console.
async function tgNotifyPrivate(text: string): Promise<void> {
  if (!TG_TOKEN || !PRIVATE_CHAT) {
    // No private chat configured — log to console only, never public channel
    console.info(`[trend-launch] [private] ${text.replace(/\*/g, '').slice(0, 200)}`);
    return;
  }
  await axios.post(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    chat_id: PRIVATE_CHAT, text, parse_mode: 'Markdown', disable_web_page_preview: true,
  }, { timeout: 8000 }).catch(() => {});
}

// ─── Cooldown check ───────────────────────────────────────────────────────────

async function getLastLaunchTimestamp(): Promise<number> {
  if (lastLaunchAt > 0) return lastLaunchAt;
  try {
    const { rows } = await query<{ created_at: string }>(`
      SELECT created_at FROM coin_launches
      WHERE wallet_alias IN ('W2', 'W3')
      ORDER BY created_at DESC LIMIT 1
    `, []);
    if (rows[0]) return new Date(rows[0].created_at).getTime();
  } catch {}
  return 0;
}

// ─── Wallet configs — W2 + W3 only (W1 reserved for Raydium autobuy trading)
// RULE: no wallet ever buys into a token created by a different wallet.
const WALLET_CONFIGS = [
  { envKey: 'PUMPFUN_WALLET_PRIVATE_KEY',   alias: 'W2', buySol: 0.04 },
  { envKey: 'PUMPFUN_WALLET_PRIVATE_KEY_2', alias: 'W3', buySol: 0.02 },
];

// ─── 24h theme dedup — prevents launching the same theme twice in one day ─────

async function isThemeOnCooldown(theme: string): Promise<boolean> {
  try {
    const { rows } = await query<{ cnt: string }>(`
      SELECT COUNT(*) as cnt FROM coin_launches
      WHERE ticker = (
        SELECT ticker FROM coin_ideas
        WHERE description LIKE $1
          AND source = 'trend_auto_launch'
          AND created_at > now() - interval '24 hours'
        LIMIT 1
      )
    `, [`%${theme}%`]);
    // Simpler: check x_trend_signals action for the same theme in last 24h
    const { rows: rows2 } = await query<{ cnt: string }>(`
      SELECT COUNT(*) as cnt FROM x_trend_signals
      WHERE theme = $1
        AND action LIKE 'LAUNCHED%'
        AND created_at > now() - interval '24 hours'
    `, [theme]);
    return Number(rows2[0]?.cnt ?? 0) > 0;
  } catch { return false; } // fail-open: allow launch on DB error
}

// ─── Get top N qualifying trends (deduped by theme, 24h cooldown applied) ─────

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
      if (seen.has(row.theme)) continue;
      // Skip themes launched in last 24h (prevents spam from same narrative)
      if (await isThemeOnCooldown(row.theme)) {
        console.info(`[trend-launch] Theme ${row.theme} on 24h cooldown — skipping`);
        continue;
      }
      seen.add(row.theme);
      result.push(row);
      if (result.length >= limit) break;
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
  `, [ticker, name, description]).catch(() => {});

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

    // Description: AI concept + social links + source tweet
    const shortDesc = concept.description.slice(0, 130).trim();
    const sourceRef = trend.tweet_url ? `\n🔗 ${trend.tweet_url}` : '';
    const fullDescription = `${shortDesc}${sourceRef}\n\n📱 t.me/gadfamilytg | 🌐 gadai.shop`;

    const metaCid = await pinataUploadJson({
      name: concept.name, symbol: concept.ticker, description: fullDescription,
      image: imageUrl,
      website: 'https://gadai.shop',
      twitter: 'https://x.com/gadaisol',  // project X account
      telegram: 'https://t.me/gadfamilytg',
      showName: true, createdOn: 'https://pump.fun',
    }, `${concept.ticker}_metadata`);
    const metaUri = `${PINATA_GATEWAY}${metaCid}`;
    console.info(`[trend-launch] ${walletAlias} Meta → ${metaUri}`);

    // ── DRY_RUN: pipeline verified OK — skip actual TX / SOL spend ──────────────
    if (DRY_RUN) {
      console.info(`[trend-launch] [DRY-RUN] ${walletAlias} ✅ Pipeline OK — would launch $${concept.ticker} (${buySol} SOL dev buy)`);
      console.info(`[trend-launch] [DRY-RUN] ${walletAlias} Image: ${imageUrl}`);
      console.info(`[trend-launch] [DRY-RUN] ${walletAlias} Meta:  ${metaUri}`);
      await tgNotifyPrivate(`🔍 *[DRY-RUN] ${walletAlias}* — pipeline verified\n$${concept.ticker} "${concept.name}"\nImage: ${imageUrl}\nMeta: ${metaUri}`);
      return; // no createAndBuy, no SOL spent
    }
    // ────────────────────────────────────────────────────────────────────────────

    // pumpdotfun-sdk@1.4.2 createAndBuy is broken (pump.fun added new accounts to buy IX in Feb 2026).
    // Workaround: use SDK only for CREATE instruction, then PumpPortal for the dev buy.
    const conn = new Connection(SOLANA_RPC, 'confirmed');
    const { PumpFunSDK }    = await import('pumpdotfun-sdk');
    const { AnchorProvider } = await import('@coral-xyz/anchor');
    const NodeWallet         = (await import('@coral-xyz/anchor/dist/cjs/nodewallet')).default;

    const provider = new AnchorProvider(conn, new NodeWallet(kp), { commitment: 'confirmed' });
    const sdk      = new PumpFunSDK(provider);
    const mintKp   = Keypair.generate();
    const mintAddr = mintKp.publicKey.toBase58();

    // Step 1: CREATE token via SDK (create IX is not broken, only buy IX is)
    const createIx = await (sdk as any).getCreateInstructions(
      kp.publicKey, concept.name, concept.ticker, metaUri, mintKp
    );
    const cuIx    = ComputeBudgetProgram.setComputeUnitLimit({ units: 250_000 });
    const cuPrice = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 250_000 });
    const createTxObj = new Transaction().add(cuIx, cuPrice);
    if (createIx instanceof Transaction) {
      createIx.instructions.forEach((ix: any) => createTxObj.add(ix));
    } else {
      createTxObj.add(createIx);
    }
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
    createTxObj.recentBlockhash = blockhash;
    createTxObj.feePayer = kp.publicKey;
    createTxObj.sign(kp, mintKp);
    const createSig = await conn.sendRawTransaction(createTxObj.serialize(), { skipPreflight: false, maxRetries: 3 });
    await conn.confirmTransaction({ signature: createSig, blockhash, lastValidBlockHeight }, 'confirmed');
    console.info(`[trend-launch] ${walletAlias} ✅ Token created: ${mintAddr} TX: ${createSig}`);

    // Step 2: DEV BUY via PumpPortal (wait for bonding curve to be indexed)
    await new Promise(r => setTimeout(r, 4000));
    const buyResp = await axios.post(
      'https://pumpportal.fun/api/trade-local',
      {
        publicKey: kp.publicKey.toBase58(), action: 'buy', mint: mintAddr,
        amount: buySol, denominatedInSol: 'true', slippage: 30,
        priorityFee: 0.003, pool: 'pump',
      },
      { responseType: 'arraybuffer', timeout: 25000 }
    );
    const buyBytes = new Uint8Array(buyResp.data as ArrayBuffer);
    const buyTx    = VersionedTransaction.deserialize(buyBytes);
    buyTx.sign([kp]);
    const buySig = await conn.sendTransaction(buyTx, { skipPreflight: true, maxRetries: 3 });
    await conn.confirmTransaction(buySig, 'confirmed');
    console.info(`[trend-launch] ${walletAlias} ✅ Dev buy: ${buySol} SOL TX: ${buySig}`);

    // Verify tokens landed — createAndBuy is atomic so success=true means tokens should be there
    const tokenAmt = await verifyTokensReceived(conn, kp, mintAddr);
    if (tokenAmt > 0) {
      console.info(`[trend-launch] ${walletAlias} 🪙 ${tokenAmt.toLocaleString()} tokens received`);
    } else {
      console.warn(`[trend-launch] ${walletAlias} 0 tokens after create — bonding curve issue`);
      await tgNotifyPrivate(`⚠️ *${walletAlias} 0 tokens after create*\n$${concept.ticker} \`${mintAddr}\``);
    }

    await recordLaunch(trend.id, concept.ticker, concept.name, fullDescription,
      mintAddr, trend.tweet_url, walletAlias, kp.publicKey.toBase58());

    const pumpUrl = `https://pump.fun/coin/${mintAddr}`;
    await tgNotify(
      `🚀 *AUTO-LAUNCHED* \\$${concept.ticker} [${walletAlias}]\n` +
      `Name: *${concept.name}*\n` +
      `Theme: *${trend.theme}* (engagement: ${trend.engagement})\n\n` +
      `${shortDesc}\n\n` +
      `[pump\\.fun](${pumpUrl})\n` +
      `CA: \`${mintAddr}\`\n` +
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
  if (DRY_RUN) console.info('[trend-launch] *** DRY_RUN=true — full pipeline runs but NO createAndBuy TX will fire ***');
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
    const minRequired = 0.05;  // rent (~0.016) + max dev buy (0.03) + gas buffer (0.004)
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
