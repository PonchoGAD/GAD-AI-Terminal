/**
 * $GADAI Multi-Wallet Launch — GAD AI Terminal
 *
 * Pinata IPFS (publicly accessible) + PumpPortal trade-local create + staggered buys
 *
 * Required env vars:
 *   WALLET_PRIVATE_KEY           — W1 EL4mS7Xg (creator + dev buy 0.15 SOL)
 *   PUMPFUN_WALLET_PRIVATE_KEY   — W2 CFmHWpmQ (organic buy +12min, 0.08 SOL)
 *   PUMPFUN_WALLET_PRIVATE_KEY_2 — W3 DJ8Tq8vi (organic buy +28min, 0.04 SOL)
 *   PINATA_JWT                   — Pinata API JWT
 *   PINATA_GATEWAY               — optional, default: https://gateway.pinata.cloud/ipfs/
 *   SOLANA_RPC                   — Helius RPC
 *   GADAI_LOGO_PATH              — path to logo PNG (default: scripts/gadai_logo.png)
 *
 * Staggered timing (organic, NOT coordinated):
 *   T+0min  W1 creates + dev buy 0.15 SOL
 *   T+12min W2 organic buy 0.08 SOL
 *   T+28min W3 organic buy 0.04 SOL
 */

import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import FormData from 'form-data';
import bs58 from 'bs58';
import axios from 'axios';
import { Keypair, Connection, VersionedTransaction, Transaction } from '@solana/web3.js';
dotenv.config();

const PUMPPORTAL_TRADE = 'https://pumpportal.fun/api/trade-local';
const SOLANA_RPC       = process.env.SOLANA_RPC ?? 'https://api.mainnet-beta.solana.com';
const PINATA_JWT       = process.env.PINATA_JWT!;
const PINATA_GATEWAY   = process.env.PINATA_GATEWAY ?? 'https://gateway.pinata.cloud/ipfs/';
const LOGO_PATH        = process.env.GADAI_LOGO_PATH
  ?? path.join(__dirname, '..', 'scripts', 'gadai_logo.png');

const TOKEN_NAME    = 'GAD AI Terminal';
const TOKEN_SYMBOL  = 'GADAI';
const TOKEN_DESC    = 'GAD AI Terminal — Real-time Solana memecoin alpha. AI scanner finds tokens before they pump. Scoring 0-100: narrative, momentum, risk, survival. Auto-buy with smart TP/SL. Whale tracker. Your edge in the memecoin casino. @gadai_sol_bot on Telegram.';
const TOKEN_WEBSITE  = 'https://www.gadai.shop';
const TOKEN_TWITTER  = 'https://x.com/gadaisol';
const TOKEN_TELEGRAM = 'https://t.me/gadfamilytg';

const BUY_W1 = 0.15;
const BUY_W2 = 0.08;
const BUY_W3 = 0.04;
const W2_DELAY_MS = 12 * 60 * 1000;
const W3_DELAY_MS = 16 * 60 * 1000; // after W2 = T+28min total

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function pinataUploadFile(filePath: string, filename: string): Promise<string> {
  const form = new FormData();
  form.append('file', fs.createReadStream(filePath), { filename });
  form.append('pinataOptions', JSON.stringify({ cidVersion: 0 }));
  const res = await axios.post('https://api.pinata.cloud/pinning/pinFileToIPFS', form, {
    headers: { ...form.getHeaders(), Authorization: `Bearer ${PINATA_JWT}` },
    maxBodyLength: Infinity,
    timeout: 30000,
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

function loadKeypair(envKey: string): Keypair | null {
  const pk = process.env[envKey];
  if (!pk) { console.warn(`⚠️  ${envKey} not set — skipping`); return null; }
  try { return Keypair.fromSecretKey(bs58.decode(pk)); }
  catch (e) { console.error(`❌ Invalid ${envKey}`); return null; }
}

async function pumpBuy(
  conn: Connection, wallet: Keypair, mintAddr: string, amountSol: number, label: string
): Promise<void> {
  try {
    console.log(`\n💰 ${label} — ${amountSol} SOL...`);
    const r = await axios.post(
      PUMPPORTAL_TRADE,
      { publicKey: wallet.publicKey.toBase58(), action: 'buy', mint: mintAddr,
        amount: amountSol, denominatedInSol: 'true', slippage: 30, priorityFee: 0.003, pool: 'pump' },
      { responseType: 'arraybuffer', timeout: 25000 }
    );
    const bytes = new Uint8Array(r.data as ArrayBuffer);
    let sig: string;
    try {
      const tx = VersionedTransaction.deserialize(bytes);
      tx.sign([wallet]);
      sig = await conn.sendTransaction(tx, { skipPreflight: false, maxRetries: 3 });
    } catch {
      const tx = Transaction.from(Buffer.from(bytes));
      tx.partialSign(wallet);
      sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
    }
    await conn.confirmTransaction(sig, 'confirmed');
    console.log(`✅ ${label}: https://solscan.io/tx/${sig}`);
  } catch (err: any) {
    const body = err.response?.data ? Buffer.from(err.response.data as ArrayBuffer).toString() : err.message;
    console.warn(`⚠️  ${label} FAILED: ${body.slice(0, 250)}`);
  }
}

async function launch() {
  console.log('🚀 $GADAI Multi-Wallet Launch — GAD AI Terminal');
  console.log('='.repeat(55));

  if (!PINATA_JWT) throw new Error('PINATA_JWT not set — add to .env');

  const w1 = loadKeypair('WALLET_PRIVATE_KEY');
  const w2 = loadKeypair('PUMPFUN_WALLET_PRIVATE_KEY');
  const w3 = loadKeypair('PUMPFUN_WALLET_PRIVATE_KEY_2');
  if (!w1) throw new Error('WALLET_PRIVATE_KEY required');

  if (!fs.existsSync(LOGO_PATH)) {
    throw new Error(`Logo not found at ${LOGO_PATH}\nSet: GADAI_LOGO_PATH=<path>`);
  }
  console.log(`📁 Logo: ${LOGO_PATH} (${Math.round(fs.statSync(LOGO_PATH).size / 1024)}KB)`);

  const conn = new Connection(SOLANA_RPC, 'confirmed');
  const bals = await Promise.all([
    conn.getBalance(w1.publicKey),
    w2 ? conn.getBalance(w2.publicKey) : 0,
    w3 ? conn.getBalance(w3.publicKey) : 0,
  ]);
  console.log(`💰 W1: ${w1.publicKey.toBase58().slice(0,8)}… → ${(bals[0]/1e9).toFixed(4)} SOL`);
  if (w2) console.log(`💰 W2: ${w2.publicKey.toBase58().slice(0,8)}… → ${(bals[1]/1e9).toFixed(4)} SOL`);
  if (w3) console.log(`💰 W3: ${w3.publicKey.toBase58().slice(0,8)}… → ${(bals[2]/1e9).toFixed(4)} SOL`);

  if (bals[0] / 1e9 < BUY_W1 + 0.025) throw new Error(`W1 balance too low: ${(bals[0]/1e9).toFixed(4)} SOL`);

  // ── Step 1: Upload image to Pinata ─────────────────────────────────────────
  console.log('\n📌 Uploading logo to Pinata...');
  const imageCid = await pinataUploadFile(LOGO_PATH, 'gadai_logo.png');
  const imageUrl = `https://ipfs.io/ipfs/${imageCid}`;
  console.log('✅ Image CID:', imageCid);
  console.log('   URL:', imageUrl);

  const imgCheck = await axios.get(`${PINATA_GATEWAY}${imageCid}`, { responseType: 'arraybuffer', timeout: 10000 });
  console.log('✅ Image verified:', imgCheck.status, Math.round((imgCheck.data as Buffer).length / 1024) + 'KB');

  // ── Step 2: Upload metadata JSON to Pinata ─────────────────────────────────
  const metadata = {
    name: TOKEN_NAME, symbol: TOKEN_SYMBOL, description: TOKEN_DESC,
    image: imageUrl, website: TOKEN_WEBSITE, twitter: TOKEN_TWITTER,
    telegram: TOKEN_TELEGRAM, showName: true, createdOn: 'https://pump.fun',
  };
  console.log('\n📌 Uploading metadata to Pinata...');
  const metaCid = await pinataUploadJson(metadata, 'GADAI_metadata');
  const metaUri = `${PINATA_GATEWAY}${metaCid}`;
  console.log('✅ Metadata URI:', metaUri);

  const metaCheck = await axios.get(metaUri, { timeout: 10000 });
  console.log('✅ Metadata OK:', metaCheck.data.name, '| image:', metaCheck.data.image?.slice(0, 60));

  // ── Step 3: Generate mint keypair ──────────────────────────────────────────
  const mintKp = Keypair.generate();
  const mintSecretB58 = bs58.encode(mintKp.secretKey);
  const mintAddr = mintKp.publicKey.toBase58();
  console.log(`\n🪙  Mint: ${mintAddr}`);

  // ── Step 4: Create token via PumpPortal trade-local ────────────────────────
  console.log(`\n[1/3] Creating $GADAI + dev buy ${BUY_W1} SOL from W1...`);
  let createSig: string;
  try {
    const r = await axios.post(
      PUMPPORTAL_TRADE,
      { publicKey: w1.publicKey.toBase58(), action: 'create',
        tokenMetadata: { name: TOKEN_NAME, symbol: TOKEN_SYMBOL, uri: metaUri },
        mint: mintSecretB58, denominatedInSol: 'true', amount: BUY_W1,
        slippage: 15, priorityFee: 0.005, pool: 'pump' },
      { responseType: 'arraybuffer', timeout: 30000 }
    );
    const bytes = new Uint8Array(r.data as ArrayBuffer);
    try {
      const tx = VersionedTransaction.deserialize(bytes);
      tx.sign([w1, mintKp]);
      createSig = await conn.sendTransaction(tx, { skipPreflight: false, maxRetries: 5 });
    } catch {
      const tx = Transaction.from(Buffer.from(bytes));
      tx.partialSign(w1, mintKp);
      createSig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
    }
    await conn.confirmTransaction(createSig, 'confirmed');
    console.log(`✅ Created! TX: https://solscan.io/tx/${createSig}`);
    console.log(`   pump.fun: https://pump.fun/coin/${mintAddr}`);
  } catch (err: any) {
    const body = err.response?.data ? Buffer.from(err.response.data as ArrayBuffer).toString() : err.message;
    console.error(`❌ Create failed (${err.response?.status ?? '?'}): ${body.slice(0, 300)}`);
    process.exit(1);
  }

  // ── Step 5: Staggered buys ─────────────────────────────────────────────────
  if (w2) {
    console.log(`\n⏳ W2 buy in ${W2_DELAY_MS / 60000} min...`);
    await sleep(W2_DELAY_MS);
    await pumpBuy(conn, w2, mintAddr, BUY_W2, 'W2 organic buy');
  }

  if (w3) {
    console.log(`\n⏳ W3 buy in ${W3_DELAY_MS / 60000} min...`);
    await sleep(W3_DELAY_MS);
    await pumpBuy(conn, w3, mintAddr, BUY_W3, 'W3 organic buy');
  }

  // ── Result ─────────────────────────────────────────────────────────────────
  console.log('\n🎉 $GADAI LAUNCHED!');
  console.log('='.repeat(55));
  console.log(`🚀 pump.fun:  https://pump.fun/coin/${mintAddr}`);
  console.log(`🔗 Solscan:   https://solscan.io/account/${mintAddr}`);
  console.log(`📌 Image:     ${imageUrl}`);
  console.log(`📌 Metadata:  ${metaUri}`);

  const tgMsg = `🤖 <b>$GADAI — GAD AI Terminal is LIVE on pump.fun!</b>

AI-powered Solana memecoin scanner.
Scoring 0-100: narrative, momentum, risk, survival.
Auto-buy with smart TP/SL. Whale tracker. Trade journal.

🎯 Your edge in the memecoin casino.

💰 CA: <code>${mintAddr}</code>
📈 <a href="https://pump.fun/coin/${mintAddr}">pump.fun</a>
🤖 Bot: @gadai_sol_bot
🌐 gadai.shop

#GADAI #Solana #pumpfun #AI`;

  console.log('\n📣 TELEGRAM (copy to @gadfamilytg):');
  console.log(tgMsg);
}

launch().catch(e => { console.error('❌ FAILED:', e.message, e.stack?.slice(0, 300)); process.exit(1); });
