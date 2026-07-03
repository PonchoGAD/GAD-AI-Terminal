import axios from 'axios';
import { query } from '@lib/db';
import { OHLCV, TechnicalSignal, Signal } from './types';

const BINANCE_BASE = 'https://api.binance.com/api/v3';

// ── New guard constants ───────────────────────────────────────────────────────
const FUTURES_MIN_VOL_RATIO  = parseFloat(process.env.FUTURES_MIN_VOL_RATIO  || '0.60');
const COOLDOWN_HOURS         = parseInt(process.env.FUTURES_SL_COOLDOWN_HOURS || '4', 10);
const MAX_DAILY_SL_TRADES    = parseInt(process.env.FUTURES_MAX_DAILY_SL      || '2', 10);
const MIN_ADX                = Number(process.env.FUTURES_MIN_ADX || '22');

// ── Fetch SOL/USDT 15m candles ────────────────────────────────────────────────
export async function fetchCandles(limit = 60): Promise<OHLCV[]> {
  const res = await axios.get(`${BINANCE_BASE}/klines`, {
    params: { symbol: 'SOLUSDT', interval: '15m', limit },
    timeout: 6_000,
  });
  return res.data.map((c: any[]) => ({
    ts:     c[0],
    open:   parseFloat(c[1]),
    high:   parseFloat(c[2]),
    low:    parseFloat(c[3]),
    close:  parseFloat(c[4]),
    volume: parseFloat(c[5]),
  }));
}

// ── Fetch SOL/USDT 1H candles (for EMA200 higher timeframe filter) ────────────
async function fetchCandles1H(limit = 210): Promise<OHLCV[]> {
  const res = await axios.get(`${BINANCE_BASE}/klines`, {
    params: { symbol: 'SOLUSDT', interval: '1h', limit },
    timeout: 8_000,
  });
  return res.data.map((c: any[]) => ({
    ts:     c[0],
    open:   parseFloat(c[1]),
    high:   parseFloat(c[2]),
    low:    parseFloat(c[3]),
    close:  parseFloat(c[4]),
    volume: parseFloat(c[5]),
  }));
}

// ── EMA calculation ───────────────────────────────────────────────────────────
function ema(values: number[], period: number): number[] {
  if (values.length < period) return values.map(() => 0);
  const k      = 2 / (period + 1);
  const result = new Array(values.length).fill(0);
  result[period - 1] = values.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < values.length; i++) {
    result[i] = values[i] * k + result[i - 1] * (1 - k);
  }
  return result;
}

// ── RSI ───────────────────────────────────────────────────────────────────────
function rsi(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff; else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// ── Auto S/R from last 50 candles ────────────────────────────────────────────
function calcSR(candles: OHLCV[]): { support: number; resistance: number } {
  const last50 = candles.slice(-50);
  const highs   = last50.map(c => c.high).sort((a, b) => a - b);
  const lows    = last50.map(c => c.low).sort((a, b) => a - b);
  const topCluster    = highs.slice(-10);
  const bottomCluster = lows.slice(0, 10);
  const resistance = topCluster.reduce((s, v) => s + v, 0) / topCluster.length;
  const support    = bottomCluster.reduce((s, v) => s + v, 0) / bottomCluster.length;
  return { support, resistance };
}

// ── Volume ratio vs 20-candle avg ────────────────────────────────────────────
function volumeRatio(candles: OHLCV[]): number {
  if (candles.length < 21) return 1;
  const avg20 = candles.slice(-21, -1).reduce((s, c) => s + c.volume, 0) / 20;
  const cur   = candles[candles.length - 1].volume;
  return avg20 > 0 ? cur / avg20 : 1;
}

// ── Bollinger Bands (period=20, 2σ) ──────────────────────────────────────────
function calcBollinger(closes: number[], period = 20, mult = 2.0): { upper: number; middle: number; lower: number; width: number } {
  if (closes.length < period) return { upper: 0, middle: 0, lower: 0, width: 0 };
  const slice = closes.slice(-period);
  const mean  = slice.reduce((s, v) => s + v, 0) / period;
  const variance = slice.reduce((s, v) => s + (v - mean) ** 2, 0) / period;
  const stdDev   = Math.sqrt(variance);
  const upper    = mean + mult * stdDev;
  const lower    = mean - mult * stdDev;
  const width    = mean > 0 ? (upper - lower) / mean * 100 : 0; // % of price
  return { upper, middle: mean, lower, width };
}

// ── ADX / DMI (Wilder smoothing, period=14) ───────────────────────────────────
function calcADX(candles: OHLCV[], period = 14): { adx: number; plusDI: number; minusDI: number } {
  if (candles.length < period * 2) return { adx: 0, plusDI: 0, minusDI: 0 };

  const trArr:      number[] = [];
  const plusDMArr:  number[] = [];
  const minusDMArr: number[] = [];

  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1];
    const cur  = candles[i];
    const tr   = Math.max(cur.high - cur.low, Math.abs(cur.high - prev.close), Math.abs(cur.low - prev.close));
    const upMove   = cur.high  - prev.high;
    const downMove = prev.low  - cur.low;
    const plusDM  = upMove > downMove && upMove > 0 ? upMove : 0;
    const minusDM = downMove > upMove && downMove > 0 ? downMove : 0;
    trArr.push(tr);
    plusDMArr.push(plusDM);
    minusDMArr.push(minusDM);
  }

  let smoothTR    = trArr.slice(0, period).reduce((s, v) => s + v, 0);
  let smoothPlus  = plusDMArr.slice(0, period).reduce((s, v) => s + v, 0);
  let smoothMinus = minusDMArr.slice(0, period).reduce((s, v) => s + v, 0);

  const dxArr: number[] = [];

  for (let i = period; i < trArr.length; i++) {
    smoothTR    = smoothTR    - smoothTR / period    + trArr[i];
    smoothPlus  = smoothPlus  - smoothPlus / period  + plusDMArr[i];
    smoothMinus = smoothMinus - smoothMinus / period + minusDMArr[i];
    const pdi = smoothTR > 0 ? (smoothPlus  / smoothTR) * 100 : 0;
    const mdi = smoothTR > 0 ? (smoothMinus / smoothTR) * 100 : 0;
    const dx  = (pdi + mdi) > 0 ? (Math.abs(pdi - mdi) / (pdi + mdi)) * 100 : 0;
    dxArr.push(dx);
  }

  if (dxArr.length < period) return { adx: 0, plusDI: 0, minusDI: 0 };

  let adx = dxArr.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < dxArr.length; i++) {
    adx = (adx * (period - 1) + dxArr[i]) / period;
  }

  const finalPlusDI  = smoothTR > 0 ? (smoothPlus  / smoothTR) * 100 : 0;
  const finalMinusDI = smoothTR > 0 ? (smoothMinus / smoothTR) * 100 : 0;

  return { adx, plusDI: finalPlusDI, minusDI: finalMinusDI };
}

// ── Signal logic ──────────────────────────────────────────────────────────────
function buildSignal(
  closes: number[],
  ema21arr: number[],
  ema50arr: number[],
  rsi14: number,
  volR: number
): { signal: Signal; strength: number } {
  const last    = closes.length - 1;
  const price   = closes[last];
  const e21     = ema21arr[last];
  const e50     = ema50arr[last];
  const e21Prev = ema21arr[last - 1] || e21;

  let longPts  = 0;
  let shortPts = 0;

  if (price > e21 && e21 > e50) longPts  += 30;
  if (price < e21 && e21 < e50) shortPts += 30;

  if (e21 > e21Prev) longPts  += 15;
  else                shortPts += 15;

  if (rsi14 >= 50 && rsi14 <= 70) longPts  += 20;
  if (rsi14 <= 50 && rsi14 >= 30) shortPts += 20;
  if (rsi14 > 75)                  shortPts += 15;
  if (rsi14 < 25)                  longPts  += 15;

  if (volR >= 1.3) {
    if (longPts > shortPts)  longPts  += 15;
    else                     shortPts += 15;
  }

  if (longPts >= 50 && longPts > shortPts)  return { signal: 'LONG',  strength: Math.min(100, longPts)  };
  if (shortPts >= 50 && shortPts > longPts) return { signal: 'SHORT', strength: Math.min(100, shortPts) };
  return { signal: 'FLAT', strength: 0 };
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function getSignal(): Promise<TechnicalSignal> {
  const candles = await fetchCandles(60);
  const closes  = candles.map(c => c.close);

  const ema21arr = ema(closes, 21);
  const ema50arr = ema(closes, 50);
  const rsi14    = rsi(closes);
  const volR     = volumeRatio(candles);
  const srLevels = calcSR(candles);
  const { adx, plusDI, minusDI } = calcADX(candles);
  const bb       = calcBollinger(closes);

  const price = closes[closes.length - 1];
  const e21   = ema21arr[ema21arr.length - 1];
  const e50   = ema50arr[ema50arr.length - 1];

  let { signal, strength } = buildSignal(closes, ema21arr, ema50arr, rsi14, volR);
  let isMeanReversion = false;
  let suggestedSlPct: number | undefined;
  let maxLeverage:    number | undefined;

  // ── Guard 1: Daily SL limit + cooldown after SL ──────────────────────────
  if (signal !== 'FLAT') {
    try {
      const slRes = await query<any>(
        `SELECT COUNT(*) as cnt, MAX(closed_at) as last_sl
         FROM futures_positions
         WHERE close_reason='SL'
           AND closed_at > NOW() - INTERVAL '24 hours'`
      );
      const dailySlCount = parseInt(slRes.rows[0]?.cnt || '0', 10);
      const lastSlAt     = slRes.rows[0]?.last_sl ? new Date(slRes.rows[0].last_sl) : null;

      if (dailySlCount >= MAX_DAILY_SL_TRADES) {
        console.log(`[futures] 🚫 Daily SL limit: ${dailySlCount} SLs in last 24h (max ${MAX_DAILY_SL_TRADES}) → FLAT`);
        signal = 'FLAT'; strength = 0;
      } else if (lastSlAt) {
        const hoursSinceSl = (Date.now() - lastSlAt.getTime()) / (1000 * 60 * 60);
        if (hoursSinceSl < COOLDOWN_HOURS) {
          console.log(`[futures] 🚫 SL cooldown: last SL ${hoursSinceSl.toFixed(1)}h ago (need ${COOLDOWN_HOURS}h) → FLAT`);
          signal = 'FLAT'; strength = 0;
        }
      }
    } catch (err: any) {
      console.warn('[futures] SL guard DB check failed:', err.message);
    }
  }

  // ── Guard 2: EMA trend filter — block counter-trend entries ──────────────
  if (signal !== 'FLAT') {
    if (signal === 'LONG' && e21 < e50) {
      console.log(`[futures] 📉 EMA trend: LONG blocked — EMA21(${e21.toFixed(2)}) < EMA50(${e50.toFixed(2)}) — downtrend → FLAT`);
      signal = 'FLAT'; strength = 0;
    } else if (signal === 'SHORT' && e21 > e50) {
      console.log(`[futures] 📈 EMA trend: SHORT blocked — EMA21(${e21.toFixed(2)}) > EMA50(${e50.toFixed(2)}) — uptrend → FLAT`);
      signal = 'FLAT'; strength = 0;
    }
  }

  // ── Guard 3: Volume ratio — require momentum confirmation ────────────────
  if (signal !== 'FLAT' && volR < FUTURES_MIN_VOL_RATIO) {
    console.log(`[futures] 📉 Vol filter: ${volR.toFixed(2)}x < ${FUTURES_MIN_VOL_RATIO} min — no momentum → FLAT`);
    signal = 'FLAT'; strength = 0;
  }

  // ── Guard 4: RSI gate — avoid extreme overbought/oversold entries ─────────
  if (signal !== 'FLAT') {
    if (signal === 'LONG' && rsi14 > 70) {
      console.log(`[futures] 🔴 RSI gate: LONG blocked — RSI ${rsi14.toFixed(1)} > 70 (overbought) → FLAT`);
      signal = 'FLAT'; strength = 0;
    } else if (signal === 'SHORT' && rsi14 < 30) {
      console.log(`[futures] 🟢 RSI gate: SHORT blocked — RSI ${rsi14.toFixed(1)} < 30 (oversold) → FLAT`);
      signal = 'FLAT'; strength = 0;
    }
  }

  // ── Guard 5: ADX / Mean Reversion ────────────────────────────────────────
  // ADX < MIN_ADX = flat/ranging market — EMA trend signals unreliable.
  // Adaptive threshold: if Bollinger Bands (5min) are EXPANDING (width growing > 5%),
  // the range is breaking out → lower ADX threshold to 19 to catch early trend entries.
  // BB expansion is detected by comparing current width to the previous-candle BB width.
  const prevBb = calcBollinger(closes.slice(0, -1));
  const bbExpanding = prevBb.width > 0 && bb.width > prevBb.width * 1.05;
  const effectiveMinAdx = bbExpanding ? 19 : MIN_ADX;
  if (bbExpanding && adx >= 19 && adx < MIN_ADX) {
    console.log(`[futures] 📊 BB expanding (${prevBb.width.toFixed(2)}%→${bb.width.toFixed(2)}%) + ADX ${adx.toFixed(1)} — lowering threshold to 19 (breakout mode)`);
  }
  if (adx < effectiveMinAdx) {
    const flatMarket = bb.width > 0 && bb.width < 2.5; // BB width < 2.5% = tight range
    if (rsi14 > 68 && bb.upper > 0 && price >= bb.upper * 0.997) {
      signal = 'SHORT'; strength = 55; isMeanReversion = true; suggestedSlPct = 0.009;
      console.log(`[futures] 📊 MeanRev SHORT: ADX=${adx.toFixed(1)} RSI=${rsi14.toFixed(1)}>68 price $${price.toFixed(2)}≥BB_upper $${bb.upper.toFixed(2)} width:${bb.width.toFixed(2)}%`);
    } else if (rsi14 < 32 && bb.lower > 0 && price <= bb.lower * 1.003) {
      // MR LONG: counter-trend in ranging market — cap leverage at 1x (no multiplier).
      // In bearish macro (F&G=12) momentum can break lower even from oversold BB.
      signal = 'LONG'; strength = 45; isMeanReversion = true; suggestedSlPct = 0.009; maxLeverage = 1;
      console.log(`[futures] 📊 MeanRev LONG: ADX=${adx.toFixed(1)} RSI=${rsi14.toFixed(1)}<32 price $${price.toFixed(2)}≤BB_lower $${bb.lower.toFixed(2)} width:${bb.width.toFixed(2)}% ⚠️ lev:x1`);
    } else {
      console.log(`[futures] ADX filter: adx=${adx.toFixed(1)} < ${MIN_ADX} — no MR setup (RSI:${rsi14.toFixed(1)} BB:$${bb.lower.toFixed(2)}-$${bb.upper.toFixed(2)} w:${bb.width.toFixed(2)}%${flatMarket?' FLAT_BB':''}) → FLAT`);
      signal = 'FLAT'; strength = 0;
    }
  } else if (signal === 'LONG' && plusDI <= minusDI) {
    console.log(`[futures] ADX filter: LONG blocked — +DI(${plusDI.toFixed(1)}) ≤ -DI(${minusDI.toFixed(1)}) — bearish pressure`);
    signal = 'FLAT'; strength = 0;
  } else if (signal === 'SHORT' && minusDI <= plusDI) {
    console.log(`[futures] ADX filter: SHORT blocked — -DI(${minusDI.toFixed(1)}) ≤ +DI(${plusDI.toFixed(1)}) — bullish pressure`);
    signal = 'FLAT'; strength = 0;
  }

  // ── Guard 6: EMA200 on 1H — higher timeframe trend alignment ─────────────
  // Don't SHORT if price is above 1H EMA200 (macro uptrend) — Win Rate 27% → exits below 1:3 R:R.
  // Don't LONG if price is below 1H EMA200 (macro downtrend).
  if (signal !== 'FLAT') {
    try {
      const candles1H = await fetchCandles1H(210);
      const closes1H  = candles1H.map(c => c.close);
      const ema200arr = ema(closes1H, 200);
      const ema200    = ema200arr[ema200arr.length - 1];
      if (ema200 > 0) {
        const bufferPct  = 0.0015; // 0.15% dead-zone — prevents whipsaw when price straddles EMA200
        const distPct    = Math.abs(price - ema200) / ema200;
        const nearEma200 = distPct < bufferPct;
        if (nearEma200) {
          console.log(`[futures] ⚠️ Guard6 EMA200-1H: ${signal} blocked — price $${price.toFixed(2)} within ${(distPct*100).toFixed(3)}% of EMA200 $${ema200.toFixed(2)} (whipsaw zone) → FLAT`);
          signal = 'FLAT'; strength = 0;
        } else if (signal === 'SHORT' && price > ema200) {
          console.log(`[futures] 📈 Guard6 EMA200-1H: SHORT blocked — price $${price.toFixed(2)} > EMA200 $${ema200.toFixed(2)} (macro uptrend) → FLAT`);
          signal = 'FLAT'; strength = 0;
        } else if (signal === 'LONG' && price < ema200) {
          console.log(`[futures] 📉 Guard6 EMA200-1H: LONG blocked — price $${price.toFixed(2)} < EMA200 $${ema200.toFixed(2)} (macro downtrend) → FLAT`);
          signal = 'FLAT'; strength = 0;
        } else {
          console.log(`[futures] ✅ Guard6 EMA200-1H: ${signal} aligned — price $${price.toFixed(2)} vs EMA200 $${ema200.toFixed(2)} (dist: ${(distPct*100).toFixed(3)}%)`);
        }
      }
    } catch (err: any) {
      console.warn('[futures] EMA200 1H fetch failed (non-fatal):', err.message?.slice(0, 60));
    }
  }

  return {
    price,
    ema21: e21,
    ema50: e50,
    rsi14,
    volRatio: volR,
    signal,
    strength,
    srLevels,
    adx,
    plusDI,
    minusDI,
    ts: new Date(),
    isMeanReversion,
    suggestedSlPct,
    bbWidth: bb.width,
    maxLeverage,
  };
}

export function formatSignalReport(s: TechnicalSignal): string {
  const arrow     = s.ema21 > s.ema50 ? '↑' : s.ema21 < s.ema50 ? '↓' : '→';
  const rsiEmoji  = s.rsi14 > 70 ? '🔴 OB' : s.rsi14 < 30 ? '🟢 OS' : s.rsi14 > 55 ? '🟡 Bull' : '🟡 Bear';
  const sigEmoji  = s.signal === 'LONG' ? '🟢 LONG' : s.signal === 'SHORT' ? '🔴 SHORT' : '⬜ FLAT';
  const volBadge  = s.volRatio >= 1.5 ? '🔥HIGH' : s.volRatio >= 1.1 ? 'norm+' : s.volRatio < 0.6 ? '❌LOW' : 'low';

  const adxLabel = (s.adx ?? 0) > 35 ? '🔥strong' : (s.adx ?? 0) > 22 ? 'trend' : '😴ranging';
  const diLabel  = (s.plusDI ?? 0) > (s.minusDI ?? 0) ? `+DI>${(s.plusDI??0).toFixed(1)} ↑` : `-DI>${(s.minusDI??0).toFixed(1)} ↓`;

  const mrTag = s.isMeanReversion ? `\n⟳ MEAN REVERSION (SL ${((s.suggestedSlPct ?? 0.009)*100).toFixed(1)}% tight)` : '';
  const bbTag = s.bbWidth !== undefined ? `  BB-width:${s.bbWidth.toFixed(2)}%` : '';

  return [
    `📈 ENTRY SIGNAL (SOL-PERP 15m)`,
    ``,
    `Price:  $${s.price.toFixed(3)}`,
    `EMA21:  $${s.ema21.toFixed(3)}  EMA50: $${s.ema50.toFixed(3)} ${arrow}`,
    `RSI14:  ${s.rsi14.toFixed(1)} ${rsiEmoji}`,
    `Volume: ${s.volRatio.toFixed(2)}x avg ${volBadge}`,
    `ADX:    ${(s.adx??0).toFixed(1)} ${adxLabel}  ${diLabel}${bbTag}`,
    `S/R:    S=$${s.srLevels.support.toFixed(2)}  R=$${s.srLevels.resistance.toFixed(2)}`,
    ``,
    `Signal: ${sigEmoji}  (strength ${s.strength}/100)${mrTag}`,
    `At: ${s.ts.toLocaleTimeString('ru-RU')}`,
  ].join('\n');
}
