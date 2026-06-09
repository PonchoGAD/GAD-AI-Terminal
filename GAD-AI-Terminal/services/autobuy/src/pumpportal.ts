/**
 * PumpPortal Local Transaction API
 *
 * Fallback executor for tokens Jupiter cannot route:
 *  - pump.fun bonding curve tokens (pumpfun/pumpswap)
 *  - meteoradbc (Meteora Dynamic Bonding Curve)
 *  - fluxbeam and other smaller DEXes
 *
 * Uses our main wallet (EL4m...) — no separate funding needed.
 * pool:"auto" lets PumpPortal pick the best route automatically.
 *
 * Docs: https://pumpportal.fun/trading-api/setup
 */

import axios from 'axios';
import { Keypair, Connection, VersionedTransaction, Transaction } from '@solana/web3.js';

const PUMPPORTAL_URL = 'https://pumpportal.fun/api/trade-local';
const ENABLED = process.env.PUMP_PORTAL_ENABLED === 'true';

async function signAndSend(
  txBytes: Uint8Array,
  keypair: Keypair,
  connection: Connection
): Promise<string> {
  // Try VersionedTransaction (newer Solana format) first, fall back to legacy
  try {
    const tx = VersionedTransaction.deserialize(txBytes);
    tx.sign([keypair]);
    return await connection.sendTransaction(tx, { skipPreflight: false, maxRetries: 3 });
  } catch {
    const tx = Transaction.from(Buffer.from(txBytes));
    tx.partialSign(keypair);
    return await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  }
}

/** Sell via PumpPortal. amountPct = 100 to sell everything. */
export async function sellViaPumpPortal(
  mintAddress: string,
  amountPct: number,
  keypair: Keypair,
  connection: Connection
): Promise<{ success: boolean; solReceived?: number; txSignature?: string; error?: string }> {
  if (!ENABLED) return { success: false, error: 'PumpPortal disabled (set PUMP_PORTAL_ENABLED=true)' };

  try {
    const balanceBefore = await connection.getBalance(keypair.publicKey).catch(() => 0);

    const resp = await axios.post(
      PUMPPORTAL_URL,
      {
        publicKey: keypair.publicKey.toBase58(),
        action: 'sell',
        mint: mintAddress,
        amount: `${amountPct}%`,
        denominatedInSol: 'false',
        slippage: 15,
        priorityFee: 0.0005,
        pool: 'auto',
      },
      { responseType: 'arraybuffer', timeout: 15_000 }
    );

    const txBytes = new Uint8Array(resp.data);
    const txSignature = await signAndSend(txBytes, keypair, connection);
    await connection.confirmTransaction(txSignature, 'confirmed');

    const balanceAfter = await connection.getBalance(keypair.publicKey).catch(() => 0);
    const solReceived = Math.max(0, (balanceAfter - balanceBefore) / 1_000_000_000);

    console.info(
      `[pumpportal] ✅ Sold ${mintAddress.slice(0, 8)} → ${solReceived.toFixed(5)} SOL tx:${txSignature}`
    );
    return { success: true, solReceived, txSignature };
  } catch (err: any) {
    const msg = err?.response?.data
      ? Buffer.from(err.response.data).toString('utf8').slice(0, 200)
      : err.message?.slice(0, 200);
    console.warn(`[pumpportal] Sell failed for ${mintAddress.slice(0, 8)}: ${msg}`);
    return { success: false, error: msg ?? 'PumpPortal sell failed' };
  }
}

/** Buy via PumpPortal. amountSol is how much SOL to spend. */
export async function buyViaPumpPortal(
  mintAddress: string,
  amountSol: number,
  keypair: Keypair,
  connection: Connection
): Promise<{ success: boolean; txSignature?: string; error?: string }> {
  if (!ENABLED) return { success: false, error: 'PumpPortal disabled' };

  try {
    const resp = await axios.post(
      PUMPPORTAL_URL,
      {
        publicKey: keypair.publicKey.toBase58(),
        action: 'buy',
        mint: mintAddress,
        amount: amountSol,
        denominatedInSol: 'true',
        slippage: 10,
        priorityFee: 0.0001,
        pool: 'auto',
      },
      { responseType: 'arraybuffer', timeout: 15_000 }
    );

    const txBytes = new Uint8Array(resp.data);
    const txSignature = await signAndSend(txBytes, keypair, connection);
    await connection.confirmTransaction(txSignature, 'confirmed');

    console.info(
      `[pumpportal] ✅ Bought ${mintAddress.slice(0, 8)} for ${amountSol} SOL tx:${txSignature}`
    );
    return { success: true, txSignature };
  } catch (err: any) {
    const msg = err?.response?.data
      ? Buffer.from(err.response.data).toString('utf8').slice(0, 200)
      : err.message?.slice(0, 200);
    console.warn(`[pumpportal] Buy failed for ${mintAddress.slice(0, 8)}: ${msg}`);
    return { success: false, error: msg ?? 'PumpPortal buy failed' };
  }
}
