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
import bs58 from 'bs58';
import { Keypair, Connection, VersionedTransaction, Transaction } from '@solana/web3.js';

dotenv.config();

const PUMPPORTAL_TRADE  = 'https://pumpportal.fun/api/trade-local';
const SOLANA_RPC        = process.env.SOLANA_RPC ?? 'https://api.mainnet-beta.solana.com';
const PUMPFUN_WALLET_PK = process.env.PUMPFUN_WALLET_PRIVATE_KEY ?? '';

// Self-hosted metadata — avoids pump.fun/api/ipfs (deprecated) and unreliable ipfs.io URIs
const METADATA_URI = 'https://gadai.shop/api/fte-metadata';

// ─── Token metadata ────────────────────────────────────────────────────────────

const TOKEN_NAME        = 'First Trillionaire Ever';
const TOKEN_SYMBOL      = 'FTE';
const TOKEN_DESCRIPTION = `Not everyone will become a trillionaire. But everyone will know who got there first.

The race to become the First Trillionaire has already begun.
Some are building companies. Some are building rockets. Some are building AI.
We are building the meme.

$FTE — the meme behind that race. The game has started.

Ambition. Wealth. Legacy.`;

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

  // ── Step 1: Verify self-hosted metadata is accessible ──
  console.log(`\n🔍 Verifying metadata at ${METADATA_URI}...`);
  const metaCheck = await axios.get(METADATA_URI, { timeout: 10_000 });
  if (!metaCheck.data?.name) {
    console.error('❌ Metadata endpoint unreachable or invalid:', JSON.stringify(metaCheck.data));
    process.exit(1);
  }
  console.log(`✅ Metadata verified: ${metaCheck.data.name} ($${metaCheck.data.symbol})`);
  const metadataUri = METADATA_URI;

  // ── Step 2: Create token transaction ──
  // Generate fresh mint keypair — send SECRET KEY (bs58) per PumpPortal docs
  const mintKeypair = Keypair.generate();
  const mintSecretB58 = bs58.encode(mintKeypair.secretKey);
  console.log(`\n🪙  Creating $${TOKEN_SYMBOL} token with ${INITIAL_BUY_SOL} SOL initial buy...`);
  console.log(`   Mint address: ${mintKeypair.publicKey.toBase58()}`);

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
      mint: mintSecretB58,        // ← private key in base58, NOT public key
      denominatedInSol: 'true',
      amount: INITIAL_BUY_SOL,
      slippage: 10,
      priorityFee: 0.005,
      pool: 'pump',
    },
    { responseType: 'arraybuffer', timeout: 30_000 }
  );

  const txBytes = new Uint8Array(createResp.data);
  let txSignature: string;

  try {
    const tx = VersionedTransaction.deserialize(txBytes);
    tx.sign([keypair, mintKeypair]);
    txSignature = await connection.sendTransaction(tx, { skipPreflight: false, maxRetries: 5 });
  } catch {
    const tx = Transaction.from(Buffer.from(txBytes));
    tx.partialSign(keypair, mintKeypair);
    txSignature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  }

  await connection.confirmTransaction(txSignature, 'confirmed');

  console.log('\n🎉 TOKEN LAUNCHED SUCCESSFULLY!');
  console.log('='.repeat(50));
  const mintAddr = mintKeypair.publicKey.toBase58();
  console.log(`🔗 Transaction: https://solscan.io/tx/${txSignature}`);
  console.log(`🚀 pump.fun: https://pump.fun/coin/${mintAddr}`);
  console.log(`💎 Token: $${TOKEN_SYMBOL} — ${TOKEN_NAME}`);
  console.log(`💰 Initial buy: ${INITIAL_BUY_SOL} SOL`);
  console.log('\n📢 Share this on Twitter/X:');
  console.log(`   Not everyone will be a trillionaire.`);
  console.log(`   But everyone will know who got there first.`);
  console.log(`   $FTE — First Trillionaire Ever 🚀`);
  console.log(`   https://pump.fun/coin/${mintAddr}`);
}

launch().catch(err => {
  console.error('❌ Launch failed:', err.message);
  process.exit(1);
});
