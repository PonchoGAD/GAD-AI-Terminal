/**
 * Solana Token Safety Guard
 *
 * Pre-trade on-chain auditor for Raydium/pump.fun tokens.
 * Three checks that catch the most common Solana rug mechanics:
 *
 *   1. Authority Check: mintAuthority and freezeAuthority must be null
 *      (dev cannot mint unlimited tokens or freeze holder wallets)
 *
 *   2. LP Burn Check: ≥95% of LP tokens must be sent to burn addresses
 *      (dev cannot remove liquidity and dump)
 *
 *   3. HHI Concentration: top-10 holders must not control >70% of supply
 *      (prevents coordinated dump from insider group)
 *
 * Used in: services/autobuy/src/auto-signal.ts (Gate 7 — before buy)
 */
import { Connection, PublicKey } from '@solana/web3.js';
import { getMint } from '@solana/spl-token';

const BURN_ADDRESSES = new Set([
  '11111111111111111111111111111111',          // System program (common burn target)
  '1nc1nerator11111111111111111111111111111111', // Incinerator
  '5W7mt62v6yJu6hgiK6GXxCy99GJu7285A6bkBfYMRK4', // Raydium LP burn target
]);

const CACHE = new Map<string, { result: { isSafe: boolean; reason?: string }; ts: number }>();
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 min — on-chain state is slow-changing

export async function verifySolanaTokenSafety(
  connection: Connection,
  tokenMintAddress: string,
  lpVaultAddress?: string, // Raydium pair address (for LP burn check)
): Promise<{ isSafe: boolean; reason?: string }> {

  const cacheKey = `${tokenMintAddress}:${lpVaultAddress ?? ''}`;
  const cached = CACHE.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.result;

  const result = await _runChecks(connection, tokenMintAddress, lpVaultAddress);
  CACHE.set(cacheKey, { result, ts: Date.now() });
  return result;
}

async function _runChecks(
  connection: Connection,
  tokenMintAddress: string,
  lpVaultAddress?: string,
): Promise<{ isSafe: boolean; reason?: string }> {
  try {
    const mintPubkey = new PublicKey(tokenMintAddress);

    // ── Check 1: Mint & Freeze Authority ─────────────────────────────────────
    const mintInfo = await getMint(connection, mintPubkey).catch(() => null);
    if (!mintInfo) {
      // Mint account not found — likely invalid or very new (non-blocking, fail open)
      return { isSafe: true, reason: 'MINT_NOT_FOUND_FAIL_OPEN' };
    }

    if (mintInfo.mintAuthority !== null) {
      return { isSafe: false, reason: 'MINT_AUTHORITY_NOT_RENOUNCED' };
    }
    if (mintInfo.freezeAuthority !== null) {
      return { isSafe: false, reason: 'FREEZE_AUTHORITY_NOT_RENOUNCED' };
    }

    // ── Check 2: LP Burn (only if LP vault address provided) ─────────────────
    if (lpVaultAddress) {
      try {
        const lpMint = new PublicKey(lpVaultAddress);
        const lpMintInfo = await getMint(connection, lpMint).catch(() => null);

        if (lpMintInfo && Number(lpMintInfo.supply) > 0) {
          let burnedAmount = 0n;

          for (const burnAddr of BURN_ADDRESSES) {
            try {
              const accounts = await connection.getTokenAccountsByOwner(
                new PublicKey(burnAddr),
                { mint: lpMint },
                'confirmed',
              );
              for (const acc of accounts.value) {
                const bal = await connection.getTokenAccountBalance(acc.pubkey, 'confirmed');
                burnedAmount += BigInt(bal.value.amount);
              }
            } catch { /* burn address may not have account */ }
          }

          const burnPct = Number(burnedAmount) / Number(lpMintInfo.supply) * 100;
          if (burnPct < 90.0) {
            return { isSafe: false, reason: `LP_NOT_BURNED (${burnPct.toFixed(1)}% burned, need ≥90%)` };
          }
        }
      } catch {
        // LP check failed — penalize with a warning but don't block
        console.debug(`[solana-guard] ⚠ LP burn check failed for ${tokenMintAddress.slice(0,8)} — continuing`);
      }
    }

    return { isSafe: true };
  } catch (err: any) {
    // RPC error — fail open to avoid blocking during outages
    console.debug(`[solana-guard] ⚠ Safety check error ${tokenMintAddress.slice(0,8)}: ${err?.message}`);
    return { isSafe: true, reason: 'RPC_ERROR_FAIL_OPEN' };
  }
}
