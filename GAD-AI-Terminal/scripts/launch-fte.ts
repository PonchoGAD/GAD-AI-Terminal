/**
 * $FTE Token Launch Script
 *
 * Launches "First Trillionaire Ever" ($FTE) on pump.fun via PumpPortal API.
 * Uses PUMPFUN_WALLET_PRIVATE_KEY for signing.
 *
 * Step 1: Upload image + metadata to PumpPortal IPFS → get metadataUri
 * Step 2: Create + sign token creation transaction → submit to Solana
 *
 * Required env vars:
 *   PUMPFUN_WALLET_PRIVATE_KEY — pump.fun wallet private key (base58)
 *   SOLANA_RPC                 — Helius or QuickNode RPC
 *   FTE_LOGO_PATH              — (optional) path to logo PNG, default: /tmp/fte_logo.png
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
const SOLANA_RPC       = process.env.SOLANA_RPC ?? 'https://api.mainnet-beta.solana.com';
const PUMPFUN_WALLET_PK = process.env.PUMPFUN_WALLET_PRIVATE_KEY ?? '';

const TOKEN_NAME   = 'First Trillionaire Ever';
const TOKEN_SYMBOL = 'FTE';
const TOKEN_DESC   = `Not everyone will become a trillionaire. But everyone will know who got there first.

The race to become the First Trillionaire has already begun.
Some are building companies. Some are building rockets. Some are building AI.
We are building the meme.

$FTE — the meme behind that race. The game has started.

Ambition. Wealth. Legacy.`;

const TOKEN_WEBSITE  = 'https://gadai.shop';
const TOKEN_TWITTER  = '';
const TOKEN_TELEGRAM = '';

const INITIAL_BUY_SOL = 0.1;

async function launch() {
  console.log('🚀 $FTE Token Launch — First Trillionaire Ever');
  console.log('='.repeat(50));

  if (!PUMPFUN_WALLET_PK) { console.error('❌ PUMPFUN_WALLET_PRIVATE_KEY not set'); process.exit(1); }

  let keypair: Keypair;
  try { keypair = Keypair.fromSecretKey(bs58.decode(PUMPFUN_WALLET_PK)); }
  catch { console.error('❌ Invalid PUMPFUN_WALLET_PRIVATE_KEY format'); process.exit(1); }

  console.log(`✅ Wallet: ${keypair.publicKey.toBase58()}`);
  const connection = new Connection(SOLANA_RPC, 'confirmed');
  const balance = (await connection.getBalance(keypair.publicKey)) / 1e9;
  console.log(`💰 Balance: ${balance.toFixed(4)} SOL`);

  if (balance < INITIAL_BUY_SOL + 0.02) {
    console.error(`❌ Need ${INITIAL_BUY_SOL + 0.02} SOL, have ${balance.toFixed(4)} SOL`);
    process.exit(1);
  }

  // ── Step 1: Upload to PumpPortal IPFS ──────────────────────────────────────
  const logoPath = process.env.FTE_LOGO_PATH
    ?? process.argv.find(a => a.endsWith('.png'))
    ?? '/tmp/fte_logo.png';

  if (!fs.existsSync(logoPath)) {
    console.error(`❌ Logo not found at ${logoPath}`);
    console.log('   Copy logo: docker cp fte_logo.png gad-ai-autobuy:/tmp/fte_logo.png');
    process.exit(1);
  }

  console.log(`\n📤 Uploading to PumpPortal IPFS (${path.basename(logoPath)})...`);
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

  // ── Step 2: Create token transaction ───────────────────────────────────────
  const mintKeypair = Keypair.generate();
  const mintSecretB58 = bs58.encode(mintKeypair.secretKey);
  console.log(`\n🪙  Creating $${TOKEN_SYMBOL} — mint: ${mintKeypair.publicKey.toBase58()}`);

  let createRespData: ArrayBuffer;
  try {
    const r = await axios.post(
      PUMPPORTAL_TRADE,
      {
        publicKey: keypair.publicKey.toBase58(),
        action: 'create',
        tokenMetadata: { name: TOKEN_NAME, symbol: TOKEN_SYMBOL, uri: metadataUri },
        mint: mintSecretB58,
        denominatedInSol: 'true',
        amount: INITIAL_BUY_SOL,
        slippage: 10,
        priorityFee: 0.005,
        pool: 'pump',
      },
      { responseType: 'arraybuffer', timeout: 30_000 }
    );
    createRespData = r.data;
  } catch (err: any) {
    const body = err.response?.data ? Buffer.from(err.response.data).toString() : err.message;
    console.error(`❌ PumpPortal error ${err.response?.status}: ${body}`);
    process.exit(1);
  }

  const txBytes = new Uint8Array(createRespData);
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

  const mintAddr = mintKeypair.publicKey.toBase58();
  console.log('\n🎉 TOKEN LAUNCHED!');
  console.log('='.repeat(50));
  console.log(`🔗 TX:       https://solscan.io/tx/${txSignature}`);
  console.log(`🚀 pump.fun: https://pump.fun/coin/${mintAddr}`);
  console.log(`💎 $${TOKEN_SYMBOL} — ${TOKEN_NAME}`);
  console.log(`\n📢 Tweet:`);
  console.log(`Not everyone will be a trillionaire.`);
  console.log(`But everyone will know who got there first.`);
  console.log(`$FTE — First Trillionaire Ever 🚀`);
  console.log(`https://pump.fun/coin/${mintAddr}`);
}

launch().catch(err => {
  console.error('❌ Launch failed:', err.message);
  process.exit(1);
});
