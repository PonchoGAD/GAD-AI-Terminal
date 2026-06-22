/**
 * EVM Security Shield — 3-layer on-chain protection before any buy.
 *
 * Layer 1: Basescan contract verification (unverified = likely scam)
 * Layer 2: GoPlus Labs API — honeypot, sell-block, tax manipulation, mintable+tax combo
 *
 * This is a HARD-BLOCK guard. Unlike checkTokenSafety() which uses a scoring
 * system, any single failing flag here immediately rejects the token.
 *
 * Key additions over the existing checkTokenSafety() in libs/base/safety.ts:
 *   - CONTRACT_NOT_VERIFIED: hard block (safety.ts only reduces score)
 *   - slippage_modifiable:   not checked by safety.ts at all
 *   - is_mintable + buy_tax > 5% combo: harder threshold
 *   - tax > 12%: stricter than safety.ts (uses 10%)
 *
 * Caching: 5-minute TTL per address — avoids duplicate GoPlus calls when
 * scanner and handleNewToken both run close together.
 *
 * TODO: move to libs/evm/src/ when we create a shared EVM lib
 */
import axios from 'axios';

export interface SecurityResult {
  isSafe:  boolean;
  reason?: string;
}

const BASESCAN_API_KEY = process.env.BASESCAN_API_KEY ?? '';
const BSCSCAN_API_KEY  = process.env.BSCSCAN_API_KEY  ?? '';

// 5-minute cache — avoids redundant API calls per scan cycle
const _cache = new Map<string, { result: SecurityResult; expiresAt: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000;

export async function isTokenSafeToTrade(
  tokenAddress: string,
  chainId: number = 8453,
): Promise<SecurityResult> {
  const address = tokenAddress.toLowerCase().trim();
  const cacheKey = `${chainId}:${address}`;

  const cached = _cache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) return cached.result;

  const result = await _run(address, chainId);
  _cache.set(cacheKey, { result, expiresAt: Date.now() + CACHE_TTL_MS });
  return result;
}

async function _run(address: string, chainId: number): Promise<SecurityResult> {
  try {
    // ── Layer 1: Contract verification ────────────────────────────────────────
    // Unverified contracts are a strong scam signal — legitimate meme tokens
    // verify source code to build trust. Skip if no API key (degrade gracefully).
    const scanDomain = chainId === 8453 ? 'api.basescan.org' : 'api.bscscan.com';
    const scanApiKey = chainId === 8453 ? BASESCAN_API_KEY : BSCSCAN_API_KEY;

    if (scanApiKey) {
      try {
        const verResp = await axios.get(
          `https://${scanDomain}/api?module=contract&action=getabi&address=${address}&apikey=${scanApiKey}`,
          { timeout: 4000 },
        );
        if (verResp.data?.status !== '1') {
          return { isSafe: false, reason: 'CONTRACT_NOT_VERIFIED' };
        }
      } catch {
        // Basescan timeout — log and continue to GoPlus (don't block on API outage)
        console.debug(`[evm-shield] ⚠ Basescan timeout for ${address.slice(0,10)} — skipping verify layer`);
      }
    }

    // ── Layer 2: GoPlus Labs (free, no key required) ───────────────────────────
    const goplusResp = await axios.get(
      `https://api.gopluslabs.io/api/v1/token_security/${chainId}?addresses=${address}`,
      { timeout: 6000 },
    );
    const report = goplusResp.data?.result?.[address];

    if (!report) {
      // GoPlus returned nothing — API may be down. Degrade gracefully (fail open).
      console.debug(`[evm-shield] ⚠ GoPlus returned no data for ${address.slice(0,10)} — proceeding`);
      return { isSafe: true };
    }

    // Hard blocks — each of these alone is sufficient to reject
    if (report.is_honeypot === '1' || report.cannot_buy === '1' || report.cannot_sell_all === '1') {
      return { isSafe: false, reason: 'HONEYPOT_DETECTED' };
    }
    if (report.slippage_modifiable === '1') {
      // Owner can change buy/sell tax at will — classic rug mechanic
      return { isSafe: false, reason: 'MODIFIABLE_TAX_DANGER_FLAG' };
    }
    if (report.is_mintable === '1' && parseFloat(report.buy_tax ?? '0') > 5) {
      // Mintable supply + existing tax = unlimited dilution + extraction combo
      return { isSafe: false, reason: 'MINTABLE_WITH_TAX_COMBINATION' };
    }
    const buyTax  = parseFloat(report.buy_tax  ?? '0');
    const sellTax = parseFloat(report.sell_tax ?? '0');
    if (buyTax > 12 || sellTax > 12) {
      return { isSafe: false, reason: `EXCESSIVE_TAX_${Math.round(Math.max(buyTax, sellTax))}PCT` };
    }

    return { isSafe: true };
  } catch (err: any) {
    // Network error, timeout, or unexpected format — fail open to avoid blocking
    // legitimate tokens during API outages
    console.debug(`[evm-shield] ⚠ Security check error for ${address.slice(0,10)}: ${err?.message ?? err}`);
    return { isSafe: true, reason: 'SECURITY_CHECK_ERROR_FAIL_OPEN' };
  }
}
