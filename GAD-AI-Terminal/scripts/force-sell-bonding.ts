import dotenv from 'dotenv';
import axios from 'axios';
import bs58 from 'bs58';
import { Keypair, Connection, VersionedTransaction, Transaction } from '@solana/web3.js';
import { Pool } from 'pg';
dotenv.config();

const PUMPPORTAL_BUY = 'https://pumpportal.fun/api/trade-local';
const SOLANA_RPC = process.env.SOLANA_RPC!;
const pk = process.env.PUMPFUN_WALLET_PRIVATE_KEY!;
const keypair = Keypair.fromSecretKey(bs58.decode(pk));
const conn = new Connection(SOLANA_RPC, 'confirmed');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const MINTS = [
  '6PEk2MGYwqSCak5txAEziAuh1oSWKEkoq8LPjkPFpump',
  '3khL3sGh2CvNa1sTh8f6hrYinuQLUaH9GJhpEa4Qpump',
  'FUXTWWgCwxGE6fYXuDF3ayMSc85DrRmCZYLfGTfZpump',
  '3xo7XkzzxWWTSon2mqnMaoPjL8VXUBGEGkpyz2qYpump',
  '7CrtwUQukA4tQfKxs2rtL9kHbpKSjpnM2QTmtKEvpump',
  'HGiV9bZx1KRQVNJ61VyH6RsjPXFjpSjSwLsdx3sZpump',
  'EUCcpf2pibXM8KL56xFxES6mmeS4pdcrJuyJyTBpump',
];

async function sellMint(mint: string): Promise<void> {
  const balBefore = await conn.getBalance(keypair.publicKey).catch(() => 0);
  try {
    const resp = await axios.post(
      PUMPPORTAL_BUY,
      {
        publicKey: keypair.publicKey.toBase58(),
        action: 'sell',
        mint,
        amount: '100%',
        denominatedInSol: 'false',
        slippage: 50,
        priorityFee: 0.003,
        pool: 'auto',
      },
      { responseType: 'arraybuffer', timeout: 20000 }
    );

    const bytes = new Uint8Array(resp.data as ArrayBuffer);
    let sig: string;
    try {
      const tx = VersionedTransaction.deserialize(bytes);
      tx.sign([keypair]);
      sig = await conn.sendTransaction(tx, { skipPreflight: true, maxRetries: 3 });
    } catch {
      const tx = Transaction.from(Buffer.from(bytes));
      tx.partialSign(keypair);
      sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
    }
    await conn.confirmTransaction(sig, 'confirmed');
    const balAfter = await conn.getBalance(keypair.publicKey).catch(() => 0);
    const recovered = Math.max(0, (balAfter - balBefore) / 1e9);
    console.log('SOLD', mint.slice(0, 8), '-> recovered', recovered.toFixed(5), 'SOL');
    await pool.query(
      'UPDATE autobuy_jobs SET active=false, total_sold_sol=$1 WHERE mint_address=$2 AND active=true',
      [recovered, mint]
    );
  } catch (err: any) {
    const body = err.response?.data
      ? Buffer.from(err.response.data as ArrayBuffer).toString().slice(0, 200)
      : (err.message as string);
    console.log('FAIL', mint.slice(0, 8), ':', body.slice(0, 100));
    await pool.query(
      'UPDATE autobuy_jobs SET active=false WHERE mint_address=$1 AND active=true',
      [mint]
    );
  }
}

async function main() {
  const bal = (await conn.getBalance(keypair.publicKey)) / 1e9;
  console.log('Wallet:', keypair.publicKey.toBase58(), 'Balance:', bal.toFixed(4), 'SOL');
  for (const mint of MINTS) {
    console.log('Selling', mint.slice(0, 8), '...');
    await sellMint(mint);
    await new Promise(r => setTimeout(r, 2000));
  }
  const balFinal = (await conn.getBalance(keypair.publicKey)) / 1e9;
  console.log('Final balance:', balFinal.toFixed(4), 'SOL');
  await pool.end();
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });
