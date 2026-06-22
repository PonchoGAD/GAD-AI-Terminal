/**
 * Polymarket Market Validator — wash-trading and liquidity defense
 *
 * Filters out manipulated or illiquid markets before signal scoring.
 * Three checks:
 *
 *   1. MIN_VOLUME: low-volume markets = thin orderbook = easy to manipulate
 *   2. Bid-Ask Spread: YES + NO prices should sum to ~$1.00 (±12%)
 *      If spread is distorted, the orderbook is manipulated or empty
 *   3. Duration cap: markets ending >14 days out = capital lock risk
 *      (our positions have 2h max, so we want markets resolving soon)
 *
 * Usage: call validatePolymarketMarket() in scorer.ts before processNewsSignal()
 */

export interface PolymarketValidation {
  isTradeable: boolean;
  reason?:     string;
}

const MIN_VOLUME_USD     = Number(process.env.POLY_MIN_VOLUME_USD   ?? '50000');
const MAX_SPREAD_SUM     = Number(process.env.POLY_MAX_SPREAD_SUM   ?? '1.12');
const MIN_SPREAD_SUM     = Number(process.env.POLY_MIN_SPREAD_SUM   ?? '0.88');
const MAX_DURATION_DAYS  = Number(process.env.POLY_MAX_DURATION_DAYS ?? '14');

export function validatePolymarketMarket(
  volumeUsd:  number,
  priceYes:   number,
  priceNo:    number,
  endsAt:     string,
): PolymarketValidation {

  // 1. Volume filter — protects against wash-trading bait markets
  if (volumeUsd < MIN_VOLUME_USD) {
    return { isTradeable: false, reason: `LOW_VOLUME ($${volumeUsd.toFixed(0)} < $${MIN_VOLUME_USD})` };
  }

  // 2. Spread integrity check
  // In an efficient market: priceYes + priceNo ≈ 1.00 (CLOB maintains this)
  // Large deviation = manipulated prices or no real liquidity
  const spreadSum = priceYes + priceNo;
  if (spreadSum > MAX_SPREAD_SUM || spreadSum < MIN_SPREAD_SUM) {
    return {
      isTradeable: false,
      reason: `MANIPULATED_SPREAD (YES:${priceYes.toFixed(2)} + NO:${priceNo.toFixed(2)} = ${spreadSum.toFixed(2)}, expected 0.88-1.12)`,
    };
  }

  // 3. Duration cap — don't enter positions that lock capital for >14 days
  const endsAtMs = new Date(endsAt).getTime();
  if (isNaN(endsAtMs)) {
    return { isTradeable: false, reason: 'INVALID_END_DATE' };
  }
  const daysRemaining = (endsAtMs - Date.now()) / (24 * 60 * 60 * 1000);
  if (daysRemaining > MAX_DURATION_DAYS) {
    return {
      isTradeable: false,
      reason: `EXCESSIVE_DURATION (${daysRemaining.toFixed(1)} days, max ${MAX_DURATION_DAYS})`,
    };
  }
  if (daysRemaining < 0) {
    return { isTradeable: false, reason: 'MARKET_ALREADY_ENDED' };
  }

  return { isTradeable: true };
}
