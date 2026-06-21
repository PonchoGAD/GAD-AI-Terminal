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

const TIP_SOL_DEFAULT = Number(process.env.JITO_TIP_SOL ?? '0.0002');

// ─── Dynamic Jito tip calculation ────────────────────────────────────────────
// Polls Jito's official tips endpoint to get the 25th percentile of recent landed tips.
// This avoids overpaying during quiet periods and underpaying during spam.

let _cachedTip: number | null = null;
let _tipCacheTs = 0;
const TIP_CACHE_MS = 30_000;  // refresh every 30s

// TRAP 3: bypassCache=true skips the 30s stale cache for elite signals (weight ≥ 3.0).
// Stale tip during a volatile launch means underpaying → bundle dropped → missed entry.
export async function getOptimalJitoTip(bypassCache = false): Promise<number> {
  if (!bypassCache && _cachedTip !== null && Date.now() - _tipCacheTs < TIP_CACHE_MS) return _cachedTip;

  try {
    const res = await axios.get('https://mainnet.block-engine.jito.wtf/api/v1/tips', { timeout: 4_000 });
    const tips: any[] = Array.isArray(res.data) ? res.data : [];
    if (!tips.length) return TIP_SOL_DEFAULT;

    const latest = tips[0];
    // landed_tips_25th_percentile is in lamports
    const p25Lamports = Number(latest.landed_tips_25th_percentile ?? TIP_SOL_DEFAULT * 1e9);
    // Add 5% buffer, clamp to [0.0001, 0.001] SOL
    const tipSol = Math.min(Math.max((p25Lamports / 1e9) * 1.05, 0.0001), 0.001);

    _cachedTip = tipSol;
    _tipCacheTs = Date.now();
    console.debug(`[jito] Dynamic tip: ${tipSol.toFixed(6)} SOL (p25: ${(p25Lamports / 1e9).toFixed(6)})`);
    return tipSol;
  } catch {
    return TIP_SOL_DEFAULT;
  }
}

/**
 * Dynamic Jito tip scaled by SM signal weight.
 * Elite SM (w≥3.0): pay 3× base tip to land in same/next block.
 * Standard/Proven combos: pay 1.15× (modest buffer).
 * Cap: 0.0015 SOL (avoid overpaying in volatile fee markets).
 */
export async function calculateJitoTipForSignal(totalSignalWeight: number): Promise<number> {
  const isElite = totalSignalWeight >= 3.0;
  // For elite signals, bypass cache to get a fresh market tip — stale tip risks bundle rejection.
  const baseTip = await getOptimalJitoTip(isElite);
  if (isElite) {
    const tip = Math.min(baseTip * 3, 0.0015);
    console.info(`[jito] 🔥 Elite signal (w${totalSignalWeight}) → fresh priority tip: ${tip.toFixed(6)} SOL`);
    return tip;
  }
  return baseTip * 1.15;
}

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

    // 2. Build tip transaction (dynamic tip)
    const tipSol    = await getOptimalJitoTip();
    const tipAccount = new PublicKey(
      JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)]
    );
    const { blockhash } = await connection.getLatestBlockhash('confirmed');
    const tipIx = SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey:   tipAccount,
      lamports:   Math.floor(tipSol * 1e9),
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
