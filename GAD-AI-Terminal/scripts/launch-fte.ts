/**
 * $FTE Token Launch Script
 *
 * Launches "First Trillionaire Ever" ($FTE) on pump.fun via PumpPortal API.
 * Uses PUMPFUN_WALLET_PRIVATE_KEY for signing.
 *
 * Usage:
 *   node -r ts-node/register scripts/launch-fte.ts [--image ./fte_logo.png]
 *
 * Required env vars:
 *   PUMPFUN_WALLET_PRIVATE_KEY — pump.fun wallet private key (base58)
 *   SOLANA_RPC                 — Helius or QuickNode RPC
 *
 * Best launch time: 18:00-22:00 UTC (US market peak hours)
 */

import dotenv from 'dotenv';
import axios from 'axios';
import FormData from 'form-data';
import fs from 'fs';
import path from 'path';
import bs58 from 'bs58';
import { Keypair, Connection, VersionedTransaction, Transaction } from '@solana/web3.js';

dotenv.config();

const PUMPPORTAL_IPFS   = 'https://pump.fun/api/ipfs';
const PUMPPORTAL_TRADE  = 'https://pumpportal.fun/api/trade-local';
const SOLANA_RPC        = process.env.SOLANA_RPC ?? 'https://api.mainnet-beta.solana.com';
const PUMPFUN_WALLET_PK = process.env.PUMPFUN_WALLET_PRIVATE_KEY ?? '';

// ─── Token metadata ────────────────────────────────────────────────────────────

const TOKEN_NAME        = 'First Trillionaire Ever';
const TOKEN_SYMBOL      = 'FTE';
const TOKEN_DESCRIPTION = `Not everyone will become a trillionaire. But everyone will know who got there first.

The race to become the First Trillionaire has already begun.
Some are building companies. Some are building rockets. Some are building AI.
We are building the meme.

$FTE — the meme behind that race. The game has started.

Ambition. Wealth. Legacy.`;

const TOKEN_TWITTER  = 'https://x.com/search?q=%24FTE';  // Update with real Twitter
const TOKEN_TELEGRAM = '';  // Add Telegram when ready
const TOKEN_WEBSITE  = 'https://gadai.shop';

// ─── Initial buy amount ────────────────────────────────────────────────────────
// Small initial buy from dev wallet to signal confidence
// This is the dev's REAL initial buy — not manipulation, just normal token launch
const INITIAL_BUY_SOL = 0.1;  // 0.1 SOL initial buy

// ─── Main ─────────────────────────────────────────────────────────────────────

async function launch() {
  console.log('🚀 $FTE Token Launch — First Trillionaire Ever');
  console.log('='.repeat(50));

  // Load wallet
  if (!PUMPFUN_WALLET_PK) {
    console.error('❌ PUMPFUN_WALLET_PRIVATE_KEY not set in .env');
    process.exit(1);
  }

  let keypair: Keypair;
  try {
    keypair = Keypair.fromSecretKey(bs58.decode(PUMPFUN_WALLET_PK));
  } catch {
    console.error('❌ Invalid PUMPFUN_WALLET_PRIVATE_KEY format');
    process.exit(1);
  }

  console.log(`✅ Wallet: ${keypair.publicKey.toBase58()}`);

  const connection = new Connection(SOLANA_RPC, 'confirmed');

  // Check wallet balance
  const balance = await connection.getBalance(keypair.publicKey);
  const balanceSol = balance / 1e9;
  console.log(`💰 Balance: ${balanceSol.toFixed(4)} SOL`);

  if (balanceSol < INITIAL_BUY_SOL + 0.02) {
    console.error(`❌ Insufficient balance. Need ${INITIAL_BUY_SOL + 0.02} SOL, have ${balanceSol.toFixed(4)} SOL`);
    console.log(`   Top up wallet: ${keypair.publicKey.toBase58()}`);
    process.exit(1);
  }

  // Find image file
  const imagePath = process.argv.includes('--image')
    ? process.argv[process.argv.indexOf('--image') + 1]
    : path.join(process.cwd(), 'fte_logo.png');

  if (!fs.existsSync(imagePath)) {
    console.error(`❌ Image file not found: ${imagePath}`);
    console.log('   Save your logo as fte_logo.png in the project root, then run again.');
    console.log('   Or specify: node scripts/launch-fte.ts --image /path/to/logo.png');
    process.exit(1);
  }

  console.log(`🖼  Image: ${imagePath} (${(fs.statSync(imagePath).size / 1024).toFixed(1)} KB)`);

  // ── Step 1: Upload metadata to IPFS via PumpPortal ──
  console.log('\n📤 Uploading metadata to IPFS...');

  const form = new FormData();
  form.append('file', fs.createReadStream(imagePath));
  form.append('name', TOKEN_NAME);
  form.append('symbol', TOKEN_SYMBOL);
  form.append('description', TOKEN_DESCRIPTION);
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

  // ── Step 2: Create token transaction ──
  console.log(`\n🪙  Creating $${TOKEN_SYMBOL} token with ${INITIAL_BUY_SOL} SOL initial buy...`);

  const createResp = await axios.post(
    PUMPPORTAL_TRADE,
    {
      publicKey: keypair.publicKey.toBase58(),
      action: 'create',
      tokenMetadata: {
        name: TOKEN_NAME,
        symbol: TOKEN_SYMBOL,
        uri: metadataUri,
      },
      mint: Keypair.generate().publicKey.toBase58(),  // will be overridden by PumpPortal
      denominatedInSol: 'true',
      amount: INITIAL_BUY_SOL,
      slippage: 10,
      priorityFee: 0.005,  // higher priority for launch
      pool: 'pump',
    },
    { responseType: 'arraybuffer', timeout: 30_000 }
  );

  const txBytes = new Uint8Array(createResp.data);
  let txSignature: string;

  try {
    const tx = VersionedTransaction.deserialize(txBytes);
    tx.sign([keypair]);
    txSignature = await connection.sendTransaction(tx, { skipPreflight: false, maxRetries: 5 });
  } catch {
    const tx = Transaction.from(Buffer.from(txBytes));
    tx.partialSign(keypair);
    txSignature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  }

  await connection.confirmTransaction(txSignature, 'confirmed');

  console.log('\n🎉 TOKEN LAUNCHED SUCCESSFULLY!');
  console.log('='.repeat(50));
  console.log(`🔗 Transaction: https://solscan.io/tx/${txSignature}`);
  console.log(`🚀 pump.fun: https://pump.fun/coin/${keypair.publicKey.toBase58()}`);
  console.log(`💎 Token: $${TOKEN_SYMBOL} — ${TOKEN_NAME}`);
  console.log(`💰 Initial buy: ${INITIAL_BUY_SOL} SOL`);
  console.log('\n📢 Share this on Twitter/X:');
  console.log(`   Not everyone will be a trillionaire.`);
  console.log(`   But everyone will know who got there first.`);
  console.log(`   $FTE — First Trillionaire Ever 🚀`);
  console.log(`   https://pump.fun/coin/${keypair.publicKey.toBase58()}`);
}

launch().catch(err => {
  console.error('❌ Launch failed:', err.message);
  process.exit(1);
});
