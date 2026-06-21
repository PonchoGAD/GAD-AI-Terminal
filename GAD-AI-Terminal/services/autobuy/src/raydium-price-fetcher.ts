// VULN 2: Replace DexScreener price lag (15-45s) with direct on-chain Raydium AMM read.
// Raydium AMM V4 pools have two vault token accounts (baseVault, quoteVault).
// Price = quoteReserve / baseReserve — computed from on-chain balances in real time.
// Latency: RPC call ~50-200ms (Helius), vs DexScreener 15-45s lag.

import { Connection, PublicKey } from '@solana/web3.js';
import axios from 'axios';

// In-memory vault cache: mint → {baseVault, quoteVault}
// Populated on first buy of a token; used in all subsequent sell checks.
const _vaultCache = new Map<string, { baseVault: string; quoteVault: string }>();

export function setRaydiumVaults(mint: string, baseVault: string, quoteVault: string): void {
  _vaultCache.set(mint, { baseVault, quoteVault });
  console.debug(`[raydium-rpc] Vault cache set for ${mint.slice(0, 8)}: base=${baseVault.slice(0, 8)} quote=${quoteVault.slice(0, 8)}`);
}

export function hasRaydiumVaults(mint: string): boolean {
  return _vaultCache.has(mint);
}

// Fetch on-chain reserve price: SOL reserve / token reserve = price in SOL.
// Returns 0 if vaults not cached or RPC fails — caller falls back to Jupiter/DexScreener.
export async function getRaydiumOnChainPrice(
  connection: Connection,
  mint: string
): Promise<number> {
  const vaults = _vaultCache.get(mint);
  if (!vaults) return 0;

  try {
    const [baseBalance, quoteBalance] = await Promise.all([
      connection.getTokenAccountBalance(new PublicKey(vaults.baseVault)),
      connection.getTokenAccountBalance(new PublicKey(vaults.quoteVault)),
    ]);

    const reserveBase  = baseBalance.value.uiAmount  ?? 0;  // token amount
    const reserveQuote = quoteBalance.value.uiAmount ?? 0;  // SOL amount

    if (reserveBase === 0 || reserveQuote === 0) return 0;

    // Price = SOL reserve / token reserve (SOL per readable token)
    return reserveQuote / reserveBase;
  } catch (e: any) {
    console.warn(`[raydium-rpc] On-chain price fetch failed for ${mint.slice(0, 8)}: ${e.message?.slice(0, 60)}`);
    return 0;
  }
}

// Resolve vault addresses for a Raydium AMM V4 pool using the Raydium public API.
// Called once per token at buy time. Failure is non-fatal — falls back to Jupiter price.
export async function resolveRaydiumVaults(
  pairAddress: string,
  mint: string
): Promise<void> {
  if (_vaultCache.has(mint)) return; // already resolved

  try {
    // Raydium v2 pool endpoint — returns baseVault and quoteVault public keys
    const res = await axios.get(
      `https://api.raydium.io/v2/sdk/pool/info?poolId=${pairAddress}`,
      { timeout: 4_000 }
    );
    const data = res.data?.data ?? res.data;
    const baseVault  = data?.baseVault  ?? data?.pcVault;
    const quoteVault = data?.quoteVault ?? data?.coinVault;

    if (baseVault && quoteVault) {
      setRaydiumVaults(mint, baseVault, quoteVault);
      return;
    }
  } catch { /* Raydium API unavailable — try DexScreener pair data */ }

  // Fallback: try DexScreener extended pair info for vault accounts
  try {
    const res = await axios.get(
      `https://api.dexscreener.com/latest/dex/pairs/solana/${pairAddress}`,
      { timeout: 3_000 }
    );
    const pair = res.data?.pair ?? res.data?.pairs?.[0];
    const baseVault  = pair?.liquidity?.baseVault  ?? pair?.poolInfo?.baseVault;
    const quoteVault = pair?.liquidity?.quoteVault ?? pair?.poolInfo?.quoteVault;
    if (baseVault && quoteVault) {
      setRaydiumVaults(mint, baseVault, quoteVault);
    }
  } catch { /* vault resolution failed — on-chain price unavailable for this token */ }
}
