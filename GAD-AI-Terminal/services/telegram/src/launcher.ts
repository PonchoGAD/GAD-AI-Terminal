/**
 * VPS Token Launcher
 *
 * Supports two launch modes:
 *  1. launchToken()  — W1 creates, W2/W3 buy (legacy single-wallet create)
 *  2. launchTriple() — all 3 wallets create the SAME token simultaneously (each gets own mint)
 *
 * Flow for triple:
 *   Upload image + metadata to Pinata ONCE → 3×createAndBuy in parallel
 *   Each wallet becomes "dev" of its own independent pump.fun listing.
 *
 * Auto-maintenance (called hourly):
 *   runLaunchedCoinMaintenance() — find mints launched 24h ago with <10 holders → sell
 *
 * Requirements (all in VPS .env):
 *   WALLET_PRIVATE_KEY, PUMPFUN_WALLET_PRIVATE_KEY, PUMPFUN_WALLET_PRIVATE_KEY_2
 *   PINATA_JWT, SOLANA_RPC, BIRDEYE_API_KEY, HELIUS_API_KEY
 */

import axios from 'axios';
import FormData from 'form-data';
import bs58 from 'bs58';
import {
  Keypair, Connection, VersionedTransaction, Transaction,
  ComputeBudgetProgram,
} from '@solana/web3.js';
import { query } from '@lib/db';

const SOLANA_RPC     = process.env.SOLANA_RPC   ?? 'https://api.mainnet-beta.solana.com';
const PINATA_JWT     = process.env.PINATA_JWT    ?? '';
const PINATA_GATEWAY = process.env.PINATA_GATEWAY ?? 'https://gateway.pinata.cloud/ipfs/';
const BOT_TOKEN      = process.env.TELEGRAM_BOT_TOKEN ?? '';
const BIRDEYE_API_KEY = process.env.BIRDEYE_API_KEY ?? '';
const HELIUS_API_KEY  = process.env.HELIUS_API_KEY ?? '';

// Min holders threshold below which we auto-sell the dev position after 24h
const MIN_HOLDERS_24H = Number(process.env.LAUNCH_MIN_HOLDERS_24H || '10');

// Daily auto-launch limit
const DAILY_LAUNCH_LIMIT = Number(process.env.DAILY_LAUNCH_LIMIT || '5');

// ─── Types ────────────────────────────────────────────────────────────────────

export interface LaunchConfig {
  name:        string;
  ticker:      string;
  description: string;
  imageBuffer: Buffer;
  imageType:   string;
  website?:    string;
  twitter?:    string;
  telegram?:   string;
  devBuySol:   number;
  w2BuySol:    number;
  w3BuySol:    number;
  w2DelayMs:   number;
  w3DelayMs:   number;
}

export interface TripleLaunchConfig {
  name:        string;
  ticker:      string;
  description: string;
  imageBuffer: Buffer;
  imageType:   string;
  website?:    string;
  twitter?:    string;
  telegram?:   string;
  devBuySol:   number;  // W1 dev buy SOL
  w2BuySol:    number;  // W2 dev buy SOL (creates own token)
  w3BuySol:    number;  // W3 dev buy SOL (creates own token)
  coinIdeaId?: string;
}

export interface LaunchResult {
  ok:        boolean;
  mintAddr?: string;
  createTx?: string;
  imageUrl?: string;
  metaUri?:  string;
  error?:    string;
}

export interface SingleLaunchResult {
  ok:          boolean;
  walletAlias: string;
  mintAddr?:   string;
  createTx?:   string;
  error?:      string;
}

export interface TripleLaunchResult {
  imageUrl: string;
  metaUri:  string;
  results:  SingleLaunchResult[];
}

// ─── Pinata helpers ───────────────────────────────────────────────────────────

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
  catch {
    try { return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(pk))); }
    catch { return null; }
  }
}

// ─── PumpPortal buy ───────────────────────────────────────────────────────────

async function pumpBuy(conn: Connection, wallet: Keypair, mintAddr: string, amountSol: number): Promise<string> {
  const r = await axios.post(
    'https://pumpportal.fun/api/trade-local',
    {
      publicKey: wallet.publicKey.toBase58(), action: 'buy', mint: mintAddr,
      amount: amountSol, denominatedInSol: 'true', slippage: 30,
      priorityFee: 0.003, pool: 'pump',
    },
    { responseType: 'arraybuffer', timeout: 25000 }
  );
  const bytes = new Uint8Array(r.data as ArrayBuffer);
  const tx = VersionedTransaction.deserialize(bytes);
  tx.sign([wallet]);
  const sig = await conn.sendTransaction(tx, { skipPreflight: true, maxRetries: 3 });
  await conn.confirmTransaction(sig, 'confirmed');
  // confirmTransaction only checks the TX was processed — not whether it succeeded on-chain.
  // A failed TX (Custom error 1=BondingCurveNotFound, 6022=SlippageExceeded) still gets "confirmed".
  const result = await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0 });
  if (result?.meta?.err) {
    throw new Error(`TX confirmed but failed on-chain: ${JSON.stringify(result.meta.err)}`);
  }
  return sig;
}

// ─── PumpPortal sell (all tokens) ─────────────────────────────────────────────

async function pumpSellAll(conn: Connection, wallet: Keypair, mintAddr: string): Promise<string> {
  // Check wallet has enough SOL for priority fee before attempting sell
  const balance = await conn.getBalance(wallet.publicKey);
  if (balance < 5_000_000) { // 0.005 SOL minimum
    throw new Error(`Insufficient SOL for fees: ${(balance / 1e9).toFixed(4)} SOL (need ≥0.005)`);
  }
  const r = await axios.post(
    'https://pumpportal.fun/api/trade-local',
    {
      publicKey: wallet.publicKey.toBase58(), action: 'sell', mint: mintAddr,
      amount: '100%', denominatedInSol: 'false', slippage: 30,
      priorityFee: 0.003, pool: 'pump',
    },
    { responseType: 'arraybuffer', timeout: 25000 }
  );
  const bytes = new Uint8Array(r.data as ArrayBuffer);
  const tx = VersionedTransaction.deserialize(bytes);
  tx.sign([wallet]);
  const sig = await conn.sendTransaction(tx, { skipPreflight: true, maxRetries: 3 });
  await conn.confirmTransaction(sig, 'confirmed');
  return sig;
}

// ─── Download Telegram photo ──────────────────────────────────────────────────

export async function downloadTgPhoto(fileId: string): Promise<Buffer> {
  const infoRes = await axios.get(`https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${fileId}`, { timeout: 10000 });
  const filePath = infoRes.data.result.file_path;
  const fileRes = await axios.get(`https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`, {
    responseType: 'arraybuffer', timeout: 30000
  });
  return Buffer.from(fileRes.data);
}

// ─── Download image from URL ──────────────────────────────────────────────────

export async function downloadImageUrl(url: string): Promise<Buffer> {
  const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 20000 });
  return Buffer.from(res.data);
}

// ─── Create single token for one wallet ──────────────────────────────────────

async function createSingleToken(
  wallet: Keypair,
  walletAlias: string,
  cfg: { name: string; ticker: string; description: string; website?: string; twitter?: string; telegram?: string; devBuySol: number },
  imageCid: string,
  imageUrl: string,
  metaUri: string,
  coinIdeaId?: string,
): Promise<SingleLaunchResult> {
  try {
    const conn = new Connection(SOLANA_RPC, 'confirmed');
    const { PumpFunSDK } = await import('pumpdotfun-sdk');
    const { AnchorProvider } = await import('@coral-xyz/anchor');
    const NodeWallet = (await import('@coral-xyz/anchor/dist/cjs/nodewallet')).default;

    const provider = new AnchorProvider(conn, new NodeWallet(wallet), { commitment: 'confirmed' });
    const sdk = new PumpFunSDK(provider);
    const mintKp = Keypair.generate();
    const mintAddr = mintKp.publicKey.toBase58();

    // Step 1: create token — uses only the `create` instruction (no buy, no broken 18-acc structure)
    // sdk.getCreateInstructions takes the pre-built Pinata metaUri directly — no IPFS upload needed
    const createIx = await (sdk as any).getCreateInstructions(
      wallet.publicKey, cfg.name, cfg.ticker, metaUri, mintKp
    );

    const cuIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 250_000 });
    const cuPrice = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 250_000 });

    const createTxObj = new Transaction().add(cuIx, cuPrice);
    // getCreateInstructions returns a Transaction — extract its instructions
    if (createIx instanceof Transaction) {
      createIx.instructions.forEach((ix: any) => createTxObj.add(ix));
    } else {
      createTxObj.add(createIx);
    }

    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
    createTxObj.recentBlockhash = blockhash;
    createTxObj.feePayer = wallet.publicKey;
    createTxObj.sign(wallet, mintKp);

    const createSig = await conn.sendRawTransaction(createTxObj.serialize(), {
      skipPreflight: false, maxRetries: 3,
    });
    await conn.confirmTransaction({ signature: createSig, blockhash, lastValidBlockHeight }, 'confirmed');
    console.info(`[launcher] ✅ ${walletAlias} token created: ${mintAddr} TX: ${createSig}`);

    // Step 2: dev buy via PumpPortal trade-local (server builds correct 18-account TX)
    if (cfg.devBuySol > 0) {
      try {
        // Wait for PumpPortal to index the bonding curve — 4s caused Custom error 1 (BondingCurveNotFound)
        await new Promise(r => setTimeout(r, 15000));
        const buySig = await pumpBuy(conn, wallet, mintAddr, cfg.devBuySol);
        console.info(`[launcher] ✅ ${walletAlias} dev buy TX: ${buySig}`);
      } catch (buyErr: any) {
        console.warn(`[launcher] ⚠️ ${walletAlias} dev buy failed (token created): ${buyErr.message}`);
      }
    }

    // Log to DB
    await query(`
      INSERT INTO coin_launches (mint_address, ticker, name, dev_buy_sol, image_url, meta_uri, create_tx,
                                  wallet_alias, wallet_address, coin_idea_id, created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now())
      ON CONFLICT DO NOTHING
    `, [mintAddr, cfg.ticker, cfg.name, cfg.devBuySol, imageUrl, metaUri, createSig,
        walletAlias, wallet.publicKey.toBase58(), coinIdeaId ?? null]).catch(() => {});

    return { ok: true, walletAlias, mintAddr, createTx: createSig };
  } catch (err: any) {
    console.error(`[launcher] ${walletAlias} createSingleToken failed:`, err.message);
    return { ok: false, walletAlias, error: err.message };
  }
}

// ─── Triple launch — all 3 wallets create same-brand token simultaneously ─────

export async function launchTriple(cfg: TripleLaunchConfig): Promise<TripleLaunchResult> {
  if (!PINATA_JWT) return { imageUrl: '', metaUri: '', results: [{ ok: false, walletAlias: 'all', error: 'PINATA_JWT not configured' }] };

  const w1 = loadKp('WALLET_PRIVATE_KEY');
  const w2 = loadKp('PUMPFUN_WALLET_PRIVATE_KEY');
  const w3 = loadKp('PUMPFUN_WALLET_PRIVATE_KEY_2');

  const wallets: Array<{ wallet: Keypair; alias: string; sol: number }> = [];
  if (w1 && cfg.devBuySol > 0) wallets.push({ wallet: w1, alias: 'W1', sol: cfg.devBuySol });
  if (w2 && cfg.w2BuySol > 0) wallets.push({ wallet: w2, alias: 'W2', sol: cfg.w2BuySol });
  if (w3 && cfg.w3BuySol > 0) wallets.push({ wallet: w3, alias: 'W3', sol: cfg.w3BuySol });

  if (!wallets.length) return { imageUrl: '', metaUri: '', results: [{ ok: false, walletAlias: 'all', error: 'No wallets configured' }] };

  // Upload image + metadata ONCE (shared across all 3 tokens — same branding)
  const imageCid = await pinataUploadBuffer(cfg.imageBuffer, `${cfg.ticker}_logo.png`, cfg.imageType);
  const imageUrl = `https://ipfs.io/ipfs/${imageCid}`;

  const meta = {
    name: cfg.name, symbol: cfg.ticker, description: cfg.description,
    image: imageUrl,
    website: cfg.website ?? 'https://gadai.shop',
    twitter: cfg.twitter ?? '',
    telegram: cfg.telegram ?? 'https://t.me/gadfamilytg',
    showName: true, createdOn: 'https://pump.fun',
  };
  const metaCid = await pinataUploadJson(meta, `${cfg.ticker}_metadata`);
  const metaUri = `${PINATA_GATEWAY}${metaCid}`;

  console.info(`[launcher] 🚀 Launching ${cfg.ticker} from ${wallets.length} wallets simultaneously`);
  console.info(`[launcher] Image: ${imageUrl} | Meta: ${metaUri}`);

  // All 3 wallets create their own token in parallel
  const results = await Promise.all(
    wallets.map(({ wallet, alias, sol }) =>
      createSingleToken(wallet, alias, {
        name: cfg.name, ticker: cfg.ticker, description: cfg.description,
        website: cfg.website, twitter: cfg.twitter, telegram: cfg.telegram,
        devBuySol: sol,
      }, imageCid, imageUrl, metaUri, cfg.coinIdeaId)
    )
  );

  // Update coin_idea status if linked
  if (cfg.coinIdeaId) {
    const successCount = results.filter(r => r.ok).length;
    if (successCount > 0) {
      await query(
        `UPDATE coin_ideas SET status='launched', auto_launch_at=now(), updated_at=now() WHERE id=$1`,
        [cfg.coinIdeaId]
      ).catch(() => {});
    }
  }

  return { imageUrl, metaUri, results };
}

// ─── Legacy single launch (W1 creates, W2/W3 buy) ────────────────────────────

export async function launchToken(cfg: LaunchConfig): Promise<LaunchResult> {
  if (!PINATA_JWT) return { ok: false, error: 'PINATA_JWT not configured' };

  const w1 = loadKp('WALLET_PRIVATE_KEY');
  if (!w1) return { ok: false, error: 'WALLET_PRIVATE_KEY not set' };

  const conn = new Connection(SOLANA_RPC, 'confirmed');

  try {
    const imageCid = await pinataUploadBuffer(cfg.imageBuffer, `${cfg.ticker}_logo.png`, cfg.imageType);
    const imageUrl = `https://ipfs.io/ipfs/${imageCid}`;

    const meta = {
      name: cfg.name, symbol: cfg.ticker, description: cfg.description,
      image: imageUrl,
      website: cfg.website ?? 'https://gadai.shop',
      twitter: cfg.twitter ?? '',
      telegram: cfg.telegram ?? 'https://t.me/gadfamilytg',
      showName: true, createdOn: 'https://pump.fun',
    };
    const metaCid = await pinataUploadJson(meta, `${cfg.ticker}_metadata`);
    const metaUri = `${PINATA_GATEWAY}${metaCid}`;

    const { PumpFunSDK } = await import('pumpdotfun-sdk');
    const { AnchorProvider } = await import('@coral-xyz/anchor');
    const NodeWallet = (await import('@coral-xyz/anchor/dist/cjs/nodewallet')).default;

    const provider = new AnchorProvider(conn, new NodeWallet(w1), { commitment: 'confirmed' });
    const sdk = new PumpFunSDK(provider);
    const mintKp = Keypair.generate();
    const mintAddr = mintKp.publicKey.toBase58();

    const imageBlob = new Blob([cfg.imageBuffer as unknown as ArrayBuffer], { type: cfg.imageType });

    const createResult = await sdk.createAndBuy(
      w1, mintKp,
      {
        name: cfg.name, symbol: cfg.ticker, description: cfg.description,
        file: imageBlob, twitter: cfg.twitter ?? '', telegram: cfg.telegram ?? '',
        website: cfg.website ?? 'https://gadai.shop', metadataUri: metaUri,
      } as any,
      BigInt(Math.round(cfg.devBuySol * 1e9)),
      500n,
      { unitLimit: 250000, unitPrice: 250000 }
    );

    if (!createResult.success) {
      return { ok: false, error: 'createAndBuy failed', mintAddr, imageUrl, metaUri };
    }

    const createTx = createResult.signature;
    console.info(`[launcher] ✅ Token created: ${mintAddr} | TX: ${createTx}`);

    await query(`
      INSERT INTO coin_launches (mint_address, ticker, name, dev_buy_sol, image_url, meta_uri, create_tx,
                                  wallet_alias, wallet_address, created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'W1',$8,now())
      ON CONFLICT DO NOTHING
    `, [mintAddr, cfg.ticker, cfg.name, cfg.devBuySol, imageUrl, metaUri, createTx,
        w1.publicKey.toBase58()]).catch(() => {});

    const w2 = loadKp('PUMPFUN_WALLET_PRIVATE_KEY');
    const w3 = loadKp('PUMPFUN_WALLET_PRIVATE_KEY_2');

    if (w2 && cfg.w2BuySol > 0) {
      setTimeout(async () => {
        try {
          const sig = await pumpBuy(conn, w2, mintAddr, cfg.w2BuySol);
          console.info(`[launcher] W2 buy ✅ ${cfg.w2BuySol} SOL: ${sig}`);
        } catch (e: any) { console.warn(`[launcher] W2 buy failed: ${e.message}`); }
      }, cfg.w2DelayMs);
    }

    if (w3 && cfg.w3BuySol > 0) {
      setTimeout(async () => {
        try {
          const sig = await pumpBuy(conn, w3, mintAddr, cfg.w3BuySol);
          console.info(`[launcher] W3 buy ✅ ${cfg.w3BuySol} SOL: ${sig}`);
        } catch (e: any) { console.warn(`[launcher] W3 buy failed: ${e.message}`); }
      }, cfg.w2DelayMs + cfg.w3DelayMs);
    }

    return { ok: true, mintAddr, createTx, imageUrl, metaUri };

  } catch (err: any) {
    console.error('[launcher] Launch failed:', err.message);
    return { ok: false, error: err.message };
  }
}

// ─── Get pending ideas from DB ────────────────────────────────────────────────

export async function getPendingIdeas(limit = 5) {
  const { rows } = await query<any>(`
    SELECT id, ticker, name, description, score, status, image_url
    FROM coin_ideas
    WHERE status IN ('pending', 'approved')
    ORDER BY score DESC, created_at DESC
    LIMIT $1
  `, [limit]);
  return rows;
}

// ─── Holder count check via Birdeye ──────────────────────────────────────────

async function checkHolderCount(mintAddr: string): Promise<number> {
  // Try Birdeye first (has exact holder count)
  if (BIRDEYE_API_KEY) {
    try {
      const r = await axios.get(
        `https://public-api.birdeye.so/defi/token_overview?address=${mintAddr}`,
        { headers: { 'X-API-KEY': BIRDEYE_API_KEY }, timeout: 8000 }
      );
      const holders = Number(r.data?.data?.holder ?? 0);
      if (holders > 0) return holders;
    } catch { /* fall through */ }
  }

  // Fallback: Helius getTokenLargestAccounts (returns top 20 holders — if < 20 results, that's the count)
  if (HELIUS_API_KEY) {
    try {
      const rpcUrl = SOLANA_RPC.includes('helius')
        ? SOLANA_RPC
        : `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
      const r = await axios.post(rpcUrl, {
        jsonrpc: '2.0', id: 'holders',
        method: 'getTokenLargestAccounts',
        params: [mintAddr, { commitment: 'confirmed' }],
      }, { timeout: 8000 });
      const accounts: any[] = r.data?.result?.value ?? [];
      const nonZero = accounts.filter((a: any) => Number(a.uiAmount ?? 0) > 0);
      if (nonZero.length > 0) return nonZero.length; // Up to 20
    } catch { /* fall through */ }
  }

  // Fallback: DexScreener (no holder count but confirms token exists)
  try {
    const r = await axios.get(
      `https://api.dexscreener.com/latest/dex/tokens/${mintAddr}`,
      { timeout: 6000 }
    );
    const pairs: any[] = r.data?.pairs ?? [];
    if (pairs.length > 0) return 15; // Token has liquidity = at least some holders, assume ok
  } catch { /* ignore */ }

  return 0; // Unknown / dead token
}

// ─── Multi-tier holder maintenance — sell launched tokens with no traction ────
//
// First sell check at 12h — gives the token a full half-day to get organic discovery.
// If only the dev holds at 12h (holders < 2), the token is dead → sell dev position.
// Final cleanup at 20-30h.

const MAINT_TIERS = [
  { minH: 12, maxH: 16, minHolders: 2 },  // 12-16h: sell if ≤1 holder (only dev = no buyers)
  { minH: 20, maxH: 30, minHolders: 3 },  // 20-30h: final cleanup
];

export async function runLaunchedCoinMaintenance(): Promise<void> {
  try {
    const conn = new Connection(SOLANA_RPC, 'confirmed');

    for (const tier of MAINT_TIERS) {
      const { rows } = await query<any>(`
        SELECT id, mint_address, ticker, wallet_alias, wallet_address, meta_uri
        FROM coin_launches
        WHERE created_at BETWEEN now() - interval '${tier.maxH} hours' AND now() - interval '${tier.minH} hours'
          AND wallet_alias IS NOT NULL
          AND COALESCE(dev_buy_sol, 0) > 0
          AND (meta_uri IS NULL OR meta_uri NOT LIKE '%[SOLD_LOW_HOLDERS%')
        ORDER BY created_at ASC
        LIMIT 20
      `);

      if (!rows.length) continue;
      console.info(`[launcher-maint] Tier ${tier.minH}-${tier.maxH}h: checking ${rows.length} tokens (min holders=${tier.minHolders})`);

      for (const launch of rows) {
        try {
          const holders = await checkHolderCount(launch.mint_address);
          console.info(`[launcher-maint] ${launch.ticker} (${launch.mint_address.slice(0, 8)}) — ${launch.wallet_alias}: ${holders} holders @ ${tier.minH}-${tier.maxH}h`);

          if (holders < tier.minHolders) {
            console.warn(`[launcher-maint] ⚠️ ${launch.ticker} ${launch.wallet_alias}: ${holders} holders < ${tier.minHolders} at ${tier.minH}h — selling dev position`);

            const envKey = launch.wallet_alias === 'W1' ? 'WALLET_PRIVATE_KEY'
                         : launch.wallet_alias === 'W2' ? 'PUMPFUN_WALLET_PRIVATE_KEY'
                         : 'PUMPFUN_WALLET_PRIVATE_KEY_2';
            const wallet = loadKp(envKey);
            if (!wallet) {
              console.warn(`[launcher-maint] ${launch.wallet_alias} keypair not available — skipping`);
              continue;
            }

            try {
              const sig = await pumpSellAll(conn, wallet, launch.mint_address);
              console.info(`[launcher-maint] ✅ ${launch.ticker} ${launch.wallet_alias} sold — TX: ${sig}`);
              await query(
                `UPDATE coin_launches SET meta_uri = COALESCE(meta_uri,'') || ' [SOLD_LOW_HOLDERS:' || $1 || '@' || $2 || 'h]' WHERE id=$3`,
                [holders, tier.minH, launch.id]
              ).catch(() => {});
            } catch (sellErr: any) {
              console.warn(`[launcher-maint] ❌ Sell failed for ${launch.ticker} ${launch.wallet_alias}: ${sellErr.message?.slice(0, 80)}`);
            }
          }

          await new Promise(r => setTimeout(r, 500));
        } catch (err: any) {
          console.warn(`[launcher-maint] Error checking ${launch.mint_address.slice(0, 8)}: ${err.message}`);
        }
      }
    }
  } catch (err: any) {
    console.warn('[launcher-maint] Maintenance cycle error:', err.message);
  }
}

// ─── Fresh trend helpers for auto-launch ──────────────────────────────────────

interface TrendInfo { theme: string; headline: string; source: string; }
interface AutoCoinIdea { name: string; ticker: string; description: string; }

async function pickFreshTrend(): Promise<TrendInfo | null> {
  // 1. x_trend_signals — last 30 min (populated every 15 min by social-monitor)
  //    Only top-tier influencer posts (engagement >= 10000 = Tier1 synthetic = truly viral)
  try {
    const { rows } = await query<any>(`
      SELECT theme, keywords, engagement
      FROM x_trend_signals
      WHERE created_at > now() - interval '30 minutes'
        AND engagement >= 10000
      ORDER BY engagement DESC
      LIMIT 1
    `);
    if (rows.length) {
      const kw = rows[0].keywords;
      const headline = Array.isArray(kw) ? kw.join(' ') : String(kw ?? 'trending crypto');
      return { theme: String(rows[0].theme ?? 'CRYPTO'), headline, source: 'x_trends' };
    }
  } catch { /* fall through */ }

  // 2. GDELT trend_clusters — last 2h, raised score threshold
  try {
    const { rows } = await query<any>(`
      SELECT main_title, final_score
      FROM trend_clusters
      WHERE created_at > now() - interval '2 hours'
        AND final_score >= 65
      ORDER BY final_score DESC
      LIMIT 1
    `);
    if (rows.length) {
      return { theme: 'GLOBAL', headline: rows[0].main_title, source: 'gdelt' };
    }
  } catch { /* fall through */ }

  // 3. CoinGecko trending — always fresh, direct API call
  try {
    const r = await axios.get('https://api.coingecko.com/api/v3/search/trending', { timeout: 8000 });
    const coins: any[] = r.data?.coins ?? [];
    if (coins.length) {
      const top = coins[0].item;
      return {
        theme: 'CRYPTO',
        headline: `${top.name} (${top.symbol.toUpperCase()}) is the #1 trending crypto globally`,
        source: 'coingecko',
      };
    }
  } catch { /* fall through */ }

  return null;
}

async function generateCoinIdeaFromTrend(trend: TrendInfo): Promise<AutoCoinIdea> {
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (ANTHROPIC_KEY) {
    try {
      const r = await axios.post('https://api.anthropic.com/v1/messages', {
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 150,
        messages: [{
          role: 'user',
          content: `Viral trend: "${trend.headline}"\n\nCreate a meme coin idea inspired by this. Reply ONLY with valid JSON:\n{"name":"Full Token Name","ticker":"3-5 UPPERCASE","description":"One catchy sentence tying it to the trend."}`,
        }],
      }, {
        headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
        timeout: 15000,
      });
      const text: string = r.data?.content?.[0]?.text ?? '';
      const m = text.match(/\{[\s\S]*?\}/);
      if (m) {
        const parsed = JSON.parse(m[0]);
        if (parsed?.name && parsed?.ticker && parsed?.description) return parsed as AutoCoinIdea;
      }
    } catch { /* fall through to template */ }
  }

  // Template fallback — works even without API key
  const words = String(trend.headline).replace(/[^a-zA-Z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
  const base = (words.find(w => w.length >= 3) ?? 'MEME').toUpperCase().slice(0, 5);
  const name = words.slice(0, 2).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ') + ' Coin';
  return {
    name,
    ticker: base,
    description: `The meme coin born from the viral moment: ${trend.headline.slice(0, 80)}.`,
  };
}

// ─── Auto-launch scheduler — W2 only, 1 coin per 12h from live fresh trends ──
//
// Flow: check W2 balance → fetch fresh trend RIGHT NOW → generate coin idea
//       via Claude → generate logo → upload Pinata → createSingleToken(W2)
// Sell at 12h if no external buyers (maintenance handles this).

export async function runAutoLaunchCycle(): Promise<void> {
  try {
    // === 1. Daily limit check ===
    const { rows: countRows } = await query<{ cnt: string }>(`
      SELECT COUNT(*) as cnt FROM coin_launches
      WHERE created_at >= CURRENT_DATE AND wallet_alias = 'W2'
    `);
    const launchedToday = Number(countRows[0]?.cnt ?? 0);
    const dailyLimit = Number(process.env.DAILY_LAUNCH_LIMIT || '2');
    if (launchedToday >= dailyLimit) {
      console.info(`[auto-launch] Daily limit reached (${launchedToday}/${dailyLimit}) — skipping`);
      return;
    }

    // === 2. Check W2 balance ===
    const w2 = loadKp('PUMPFUN_WALLET_PRIVATE_KEY');
    if (!w2) {
      console.warn('[auto-launch] PUMPFUN_WALLET_PRIVATE_KEY not set — skipping');
      return;
    }
    const conn = new Connection(SOLANA_RPC, 'confirmed');
    const w2Balance = await conn.getBalance(w2.publicKey);
    const MIN_LAUNCH_SOL = 0.025; // create rent ~0.020 + priority fees ~0.003 + buffer
    if (w2Balance < MIN_LAUNCH_SOL * 1e9) {
      console.warn(`[auto-launch] W2 (CFmHWpmQ) balance too low: ${(w2Balance / 1e9).toFixed(4)} SOL — need ≥${MIN_LAUNCH_SOL} SOL. Top up wallet to resume.`);
      return;
    }

    // === 3. Fetch FRESH trend right now (not stale DB cache) ===
    console.info('[auto-launch] Fetching fresh viral trend...');
    const trend = await pickFreshTrend();
    if (!trend) {
      console.warn('[auto-launch] No viral trend found — skipping this cycle');
      return;
    }
    console.info(`[auto-launch] Trend [${trend.source}/${trend.theme}]: ${trend.headline}`);

    // === 4. Generate coin idea from trend via Claude ===
    const coinIdea = await generateCoinIdeaFromTrend(trend);
    console.info(`[auto-launch] Coin: ${coinIdea.ticker} — ${coinIdea.name}`);

    // === 5. Generate logo via Pollinations.ai ===
    const prompt = `cute cartoon meme coin mascot, ${coinIdea.name} theme, ${trend.theme.toLowerCase()} vibes, vibrant colors, crypto logo style, white background, flat illustration`;
    const seed = Math.floor(Math.random() * 999999);
    const pollinationsUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=500&height=500&nologo=true&seed=${seed}`;
    let imageBuffer: Buffer;
    try {
      const imgRes = await axios.get(pollinationsUrl, { responseType: 'arraybuffer', timeout: 30000 });
      imageBuffer = Buffer.from(imgRes.data);
    } catch (err: any) {
      console.warn(`[auto-launch] Logo generation failed: ${err.message} — skipping`);
      return;
    }

    // === 6. Upload to Pinata ===
    const imageCid = await pinataUploadBuffer(imageBuffer, `${coinIdea.ticker}_logo.png`, 'image/png');
    const imageUrl = `https://ipfs.io/ipfs/${imageCid}`;
    const meta = {
      name: coinIdea.name, symbol: coinIdea.ticker, description: coinIdea.description,
      image: imageUrl, website: 'https://gadai.shop',
      twitter: 'https://x.com/gadaisol', telegram: 'https://t.me/gadfamilytg',
      showName: true, createdOn: 'https://pump.fun',
    };
    const metaCid = await pinataUploadJson(meta, `${coinIdea.ticker}_metadata`);
    const metaUri = `${PINATA_GATEWAY}${metaCid}`;
    console.info(`[auto-launch] Image: ${imageUrl}`);

    // === 7. Launch with W2 ONLY — tiny dev buy if balance allows ===
    const devBuySol = w2Balance >= 0.035 * 1e9 ? 0.003 : 0;
    console.info(`[auto-launch] Launching ${coinIdea.ticker} via W2 (devBuy: ${devBuySol} SOL)...`);

    const result = await createSingleToken(
      w2, 'W2',
      {
        name: coinIdea.name, ticker: coinIdea.ticker, description: coinIdea.description,
        website: 'https://gadai.shop', twitter: 'https://x.com/gadaisol',
        telegram: 'https://t.me/gadfamilytg', devBuySol,
      },
      imageCid, imageUrl, metaUri,
    );

    if (result.ok) {
      console.info(`[auto-launch] ✅ ${coinIdea.ticker} launched! CA: ${result.mintAddr}`);
      console.info(`[auto-launch] pump.fun: https://pump.fun/coin/${result.mintAddr}`);
      console.info(`[auto-launch] TX: ${result.createTx}`);
      console.info(`[auto-launch] Maintenance will check at 12h — sell if no buyers (holders < 2)`);
    } else {
      console.warn(`[auto-launch] ❌ ${coinIdea.ticker} FAILED: ${result.error}`);
    }
  } catch (err: any) {
    console.warn('[auto-launch] Cycle error:', err.message);
  }
}
