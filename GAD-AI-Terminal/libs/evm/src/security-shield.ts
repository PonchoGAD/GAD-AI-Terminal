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
  ageSec?: number,
): Promise<SecurityResult> {
  const address = tokenAddress.toLowerCase().trim();
  const cacheKey = `${chainId}:${address}`;

  const cached = _cache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) return cached.result;

  const result = await _run(address, chainId, ageSec);
  _cache.set(cacheKey, { result, expiresAt: Date.now() + CACHE_TTL_MS });
  return result;
}

// ── Layer 2b: honeypot.is — реальная симуляция buy+sell, ВКЛЮЧАЯ V3-пулы ─────
// Закрывает дыру POKERBULL (03.07.26): sell-revert хонипот на V3-пуле проходил
// GoPlus (флага ещё нет) и swap-simulator (V2-only, fail-open для V3).
// honeypot.is симулирует полный раунд-трип на реальном пуле любого типа.
// Отключение: EVM_HONEYPOT_IS=false
async function checkHoneypotIs(
  address: string,
  chainId: number,
  maxTax: number,
): Promise<{ verdict: 'block' | 'pass' | 'unknown'; reason?: string }> {
  if (process.env.EVM_HONEYPOT_IS === 'false') return { verdict: 'unknown', reason: 'DISABLED' };
  try {
    const r = await axios.get(
      `https://api.honeypot.is/v2/IsHoneypot?address=${address}&chainID=${chainId}`,
      { timeout: 8000 },
    );
    const d = r.data ?? {};
    if (d.honeypotResult?.isHoneypot === true) {
      const why = d.honeypotResult?.honeypotReason ? `:${String(d.honeypotResult.honeypotReason).slice(0, 40)}` : '';
      return { verdict: 'block', reason: `HONEYPOT_IS_CONFIRMED${why}` };
    }
    const sellTax = Number(d.simulationResult?.sellTax ?? 0);
    if (d.simulationSuccess === true && sellTax > maxTax) {
      return { verdict: 'block', reason: `HONEYPOT_IS_SELL_TAX_${Math.round(sellTax)}PCT` };
    }
    if (d.simulationSuccess === false) {
      // Симуляция не прошла — продаваемость НЕ доказана (canary-проба добьёт)
      return { verdict: 'unknown', reason: `SIM_FAILED:${String(d.simulationError ?? '').slice(0, 40)}` };
    }
    return { verdict: 'pass' };
  } catch (e: any) {
    return { verdict: 'unknown', reason: `API_ERROR:${e.message?.slice(0, 30)}` };
  }
}

async function _run(address: string, chainId: number, ageSec?: number): Promise<SecurityResult> {
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
      // GoPlus returned nothing — two cases:
      // 1. Token is brand-new (< 20 min) — GoPlus hasn't indexed it yet.
      //    Fail-CLOSED: very new tokens have high honeypot risk before GoPlus indexes them.
      //    20 min threshold: gives sniper-dump window time to pass while catching most scams.
      //    For 20min+ tokens: swap simulator (next check) provides runtime honeypot detection.
      // 2. API outage on an older token — fail-open (don't block legitimate tokens).
      const GOPLUS_MIN_AGE_SEC = Number(process.env.BASE_GOPLUS_MIN_AGE_SEC ?? '1200'); // 20 min default
      const isNew = ageSec !== undefined && ageSec < GOPLUS_MIN_AGE_SEC;
      if (isNew) {
        console.debug(`[evm-shield] ⚠ GoPlus no data + token <${GOPLUS_MIN_AGE_SEC/60}min old (${Math.round((ageSec ?? 0) / 60)}min) — BLOCKING ${address.slice(0,10)}`);
        return { isSafe: false, reason: 'GOPLUS_NO_DATA_NEW_TOKEN_UNDER_20MIN' };
      }
      // 03.07.26: раньше здесь был чистый fail-open — дыра POKERBULL.
      // Теперь: без GoPlus-данных требуем подтверждение продаваемости от honeypot.is.
      const hpNoData = await checkHoneypotIs(address, chainId, chainId === 56 ? 5 : 12);
      if (hpNoData.verdict === 'block') return { isSafe: false, reason: hpNoData.reason };
      if (hpNoData.verdict !== 'pass') {
        // Ни GoPlus, ни honeypot.is не подтвердили токен — fail-closed
        return { isSafe: false, reason: `NO_SAFETY_DATA_FAIL_CLOSED (${hpNoData.reason ?? 'no data'})` };
      }
      console.debug(`[evm-shield] GoPlus no data, honeypot.is PASS for ${address.slice(0,10)} — proceeding`);
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
    // BSC (56): max 5% — a 12%+12% round-trip tax needs >30% gain just to break even,
    // destroying Sharpe Ratio. Base (8453): 12% — higher upside potential justifies it.
    const maxTax = chainId === 56 ? 5 : 12;
    if (buyTax > maxTax || sellTax > maxTax) {
      const tag = chainId === 56 ? 'BSC' : 'BASE';
      return { isSafe: false, reason: `${tag}_EXCESSIVE_TAX_${Math.round(Math.max(buyTax, sellTax))}PCT_LIMIT${maxTax}` };
    }

    // ── Real-coin checks (03.07.26) — данные уже в GoPlus-отчёте, 0 доп. запросов ──
    // «Реальная монета» = реальные держатели. holder_count < 25 у токена, который
    // уже проходит фильтры моментума = бот-накрутка объёма на пустом токене.
    const holderCount = parseInt(report.holder_count ?? '0', 10);
    const MIN_HOLDERS = Number(process.env.EVM_MIN_HOLDERS ?? '25');
    if (holderCount > 0 && holderCount < MIN_HOLDERS) {
      return { isSafe: false, reason: `LOW_HOLDERS_${holderCount}_MIN${MIN_HOLDERS}` };
    }
    // Владелец/создатель держит >30% supply = может сдампить в любой момент.
    // GoPlus отдаёт долю как дробь 0-1 (0.30 = 30%).
    const ownerPct   = parseFloat(report.owner_percent   ?? '0') * 100;
    const creatorPct = parseFloat(report.creator_percent ?? '0') * 100;
    const MAX_OWNER_PCT = Number(process.env.EVM_MAX_OWNER_PCT ?? '30');
    if (ownerPct > MAX_OWNER_PCT || creatorPct > MAX_OWNER_PCT) {
      return { isSafe: false, reason: `OWNER_HOLDS_${Math.round(Math.max(ownerPct, creatorPct))}PCT_MAX${MAX_OWNER_PCT}` };
    }

    // ── Layer 2b: honeypot.is финальная проверка (03.07.26 — POKERBULL fix) ────
    // GoPlus может ещё не знать про sell-revert (POKERBULL прошёл с is_honeypot=0).
    // honeypot.is реально симулирует продажу, включая V3-пулы.
    // 'unknown' (API недоступен/симуляция не прошла) НЕ блокирует здесь —
    // финальную точку ставит canary-проба в index.ts (реальная микро-продажа).
    const hp = await checkHoneypotIs(address, chainId, maxTax);
    if (hp.verdict === 'block') return { isSafe: false, reason: hp.reason };
    if (hp.verdict === 'unknown') {
      console.debug(`[evm-shield] honeypot.is inconclusive for ${address.slice(0, 10)} (${hp.reason}) — canary probe will verify`);
    }

    return { isSafe: true };
  } catch (err: any) {
    // Network error, timeout, or unexpected format — fail open to avoid blocking
    // legitimate tokens during API outages
    console.debug(`[evm-shield] ⚠ Security check error for ${address.slice(0,10)}: ${err?.message ?? err}`);
    return { isSafe: true, reason: 'SECURITY_CHECK_ERROR_FAIL_OPEN' };
  }
}
