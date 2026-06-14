/**
 * VPS Token Launcher
 *
 * Launches meme tokens on pump.fun directly from VPS via Telegram admin commands.
 * Flow:
 *   /auto_launch [id]  → show pending ideas OR start launch for specific idea
 *   Admin sends photo  → bot captures, uploads to Pinata, creates token
 *   W2/W3 buy with staggered timing
 *
 * Requirements (all already in VPS .env):
 *   WALLET_PRIVATE_KEY, PUMPFUN_WALLET_PRIVATE_KEY, PUMPFUN_WALLET_PRIVATE_KEY_2
 *   PINATA_JWT, SOLANA_RPC
 */

import axios from 'axios';
import FormData from 'form-data';
import bs58 from 'bs58';
import { Keypair, Connection, VersionedTransaction, Transaction } from '@solana/web3.js';
import { query } from '@lib/db';

const SOLANA_RPC     = process.env.SOLANA_RPC   ?? 'https://api.mainnet-beta.solana.com';
const PINATA_JWT     = process.env.PINATA_JWT    ?? '';
const PINATA_GATEWAY = process.env.PINATA_GATEWAY ?? 'https://gateway.pinata.cloud/ipfs/';
const BOT_TOKEN      = process.env.TELEGRAM_BOT_TOKEN ?? '';

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

export interface LaunchResult {
  ok:        boolean;
  mintAddr?: string;
  createTx?: string;
  imageUrl?: string;
  metaUri?:  string;
  error?:    string;
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
  catch { return null; }
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

// ─── Download Telegram photo ──────────────────────────────────────────────────

export async function downloadTgPhoto(fileId: string): Promise<Buffer> {
  const infoRes = await axios.get(`https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${fileId}`, { timeout: 10000 });
  const filePath = infoRes.data.result.file_path;
  const fileRes = await axios.get(`https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`, {
    responseType: 'arraybuffer', timeout: 30000
  });
  return Buffer.from(fileRes.data);
}

// ─── Main launch function ─────────────────────────────────────────────────────

export async function launchToken(cfg: LaunchConfig): Promise<LaunchResult> {
  if (!PINATA_JWT) return { ok: false, error: 'PINATA_JWT not configured' };

  const w1 = loadKp('WALLET_PRIVATE_KEY');
  if (!w1) return { ok: false, error: 'WALLET_PRIVATE_KEY not set' };

  const conn = new Connection(SOLANA_RPC, 'confirmed');

  try {
    // 1. Upload image to Pinata
    const imageCid = await pinataUploadBuffer(cfg.imageBuffer, `${cfg.ticker}_logo.png`, cfg.imageType);
    const imageUrl = `https://ipfs.io/ipfs/${imageCid}`;

    // 2. Upload metadata JSON
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

    // 3. Create token via pumpdotfun-sdk
    const { PumpFunSDK } = await import('pumpdotfun-sdk');
    const { AnchorProvider } = await import('@coral-xyz/anchor');
    const NodeWallet = (await import('@coral-xyz/anchor/dist/cjs/nodewallet')).default;

    const provider = new AnchorProvider(conn, new NodeWallet(w1), { commitment: 'confirmed' });
    const sdk = new PumpFunSDK(provider);
    const mintKp = Keypair.generate();
    const mintAddr = mintKp.publicKey.toBase58();

    const imageBlob = new Blob([cfg.imageBuffer], { type: cfg.imageType });

    const createResult = await sdk.createAndBuy(
      w1, mintKp,
      {
        name: cfg.name, symbol: cfg.ticker, description: cfg.description,
        file: imageBlob, twitter: cfg.twitter ?? '', telegram: cfg.telegram ?? '',
        website: cfg.website ?? 'https://gadai.shop', metadataUri: metaUri,
      },
      BigInt(Math.round(cfg.devBuySol * 1e9)),
      500n, // 5% slippage
      { unitLimit: 250000, unitPrice: 250000 }
    );

    if (!createResult.success) {
      return { ok: false, error: 'createAndBuy failed', mintAddr, imageUrl, metaUri };
    }

    const createTx = createResult.signature;
    console.info(`[launcher] ✅ Token created: ${mintAddr} | TX: ${createTx}`);

    // 4. Log to DB
    await query(`
      INSERT INTO coin_launches (mint_address, ticker, name, dev_buy_sol, image_url, meta_uri, create_tx, created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,now())
      ON CONFLICT DO NOTHING
    `, [mintAddr, cfg.ticker, cfg.name, cfg.devBuySol, imageUrl, metaUri, createTx]).catch(() => {});

    // 5. Staggered W2/W3 buys (non-blocking)
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
    SELECT id, ticker, name, description, score, status
    FROM coin_ideas
    WHERE status IN ('pending', 'approved')
    ORDER BY score DESC, created_at DESC
    LIMIT $1
  `, [limit]);
  return rows;
}
