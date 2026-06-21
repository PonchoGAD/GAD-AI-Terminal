/**
 * Jito MEV Bundle Helper — anti-frontrun transaction submission.
 *
 * Standard path: sendRawTransaction via public RPC → mempool visible → sandwich attacks possible.
 * Jito path: private bundle relay to block engine → no mempool → guaranteed ordering or full refund.
 *
 * Jito tip: 0.0001-0.0003 SOL per bundle (pays validator directly).
 * Bundle size: up to 5 txs. We use 1 (the buy/sell tx itself).
 *
 * Docs: https://jito-labs.gitbook.io/mev/searcher-resources/bundles
 */

import { VersionedTransaction, Connection, Keypair, PublicKey, SystemProgram, TransactionMessage } from '@solana/web3.js';
import axios from 'axios';
import bs58 from 'bs58';

// Jito block engine endpoints (US, EU, Asia)
const JITO_ENDPOINTS = [
  'https://mainnet.block-engine.jito.wtf/api/v1/bundles',
  'https://amsterdam.mainnet.block-engine.jito.wtf/api/v1/bundles',
  'https://tokyo.mainnet.block-engine.jito.wtf/api/v1/bundles',
];

// Jito tip account (official tip accounts — any of these work)
const JITO_TIP_ACCOUNTS = [
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
];

const TIP_SOL = Number(process.env.JITO_TIP_SOL ?? '0.0002');  // 0.0002 SOL tip

export interface JitoResult {
  ok: boolean;
  bundleId?: string;
  endpoint?: string;
  error?: string;
}

/**
 * Submit a VersionedTransaction via Jito bundle for frontrun protection.
 * Adds a tip TX to a random Jito tip account.
 *
 * @param connection  Solana connection (for getLatestBlockhash)
 * @param txBytes     Raw serialized VersionedTransaction bytes from PumpPortal
 * @param payer       Keypair of the wallet sending (needed for tip TX signing)
 */
export async function sendViaJito(
  connection: Connection,
  txBytes: Buffer | Uint8Array,
  payer: Keypair
): Promise<JitoResult> {
  try {
    // 1. Deserialize the main transaction
    const mainTx = VersionedTransaction.deserialize(txBytes);

    // 2. Build tip transaction
    const tipAccount = new PublicKey(
      JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)]
    );
    const { blockhash } = await connection.getLatestBlockhash('confirmed');
    const tipIx = SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey:   tipAccount,
      lamports:   Math.floor(TIP_SOL * 1e9),
    });
    const tipMsg = new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: blockhash,
      instructions: [tipIx],
    }).compileToV0Message();
    const tipTx = new VersionedTransaction(tipMsg);
    tipTx.sign([payer]);

    // 3. Encode both transactions as base58
    const mainB58 = bs58.encode(mainTx.serialize());
    const tipB58  = bs58.encode(tipTx.serialize());

    // 4. Submit bundle — try each endpoint until one succeeds
    for (const endpoint of JITO_ENDPOINTS) {
      try {
        const resp = await axios.post(endpoint, {
          jsonrpc: '2.0', id: 1,
          method: 'sendBundle',
          params: [[mainB58, tipB58]],
        }, {
          headers: { 'Content-Type': 'application/json' },
          timeout: 8_000,
        });

        if (resp.data?.result) {
          console.info(`[jito] ✅ Bundle submitted: ${resp.data.result} via ${endpoint.split('/')[2]}`);
          return { ok: true, bundleId: resp.data.result, endpoint };
        }

        const errMsg = resp.data?.error?.message ?? JSON.stringify(resp.data);
        console.debug(`[jito] ${endpoint.split('/')[2]}: ${errMsg}`);
      } catch (endpointErr: any) {
        console.debug(`[jito] ${endpoint.split('/')[2]} failed: ${endpointErr.message?.slice(0, 40)}`);
      }
    }

    return { ok: false, error: 'all_endpoints_failed' };
  } catch (err: any) {
    console.warn(`[jito] Bundle error: ${err.message?.slice(0, 60)}`);
    return { ok: false, error: err.message?.slice(0, 60) };
  }
}

/**
 * Fallback: send via standard RPC if Jito fails.
 * Used as graceful degradation when Jito block engine is unreachable.
 */
export async function sendTxWithFallback(
  connection: Connection,
  txBytes: Buffer | Uint8Array,
  payer: Keypair
): Promise<{ ok: boolean; sig?: string; method: 'jito' | 'rpc' }> {
  // Try Jito first
  const jitoResult = await sendViaJito(connection, txBytes, payer);
  if (jitoResult.ok) return { ok: true, sig: jitoResult.bundleId, method: 'jito' };

  // Fallback to standard RPC
  try {
    const tx = VersionedTransaction.deserialize(txBytes);
    const sig = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: true,
      maxRetries: 3,
    });
    console.info(`[jito] Fallback RPC tx: ${sig.slice(0, 20)}...`);
    return { ok: true, sig, method: 'rpc' };
  } catch (err: any) {
    console.warn(`[jito] RPC fallback failed: ${err.message?.slice(0, 60)}`);
    return { ok: false, method: 'rpc' };
  }
}
