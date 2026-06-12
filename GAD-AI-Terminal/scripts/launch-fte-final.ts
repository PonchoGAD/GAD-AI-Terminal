/**
 * $FTE Final Launch
 * - Creates token from main wallet (WALLET_PRIVATE_KEY) with pump.fun IPFS metadata
 * - Then pump.fun wallet (PUMPFUN_WALLET_PRIVATE_KEY) buys 0.05 SOL immediately after
 */
import dotenv from 'dotenv';
import axios from 'axios';
import bs58 from 'bs58';
import { Keypair, Connection, VersionedTransaction, Transaction } from '@solana/web3.js';
dotenv.config();

const PUMPPORTAL_TRADE = 'https://pumpportal.fun/api/trade-local';
const SOLANA_RPC       = process.env.SOLANA_RPC ?? 'https://api.mainnet-beta.solana.com';

const MAIN_WALLET_PK  = process.env.WALLET_PRIVATE_KEY!;
const PUMP_WALLET_PK  = process.env.PUMPFUN_WALLET_PRIVATE_KEY!;

const TOKEN_NAME   = 'First Trillionaire Ever';
const TOKEN_SYMBOL = 'FTE';
const METADATA_URI = 'https://ipfs.io/ipfs/QmSyH5W5pbCbRdiF9FWC54LCYtrsUHWcJnTuhjRnWxKva8';
const DEV_BUY_SOL  = 0.05;
const PUMP_BUY_SOL = 0.05;

async function sendTx(conn: Connection, keypair: Keypair, mintKp: Keypair | null, bytes: Uint8Array): Promise<string> {
  try {
    const tx = VersionedTransaction.deserialize(bytes);
    const signers = mintKp ? [keypair, mintKp] : [keypair];
    tx.sign(signers);
    return await conn.sendTransaction(tx, { skipPreflight: false, maxRetries: 5 });
  } catch {
    const tx = Transaction.from(Buffer.from(bytes));
    if (mintKp) tx.partialSign(keypair, mintKp);
    else tx.partialSign(keypair);
    return await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  }
}

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
  console.log('Metadata:', METADATA_URI);

  if (mainBal / 1e9 < DEV_BUY_SOL + 0.01) throw new Error('Main wallet insufficient balance');

  // Generate mint keypair
  const mintKp = Keypair.generate();
  console.log('Mint address:', mintKp.publicKey.toBase58());

  // Step 1: Create token from main wallet
  console.log('\nCreating token...');
  let createData: ArrayBuffer;
  try {
    const r = await axios.post(
      PUMPPORTAL_TRADE,
      {
        publicKey:     mainKeypair.publicKey.toBase58(),
        action:        'create',
        tokenMetadata: { name: TOKEN_NAME, symbol: TOKEN_SYMBOL, uri: METADATA_URI },
        mint:          bs58.encode(mintKp.secretKey),
        denominatedInSol: 'true',
        amount:        DEV_BUY_SOL,
        slippage:      10,
        priorityFee:   0.005,
        pool:          'pump',
      },
      { responseType: 'arraybuffer', timeout: 30000 }
    );
    createData = r.data;
    console.log('PumpPortal OK:', (createData as any).byteLength, 'bytes');
  } catch (err: any) {
    const body = err.response?.data
      ? Buffer.from(err.response.data as ArrayBuffer).toString()
      : err.message;
    console.error('CREATE ERROR', err.response?.status, ':', body.slice(0, 300));
    process.exit(1);
  }

  const sig = await sendTx(conn, mainKeypair, mintKp, new Uint8Array(createData));
  console.log('Confirming...');
  await conn.confirmTransaction(sig, 'confirmed');

  const mintAddr = mintKp.publicKey.toBase58();
  console.log('\n=== CREATED! ===');
  console.log('TX:', 'https://solscan.io/tx/' + sig);
  console.log('Mint:', mintAddr);
  console.log('pump.fun:', 'https://pump.fun/coin/' + mintAddr);

  // Step 2: Pump wallet buys immediately
  if (pumpBal / 1e9 >= PUMP_BUY_SOL + 0.005) {
    console.log('\nPump wallet buying', PUMP_BUY_SOL, 'SOL...');
    await new Promise(r => setTimeout(r, 3000)); // 3s gap
    try {
      const buyR = await axios.post(
        PUMPPORTAL_TRADE,
        {
          publicKey:        pumpKeypair.publicKey.toBase58(),
          action:           'buy',
          mint:             mintAddr,
          amount:           PUMP_BUY_SOL,
          denominatedInSol: 'true',
          slippage:         25,
          priorityFee:      0.002,
          pool:             'pump',
        },
        { responseType: 'arraybuffer', timeout: 20000 }
      );
      const buySig = await sendTx(conn, pumpKeypair, null, new Uint8Array(buyR.data as ArrayBuffer));
      await conn.confirmTransaction(buySig, 'confirmed');
      console.log('Pump wallet bought! TX:', 'https://solscan.io/tx/' + buySig);
    } catch (err: any) {
      const body = err.response?.data
        ? Buffer.from(err.response.data as ArrayBuffer).toString()
        : err.message;
      console.warn('Pump buy failed:', body.slice(0, 200));
    }
  } else {
    console.warn('Pump wallet insufficient balance, skipping buy');
  }

  console.log('\n============================');
  console.log('$FTE — First Trillionaire Ever');
  console.log('pump.fun: https://pump.fun/coin/' + mintAddr);
  console.log('============================');
}

launch().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
