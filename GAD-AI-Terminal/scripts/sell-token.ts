/**
 * Sell a pump.fun token via PumpPortal — 100% of holdings
 * Usage: SELL_MINT=<address> npx ts-node scripts/sell-token.ts
 */
import dotenv from 'dotenv';
import bs58 from 'bs58';
import { Keypair, Connection, VersionedTransaction, Transaction } from '@solana/web3.js';
dotenv.config();

const SOLANA_RPC     = process.env.SOLANA_RPC ?? 'https://api.mainnet-beta.solana.com';
const MAIN_WALLET_PK = process.env.WALLET_PRIVATE_KEY!;
const PUMP_WALLET_PK = process.env.PUMPFUN_WALLET_PRIVATE_KEY!;

const MINT = process.env.SELL_MINT!;

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function sellWallet(wallet: Keypair, conn: Connection, mint: string, label: string) {
  const { default: axios } = await import('axios');
  console.log(`\n💸 Selling ${label} — 100%...`);
  try {
    const res = await axios.post(
      'https://pumpportal.fun/api/trade-local',
      {
        publicKey: wallet.publicKey.toBase58(),
        action: 'sell',
        mint,
        amount: '100%',
        denominatedInSol: 'false',
        slippage: 30,
        priorityFee: 0.003,
        pool: 'pump',
      },
      { responseType: 'arraybuffer', timeout: 25000 }
    );
    const bytes = new Uint8Array(res.data as ArrayBuffer);
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
    console.log(`✅ ${label} SOLD! TX: https://solscan.io/tx/${sig}`);
  } catch (err: any) {
    const body = err.response?.data ? Buffer.from(err.response.data as ArrayBuffer).toString() : err.message;
    console.warn(`⚠️  ${label} sell FAILED: ${body.slice(0, 200)}`);
  }
}

async function main() {
  if (!MINT) throw new Error('Set SELL_MINT=<mint_address>');
  const mainKeypair = Keypair.fromSecretKey(bs58.decode(MAIN_WALLET_PK));
  const pumpKeypair = Keypair.fromSecretKey(bs58.decode(PUMP_WALLET_PK));
  const conn = new Connection(SOLANA_RPC, 'confirmed');

  console.log('Selling mint:', MINT);
  console.log('Main:', mainKeypair.publicKey.toBase58());
  console.log('Pump:', pumpKeypair.publicKey.toBase58());

  await sellWallet(mainKeypair, conn, MINT, 'Main wallet');
  await sleep(3000);
  await sellWallet(pumpKeypair, conn, MINT, 'Pump wallet');

  const [m, p] = await Promise.all([
    conn.getBalance(mainKeypair.publicKey),
    conn.getBalance(pumpKeypair.publicKey),
  ]);
  console.log(`\n✅ Done. Main: ${(m/1e9).toFixed(4)} SOL | Pump: ${(p/1e9).toFixed(4)} SOL`);
}

main().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
