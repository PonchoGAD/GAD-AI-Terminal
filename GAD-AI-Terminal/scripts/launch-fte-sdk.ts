/**
 * $FTE Launch via pumpdotfun-sdk
 * Direct interaction with pump.fun Solana program (no PumpPortal dependency)
 */
import dotenv from 'dotenv';
import bs58 from 'bs58';
import { Keypair, Connection } from '@solana/web3.js';
import { PumpFunSDK } from 'pumpdotfun-sdk';
import { AnchorProvider, Wallet } from '@coral-xyz/anchor';
import NodeWallet from '@coral-xyz/anchor/dist/cjs/nodewallet';
dotenv.config();

const SOLANA_RPC      = process.env.SOLANA_RPC ?? 'https://api.mainnet-beta.solana.com';
const MAIN_WALLET_PK  = process.env.WALLET_PRIVATE_KEY!;
const PUMP_WALLET_PK  = process.env.PUMPFUN_WALLET_PRIVATE_KEY!;

const TOKEN_NAME   = 'First Trillionaire Ever';
const TOKEN_SYMBOL = 'FTE';
const METADATA_URI = 'https://ipfs.io/ipfs/QmSyH5W5pbCbRdiF9FWC54LCYtrsUHWcJnTuhjRnWxKva8';
const DEV_BUY_SOL  = BigInt(50_000_000); // 0.05 SOL in lamports
const PUMP_BUY_SOL = BigInt(50_000_000); // 0.05 SOL in lamports

async function launch() {
  const mainKeypair = Keypair.fromSecretKey(bs58.decode(MAIN_WALLET_PK));
  const pumpKeypair = Keypair.fromSecretKey(bs58.decode(PUMP_WALLET_PK));
  const conn = new Connection(SOLANA_RPC, 'confirmed');

  const [mainBal, pumpBal] = await Promise.all([
    conn.getBalance(mainKeypair.publicKey),
    conn.getBalance(pumpKeypair.publicKey),
  ]);
  console.log('Main wallet:', mainKeypair.publicKey.toBase58(), '—', (mainBal / 1e9).toFixed(4), 'SOL');
  console.log('Pump wallet:', pumpKeypair.publicKey.toBase58(), '—', (pumpBal / 1e9).toFixed(4), 'SOL');

  const provider = new AnchorProvider(
    conn,
    new NodeWallet(mainKeypair),
    { commitment: 'confirmed' }
  );
  const sdk = new PumpFunSDK(provider);

  const mintKp = Keypair.generate();
  console.log('Mint address:', mintKp.publicKey.toBase58());

  console.log('\nCreating $FTE on pump.fun...');
  const tokenMeta = {
    name: TOKEN_NAME,
    symbol: TOKEN_SYMBOL,
    uri: METADATA_URI,
    twitter: '',
    telegram: '',
    website: 'https://gadai.shop',
    file: new Blob([]),
    description: "Not everyone will become a trillionaire. But everyone will know who got there first.",
  };

  // Create with 0 SOL buy (SDK outdated for buy, we'll use PumpPortal for buying)
  const createResult = await sdk.createAndBuy(
    mainKeypair,
    mintKp,
    tokenMeta as any,
    BigInt(0), // 0 SOL — create only, buy separately via PumpPortal
    500n,
    { unitLimit: 250000, unitPrice: 250000 }
  );

  console.log('Create result:', createResult?.success ? 'SUCCESS' : JSON.stringify(createResult).slice(0, 200));

  if (!createResult.success) {
    console.error('Creation failed');
    process.exit(1);
  }

  const mintAddr = mintKp.publicKey.toBase58();
  console.log('\n=== CREATED! ===');
  console.log('pump.fun:', 'https://pump.fun/coin/' + mintAddr);

  // Wait for finalization then buy via PumpPortal (which works for buys)
  console.log('\nWaiting 5s for token to finalize...');
  await new Promise(r => setTimeout(r, 5000));

  const { default: axiosLib } = await import('axios');
  for (const [label, wallet, amount] of [
    ['Main wallet dev buy', mainKeypair, DEV_BUY_SOL],
    ['Pump wallet buy', pumpKeypair, PUMP_BUY_SOL],
  ] as const) {
    try {
      console.log(label, '—', Number(amount) / 1e9, 'SOL...');
      const buyR = await axiosLib.post(
        'https://pumpportal.fun/api/trade-local',
        {
          publicKey:        (wallet as Keypair).publicKey.toBase58(),
          action:           'buy',
          mint:             mintAddr,
          amount:           Number(amount) / 1e9,
          denominatedInSol: 'true',
          slippage:         25,
          priorityFee:      0.003,
          pool:             'pump',
        },
        { responseType: 'arraybuffer', timeout: 20000 }
      );
      const bytes = new Uint8Array(buyR.data as ArrayBuffer);
      let sig: string;
      try {
        const { VersionedTransaction } = await import('@solana/web3.js');
        const tx = VersionedTransaction.deserialize(bytes);
        tx.sign([wallet as Keypair]);
        sig = await conn.sendTransaction(tx, { skipPreflight: false, maxRetries: 3 });
      } catch {
        const { Transaction } = await import('@solana/web3.js');
        const tx = Transaction.from(Buffer.from(bytes));
        tx.partialSign(wallet as Keypair);
        sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
      }
      await conn.confirmTransaction(sig, 'confirmed');
      console.log(label, '✅ TX:', 'https://solscan.io/tx/' + sig.slice(0, 20));
      await new Promise(r => setTimeout(r, 2000));
    } catch (err: any) {
      const body = err.response?.data ? Buffer.from(err.response.data as ArrayBuffer).toString() : err.message;
      console.warn(label, 'FAILED:', body.slice(0, 150));
    }
  }
}

launch().catch(e => { console.error('FAILED:', e.message, e.stack?.slice(0, 500)); process.exit(1); });
