/**
 * $GADAI Multi-Wallet Launch — GAD AI Terminal
 *
 * Pinata IPFS + pumpdotfun-sdk create + PumpPortal buys from 3 wallets
 *
 * Required env vars (all on VPS):
 *   WALLET_PRIVATE_KEY           — W1 EL4mS7Xg (creator + dev buy)
 *   PUMPFUN_WALLET_PRIVATE_KEY   — W2 CFmHWpmQ (organic buy +12min)
 *   PUMPFUN_WALLET_PRIVATE_KEY_2 — W3 DJ8Tq8vi (organic buy +28min)
 *   PINATA_JWT                   — Pinata API key
 *   PINATA_GATEWAY               — optional, default: https://gateway.pinata.cloud/ipfs/
 *   SOLANA_RPC                   — Helius RPC
 *   GADAI_LOGO_PATH              — path to logo PNG (default /tmp/gadai_logo.png)
 *
 * Staggered timing (organic appearance):
 *   T+0min  W1 creates + dev buy 0.15 SOL via PumpPortal trade-local
 *   T+12min W2 organic buy 0.08 SOL
 *   T+28min W3 organic buy 0.04 SOL
 *
 * Run on VPS Docker (has pumpdotfun-sdk):
 *   docker cp scripts/gadai_logo.png gad-ai-autobuy:/tmp/gadai_logo.png
 *   docker exec -it gad-ai-autobuy npx ts-node -p tsconfig.json scripts/launch-gadai.ts
 */

import dotenv from 'dotenv';
import fs from 'fs';
import FormData from 'form-data';
import bs58 from 'bs58';
import { Keypair, Connection, VersionedTransaction, Transaction } from '@solana/web3.js';
import { PumpFunSDK } from 'pumpdotfun-sdk';
import { AnchorProvider } from '@coral-xyz/anchor';
import NodeWallet from '@coral-xyz/anchor/dist/cjs/nodewallet';
dotenv.config();

const SOLANA_RPC     = process.env.SOLANA_RPC ?? 'https://api.mainnet-beta.solana.com';
const MAIN_WALLET_PK = process.env.WALLET_PRIVATE_KEY!;
const W2_WALLET_PK   = process.env.PUMPFUN_WALLET_PRIVATE_KEY!;
const W3_WALLET_PK   = process.env.PUMPFUN_WALLET_PRIVATE_KEY_2!;
const PINATA_JWT     = process.env.PINATA_JWT!;
const PINATA_GATEWAY = process.env.PINATA_GATEWAY ?? 'https://gateway.pinata.cloud/ipfs/';
const LOGO_PATH      = process.env.GADAI_LOGO_PATH ?? '/tmp/gadai_logo.png';

const TOKEN_NAME   = 'GAD AI Terminal';
const TOKEN_SYMBOL = 'GADAI';
const TOKEN_DESC   = `GAD AI Terminal — Real-time Solana memecoin alpha.

AI-powered scanner finds tokens before they pump.
Scoring 0-100: narrative, momentum, risk, survival probability.
Auto-buy with smart TP/SL. Trade journal. Whale tracker.

Your edge in the memecoin casino.

@gadai_sol_bot on Telegram — free trial available.`;
const TOKEN_WEBSITE  = 'https://www.gadai.shop';
const TOKEN_TWITTER  = 'https://x.com/gadaisol';
const TOKEN_TELEGRAM = 'https://t.me/gadfamilytg';

const BUY_W1 = 0.15;  // dev buy
const BUY_W2 = 0.08;  // organic +12min
const BUY_W3 = 0.04;  // organic +28min

const W2_DELAY_MS = 12 * 60 * 1000;
const W3_DELAY_MS = 16 * 60 * 1000; // after W2, = T+28min total

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function pinataUploadFile(filePath: string, filename: string): Promise<string> {
  const { default: axios } = await import('axios');
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
  const { default: axios } = await import('axios');
  const res = await axios.post(
    'https://api.pinata.cloud/pinning/pinJSONToIPFS',
    { pinataContent: obj, pinataMetadata: { name }, pinataOptions: { cidVersion: 0 } },
    { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${PINATA_JWT}` }, timeout: 15000 }
  );
  return res.data.IpfsHash as string;
}

async function pumpBuy(
  conn: Connection, wallet: Keypair, mintAddr: string, amountSol: number, label: string
): Promise<void> {
  const { default: axios } = await import('axios');
  try {
    console.log(`\n💰 ${label} — ${amountSol} SOL...`);
    const r = await axios.post(
      'https://pumpportal.fun/api/trade-local',
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
    console.log(`✅ ${label} TX: https://solscan.io/tx/${sig}`);
  } catch (err: any) {
    const body = err.response?.data ? Buffer.from(err.response.data as ArrayBuffer).toString() : err.message;
    console.warn(`⚠️  ${label} FAILED: ${body.slice(0, 200)}`);
  }
}

async function launch() {
  if (!PINATA_JWT) throw new Error('PINATA_JWT not set — add to .env');
  if (!MAIN_WALLET_PK) throw new Error('WALLET_PRIVATE_KEY not set');
  if (!fs.existsSync(LOGO_PATH)) {
    throw new Error(`Logo not found at ${LOGO_PATH}\nCopy: docker cp ./scripts/gadai_logo.png gad-ai-autobuy:/tmp/gadai_logo.png`);
  }

  const w1 = Keypair.fromSecretKey(bs58.decode(MAIN_WALLET_PK));
  const w2 = W2_WALLET_PK ? Keypair.fromSecretKey(bs58.decode(W2_WALLET_PK)) : null;
  const w3 = W3_WALLET_PK ? Keypair.fromSecretKey(bs58.decode(W3_WALLET_PK)) : null;
  const conn = new Connection(SOLANA_RPC, 'confirmed');

  console.log('🚀 $GADAI Multi-Wallet Launch — GAD AI Terminal');
  console.log('='.repeat(55));

  const bals = await Promise.all([
    conn.getBalance(w1.publicKey),
    w2 ? conn.getBalance(w2.publicKey) : Promise.resolve(0),
    w3 ? conn.getBalance(w3.publicKey) : Promise.resolve(0),
  ]);
  console.log(`💰 W1 (creator): ${w1.publicKey.toBase58().slice(0,8)}… → ${(bals[0]/1e9).toFixed(4)} SOL`);
  if (w2) console.log(`💰 W2:           ${w2.publicKey.toBase58().slice(0,8)}… → ${(bals[1]/1e9).toFixed(4)} SOL`);
  if (w3) console.log(`💰 W3:           ${w3.publicKey.toBase58().slice(0,8)}… → ${(bals[2]/1e9).toFixed(4)} SOL`);

  if (bals[0] / 1e9 < BUY_W1 + 0.025) throw new Error(`W1 balance too low: ${(bals[0]/1e9).toFixed(4)} SOL`);

  // ── Step 1: Upload logo to Pinata ──────────────────────────────────────────
  console.log(`\n📌 Uploading logo to Pinata (${LOGO_PATH})...`);
  const imageCid = await pinataUploadFile(LOGO_PATH, 'gadai_logo.png');
  const imageUrl = `https://ipfs.io/ipfs/${imageCid}`;
  console.log('✅ Image CID:', imageCid);
  console.log('   Image URL:', imageUrl);

  const { default: axios } = await import('axios');
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

  // ── Step 3: Create token via pumpdotfun-sdk ────────────────────────────────
  const provider = new AnchorProvider(conn, new NodeWallet(w1), { commitment: 'confirmed' });
  const sdk = new PumpFunSDK(provider);
  const mintKp = Keypair.generate();

  console.log(`\n🚀 Creating $GADAI on pump.fun...`);
  console.log('   Mint:', mintKp.publicKey.toBase58());

  const imageBytes = fs.readFileSync(LOGO_PATH);
  const imageBlob = new Blob([imageBytes], { type: 'image/png' });

  const createResult = await sdk.createAndBuy(
    w1, mintKp,
    { name: TOKEN_NAME, symbol: TOKEN_SYMBOL, uri: metaUri,
      twitter: TOKEN_TWITTER, telegram: TOKEN_TELEGRAM, website: TOKEN_WEBSITE,
      file: imageBlob, description: TOKEN_DESC } as any,
    BigInt(0), 500n,
    { unitLimit: 250000, unitPrice: 250000 }
  );

  if (!createResult?.success) {
    console.error('❌ Create failed:', JSON.stringify(createResult).slice(0, 200));
    process.exit(1);
  }

  const mintAddr = mintKp.publicKey.toBase58();
  console.log('✅ CREATED!');
  console.log('   pump.fun: https://pump.fun/coin/' + mintAddr);
  console.log('   Waiting 6s before dev buy...');
  await sleep(6000);

  // ── Step 4: Dev buy from W1 ────────────────────────────────────────────────
  console.log(`\n[1/3] W1 dev buy: ${BUY_W1} SOL...`);
  await pumpBuy(conn, w1, mintAddr, BUY_W1, 'W1 dev buy');

  // ── Step 5: Staggered buys from W2 and W3 ─────────────────────────────────
  if (w2) {
    const t2 = new Date(Date.now() + W2_DELAY_MS);
    console.log(`\n⏳ W2 buy in ${W2_DELAY_MS / 60000} min (at ${t2.toLocaleTimeString()})...`);
    await sleep(W2_DELAY_MS);
    await pumpBuy(conn, w2, mintAddr, BUY_W2, 'W2 organic buy');
  }

  if (w3) {
    const t3 = new Date(Date.now() + W3_DELAY_MS);
    console.log(`\n⏳ W3 buy in ${W3_DELAY_MS / 60000} min (at ${t3.toLocaleTimeString()})...`);
    await sleep(W3_DELAY_MS);
    await pumpBuy(conn, w3, mintAddr, BUY_W3, 'W3 organic buy');
  }

  // ── Result ─────────────────────────────────────────────────────────────────
  const [f1, f2, f3] = await Promise.all([
    conn.getBalance(w1.publicKey),
    w2 ? conn.getBalance(w2.publicKey) : Promise.resolve(0),
    w3 ? conn.getBalance(w3.publicKey) : Promise.resolve(0),
  ]);

  console.log('\n🎉 $GADAI LAUNCHED!');
  console.log('='.repeat(55));
  console.log(`🚀 pump.fun:  https://pump.fun/coin/${mintAddr}`);
  console.log(`🔗 Solscan:   https://solscan.io/account/${mintAddr}`);
  console.log(`🌐 Website:   ${TOKEN_WEBSITE}`);
  console.log(`🐦 Twitter:   ${TOKEN_TWITTER}`);
  console.log(`📣 Telegram:  ${TOKEN_TELEGRAM}`);
  console.log(`\n💰 Balances after:`);
  console.log(`   W1: ${(f1/1e9).toFixed(4)} SOL | W2: ${(f2/1e9).toFixed(4)} SOL | W3: ${(f3/1e9).toFixed(4)} SOL`);

  const tgMsg = `🤖 <b>$GADAI — GAD AI Terminal is LIVE!</b>

AI-powered Solana memecoin scanner.
Scoring 0-100: narrative, momentum, risk, survival.
Auto-buy with smart TP/SL. Whale tracker. Trade journal.

🎯 Your edge in the memecoin casino.

💰 Mint: <code>${mintAddr}</code>
📈 <a href="https://pump.fun/coin/${mintAddr}">pump.fun</a>
🤖 Bot: @gadai_sol_bot
🌐 Site: gadai.shop

#GADAI #Solana #pumpfun #AI`;

  console.log('\n📣 TELEGRAM (copy to @gadfamilytg):');
  console.log(tgMsg);
}

launch().catch(e => { console.error('FAILED:', e.message, e.stack?.slice(0, 300)); process.exit(1); });
