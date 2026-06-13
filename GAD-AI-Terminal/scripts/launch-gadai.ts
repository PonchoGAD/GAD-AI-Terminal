/**
 * $GADAI Multi-Wallet Launch Script
 *
 * Launches "GAD AI Terminal" ($GADAI) on pump.fun from 3 wallets simultaneously.
 * Each wallet creates a buy transaction after the token is created by wallet 1.
 *
 * Required env vars:
 *   WALLET_PRIVATE_KEY           — main wallet EL4mS7Xg (creates token + dev buy)
 *   PUMPFUN_WALLET_PRIVATE_KEY   — pump wallet CFmHWpmQ (organic buy +12min)
 *   PUMPFUN_WALLET_PRIVATE_KEY_2 — HOT wallet DJ8Tq8vi (organic buy +28min)
 *   SOLANA_RPC                   — Helius RPC
 *   GADAI_LOGO_PATH              — path to logo PNG
 *
 * Staggered timing (looks organic, NOT coordinated):
 *   T+0min  W1 creates + dev buy 0.15 SOL
 *   T+12min W2 organic buy 0.08 SOL
 *   T+28min W3 organic buy 0.04 SOL
 *
 * Sell plan:
 *   W3 exits at 3-4x (first signal)
 *   W2 exits at 5-6x
 *   W1 HOLDS 2-4h, exits at peak / 8-10x (dev sells last = trust)
 *
 * Run: npx ts-node -p tsconfig.launch.json scripts/launch-gadai.ts
 */

import dotenv from 'dotenv';
import axios from 'axios';
import FormData from 'form-data';
import fs from 'fs';
import path from 'path';
import bs58 from 'bs58';
import { Keypair, Connection, VersionedTransaction, Transaction } from '@solana/web3.js';

dotenv.config();

const PUMPPORTAL_IPFS  = 'https://pumpportal.fun/api/ipfs';
const PUMPPORTAL_TRADE = 'https://pumpportal.fun/api/trade-local';
const SOLANA_RPC = process.env.SOLANA_RPC ?? 'https://api.mainnet-beta.solana.com';

const TOKEN_NAME   = 'GAD AI Terminal';
const TOKEN_SYMBOL = 'GADAI';
const TOKEN_DESC   = `GAD AI Terminal — Real-time Solana memecoin alpha.

AI-powered scanner finds tokens before they pump.
Scoring 0-100: narrative, momentum, risk, survival probability.
Auto-buy with smart TP/SL. Trade journal. Whale tracker.

Your edge in the memecoin casino. 🤖📈

@gadai_sol_bot on Telegram — free trial available.`;

const TOKEN_WEBSITE  = 'https://www.gadai.shop';
const TOKEN_TWITTER  = 'https://x.com/gadaisol';
const TOKEN_TELEGRAM = 'https://t.me/gadfamilytg';

// Buy amounts per wallet (SOL) — different amounts, NOT round identical numbers
const BUY_WALLET1 = 0.15;  // dev buy — sets price floor + signals commitment
const BUY_WALLET2 = 0.08;  // organic buyer 1 (W2 has 0.27 SOL, leaves 0.18 for bot)
const BUY_WALLET3 = 0.04;  // organic buyer 2 (W3 has 0.14 SOL, leaves 0.09 for HOT trades)

// Delay between wallet buys (ms) — stagger looks organic
const W2_DELAY_MS = 12 * 60 * 1000; // +12 minutes after launch
const W3_DELAY_MS = 16 * 60 * 1000; // +16 minutes after W2 (= T+28min total)

function loadKeypair(envKey: string): Keypair | null {
  const pk = process.env[envKey];
  if (!pk) { console.warn(`⚠️  ${envKey} not set — skipping`); return null; }
  try { return Keypair.fromSecretKey(bs58.decode(pk)); }
  catch { console.error(`❌ Invalid ${envKey} format`); return null; }
}

async function buyToken(
  connection: Connection,
  keypair: Keypair,
  mintSecretB58: string,
  metadataUri: string,
  buySol: number,
  action: 'create' | 'buy',
  label: string
): Promise<string | null> {
  const body: Record<string, unknown> = {
    publicKey: keypair.publicKey.toBase58(),
    action,
    mint: mintSecretB58,
    denominatedInSol: 'true',
    amount: buySol,
    slippage: 15,
    priorityFee: 0.005,
    pool: 'pump',
  };

  if (action === 'create') {
    body.tokenMetadata = { name: TOKEN_NAME, symbol: TOKEN_SYMBOL, uri: metadataUri };
  }

  try {
    const r = await axios.post(PUMPPORTAL_TRADE, body, { responseType: 'arraybuffer', timeout: 30_000 });
    const txBytes = new Uint8Array(r.data as ArrayBuffer);

    let sig: string;
    try {
      const tx = VersionedTransaction.deserialize(txBytes);
      const extraSigners = action === 'create' ? [Keypair.fromSecretKey(bs58.decode(mintSecretB58))] : [];
      tx.sign([keypair, ...extraSigners]);
      sig = await connection.sendTransaction(tx, { skipPreflight: false, maxRetries: 5 });
    } catch {
      const tx = Transaction.from(Buffer.from(txBytes));
      const extraSigners = action === 'create' ? [Keypair.fromSecretKey(bs58.decode(mintSecretB58))] : [];
      tx.partialSign(keypair, ...extraSigners);
      sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
    }

    await connection.confirmTransaction(sig, 'confirmed');
    console.log(`✅ ${label}: https://solscan.io/tx/${sig}`);
    return sig;
  } catch (err: any) {
    const body = err.response?.data ? Buffer.from(err.response.data).toString() : err.message;
    console.error(`❌ ${label} failed: ${body}`);
    return null;
  }
}

async function launch() {
  console.log('🚀 $GADAI Multi-Wallet Launch — GAD AI Terminal');
  console.log('='.repeat(55));

  const wallet1 = loadKeypair('WALLET_PRIVATE_KEY');
  const wallet2 = loadKeypair('PUMPFUN_WALLET_PRIVATE_KEY');
  const wallet3 = loadKeypair('PUMPFUN_WALLET_PRIVATE_KEY_2');

  if (!wallet1) { console.error('❌ WALLET_PRIVATE_KEY required (creator)'); process.exit(1); }

  const connection = new Connection(SOLANA_RPC, 'confirmed');

  for (const [w, label] of [[wallet1, 'Wallet 1 (creator)'], [wallet2, 'Wallet 2'], [wallet3, 'Wallet 3']] as [Keypair | null, string][]) {
    if (!w) continue;
    const bal = (await connection.getBalance(w.publicKey)) / 1e9;
    console.log(`💰 ${label}: ${w.publicKey.toBase58().slice(0, 8)}… → ${bal.toFixed(4)} SOL`);
  }

  // ── Step 1: Upload metadata to PumpPortal IPFS ─────────────────────────────
  const logoPath = process.env.GADAI_LOGO_PATH
    ?? process.argv.find(a => a.endsWith('.png'))
    ?? '/tmp/gadai_logo.png';

  if (!fs.existsSync(logoPath)) {
    console.error(`❌ Logo not found at ${logoPath}`);
    console.log('   Provide logo: export GADAI_LOGO_PATH=/path/to/logo.png');
    process.exit(1);
  }

  console.log(`\n📤 Uploading to IPFS (${path.basename(logoPath)})...`);
  const form = new FormData();
  form.append('file', fs.createReadStream(logoPath));
  form.append('name', TOKEN_NAME);
  form.append('symbol', TOKEN_SYMBOL);
  form.append('description', TOKEN_DESC);
  form.append('twitter', TOKEN_TWITTER);
  form.append('telegram', TOKEN_TELEGRAM);
  form.append('website', TOKEN_WEBSITE);
  form.append('showName', 'true');

  const ipfsResp = await axios.post(PUMPPORTAL_IPFS, form, {
    headers: form.getHeaders(),
    timeout: 30_000,
  });

  const metadataUri: string = ipfsResp.data?.metadataUri;
  if (!metadataUri) {
    console.error('❌ IPFS upload failed:', JSON.stringify(ipfsResp.data));
    process.exit(1);
  }
  console.log(`✅ Metadata URI: ${metadataUri}`);

  // ── Step 2: Generate mint keypair ──────────────────────────────────────────
  const mintKeypair = Keypair.generate();
  const mintSecretB58 = bs58.encode(mintKeypair.secretKey);
  const mintAddr = mintKeypair.publicKey.toBase58();
  console.log(`\n🪙  Mint address: ${mintAddr}`);

  // ── Step 3: Launch from wallet 1 (creates token + initial buy) ─────────────
  console.log(`\n[1/3] Creating token + buying ${BUY_WALLET1} SOL from Wallet 1...`);
  const sig1 = await buyToken(connection, wallet1, mintSecretB58, metadataUri, BUY_WALLET1, 'create', 'Wallet 1 create');
  if (!sig1) { console.error('❌ Token creation failed — aborting'); process.exit(1); }

  // ── Step 4: Staggered buys — each wallet waits separately (looks organic) ─
  if (wallet2) {
    const t2 = new Date(Date.now() + W2_DELAY_MS);
    console.log(`\n⏳ W2 buy in ${W2_DELAY_MS / 60000} min (at ${t2.toISOString()})...`);
    await new Promise(r => setTimeout(r, W2_DELAY_MS));
    console.log(`[2/3] Buying ${BUY_WALLET2} SOL from Wallet 2...`);
    await buyToken(connection, wallet2, mintAddr, '', BUY_WALLET2, 'buy', 'Wallet 2 buy');
  }

  if (wallet3) {
    const t3 = new Date(Date.now() + W3_DELAY_MS);
    console.log(`\n⏳ W3 buy in ${W3_DELAY_MS / 60000} min (at ${t3.toISOString()})...`);
    await new Promise(r => setTimeout(r, W3_DELAY_MS));
    console.log(`[3/3] Buying ${BUY_WALLET3} SOL from Wallet 3...`);
    await buyToken(connection, wallet3, mintAddr, '', BUY_WALLET3, 'buy', 'Wallet 3 buy');
  }

  // ── Result ─────────────────────────────────────────────────────────────────
  console.log('\n🎉 $GADAI LAUNCHED!');
  console.log('='.repeat(55));
  console.log(`🚀 pump.fun:  https://pump.fun/coin/${mintAddr}`);
  console.log(`🔗 Solscan:   https://solscan.io/account/${mintAddr}`);
  console.log(`🌐 Website:   ${TOKEN_WEBSITE}`);
  console.log(`🐦 Twitter:   ${TOKEN_TWITTER}`);
  console.log(`📣 Telegram:  ${TOKEN_TELEGRAM}`);
  console.log(`\n📢 Launch announcement (copy to t.me/gadfamilytg):`);
  console.log(`\n🤖 $GADAI — GAD AI Terminal is live on pump.fun!`);
  console.log(`AI-powered Solana scanner | Auto-buy | Whale tracker`);
  console.log(`\nhttps://pump.fun/coin/${mintAddr}`);
  console.log(`\nBot: @gadai_sol_bot | Site: gadai.shop`);
  console.log(`CA: ${mintAddr}`);
}

launch().catch(err => {
  console.error('❌ Launch failed:', err.message ?? err);
  process.exit(1);
});
