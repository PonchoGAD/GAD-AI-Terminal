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
  return sig;
}

// ─── PumpPortal sell (all tokens) ─────────────────────────────────────────────

async function pumpSellAll(conn: Connection, wallet: Keypair, mintAddr: string): Promise<string> {
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
        // Wait a few seconds for the bonding curve to be indexed
        await new Promise(r => setTimeout(r, 4000));
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
  if (w1) wallets.push({ wallet: w1, alias: 'W1', sol: cfg.devBuySol });
  if (w2) wallets.push({ wallet: w2, alias: 'W2', sol: cfg.w2BuySol });
  if (w3) wallets.push({ wallet: w3, alias: 'W3', sol: cfg.w3BuySol });

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
// Tiers (checked every hour):
//   2-4h:   < 3 holders  → nobody bought, completely dead
//   4-8h:   < 6 holders  → no early traction
//   8-14h:  < 10 holders → losing momentum
//   22-30h: < 15 holders → final cleanup (original logic with raised bar)
//
// "sold_low_holders" tag written to meta_uri to prevent re-selling in later tiers.

const MAINT_TIERS = [
  { minH: 2,  maxH: 4,  minHolders: 3  },
  { minH: 4,  maxH: 8,  minHolders: 6  },
  { minH: 8,  maxH: 14, minHolders: 10 },
  { minH: 22, maxH: 30, minHolders: 15 },
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

// ─── Auto-launch scheduler — 5 coins/day from approved coin_ideas ─────────────

export async function runAutoLaunchCycle(): Promise<void> {
  try {
    // Count launches today
    const { rows: countRows } = await query<{ cnt: string }>(`
      SELECT COUNT(*) as cnt FROM coin_launches
      WHERE created_at >= CURRENT_DATE
        AND wallet_alias IS NOT NULL
    `);
    const launchedToday = Number(countRows[0]?.cnt ?? 0);

    // coin_launches stores one row per wallet per launch batch, so divide by 3
    const batchesToday = Math.floor(launchedToday / 3);
    if (batchesToday >= DAILY_LAUNCH_LIMIT) {
      console.info(`[auto-launch] Daily limit reached (${batchesToday}/${DAILY_LAUNCH_LIMIT} batches)`);
      return;
    }

    // Find next approved idea with image_url
    const { rows: ideas } = await query<any>(`
      SELECT id, ticker, name, description, image_url, score
      FROM coin_ideas
      WHERE status IN ('approved')
        AND image_url IS NOT NULL
        AND auto_launch_at IS NULL
      ORDER BY score DESC, created_at ASC
      LIMIT 1
    `);

    if (!ideas.length) {
      console.info('[auto-launch] No approved ideas with image_url ready — skipping');
      return;
    }

    const idea = ideas[0];
    console.info(`[auto-launch] 🚀 Auto-launching ${idea.ticker} — ${idea.name} (score: ${idea.score})`);

    // Download image
    let imageBuffer: Buffer;
    try {
      imageBuffer = await downloadImageUrl(idea.image_url);
    } catch (err: any) {
      console.warn(`[auto-launch] Failed to download image for ${idea.ticker}: ${err.message}`);
      return;
    }

    // Mark as launching immediately to prevent duplicate launches
    await query(`UPDATE coin_ideas SET auto_launch_at=now(), updated_at=now() WHERE id=$1`, [idea.id]).catch(() => {});

    const result = await launchTriple({
      name:        idea.name,
      ticker:      idea.ticker,
      description: idea.description ?? `${idea.name} — the meme that moves markets.`,
      imageBuffer,
      imageType:   'image/png',
      website:     'https://gadai.shop',
      twitter:     'https://x.com/gadaisol',
      telegram:    'https://t.me/gadfamilytg',
      devBuySol:   0.08,
      w2BuySol:    0.04,
      w3BuySol:    0.02,
      coinIdeaId:  idea.id,
    });

    const successCount = result.results.filter(r => r.ok).length;
    console.info(`[auto-launch] ${idea.ticker} launched: ${successCount}/${result.results.length} wallets succeeded`);

    for (const r of result.results) {
      if (r.ok) console.info(`[auto-launch]   ${r.walletAlias}: ${r.mintAddr}`);
      else      console.warn(`[auto-launch]   ${r.walletAlias}: FAILED — ${r.error}`);
    }
  } catch (err: any) {
    console.warn('[auto-launch] Cycle error:', err.message);
  }
}
