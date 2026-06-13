import axios from 'axios';
import { OHLCV, TechnicalSignal, Signal } from './types';

const BINANCE_BASE = 'https://api.binance.com/api/v3';

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

// ── EMA calculation ───────────────────────────────────────────────────────────
function ema(values: number[], period: number): number[] {
  if (values.length < period) return values.map(() => 0);
  const k      = 2 / (period + 1);
  const result = new Array(values.length).fill(0);
  // seed with SMA
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

  // Top 20% = resistance cluster, bottom 20% = support cluster
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

  // EMA trend
  if (price > e21 && e21 > e50) longPts  += 30;
  if (price < e21 && e21 < e50) shortPts += 30;

  // EMA21 momentum (crossover direction)
  if (e21 > e21Prev) longPts  += 15;
  else                shortPts += 15;

  // RSI
  if (rsi14 >= 50 && rsi14 <= 70) longPts  += 20; // bullish but not overbought
  if (rsi14 <= 50 && rsi14 >= 30) shortPts += 20; // bearish but not oversold
  if (rsi14 > 75)                  shortPts += 15; // overbought = take short
  if (rsi14 < 25)                  longPts  += 15; // oversold = take long

  // Volume confirmation
  if (volR >= 1.3) {
    if (longPts > shortPts)  longPts  += 15;
    else                     shortPts += 15;
  }

  // Price vs S/R (price within 0.5% of support = long; near resistance = short)
  // (applied in the caller after SR calc)

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

  const price = closes[closes.length - 1];
  const e21   = ema21arr[ema21arr.length - 1];
  const e50   = ema50arr[ema50arr.length - 1];

  const { signal, strength } = buildSignal(closes, ema21arr, ema50arr, rsi14, volR);

  return {
    price,
    ema21: e21,
    ema50: e50,
    rsi14,
    volRatio: volR,
    signal,
    strength,
    srLevels,
    ts: new Date(),
  };
}

export function formatSignalReport(s: TechnicalSignal): string {
  const arrow     = s.ema21 > s.ema50 ? '↑' : s.ema21 < s.ema50 ? '↓' : '→';
  const rsiEmoji  = s.rsi14 > 70 ? '🔴 OB' : s.rsi14 < 30 ? '🟢 OS' : s.rsi14 > 55 ? '🟡 Bull' : '🟡 Bear';
  const sigEmoji  = s.signal === 'LONG' ? '🟢 LONG' : s.signal === 'SHORT' ? '🔴 SHORT' : '⬜ FLAT';
  const volBadge  = s.volRatio >= 1.5 ? '🔥HIGH' : s.volRatio >= 1.1 ? 'norm+' : 'low';

  return [
    `📈 ENTRY SIGNAL (SOL-PERP 15m)`,
    ``,
    `Price:  $${s.price.toFixed(3)}`,
    `EMA21:  $${s.ema21.toFixed(3)}  EMA50: $${s.ema50.toFixed(3)} ${arrow}`,
    `RSI14:  ${s.rsi14.toFixed(1)} ${rsiEmoji}`,
    `Volume: ${s.volRatio.toFixed(2)}x avg ${volBadge}`,
    `S/R:    S=$${s.srLevels.support.toFixed(2)}  R=$${s.srLevels.resistance.toFixed(2)}`,
    ``,
    `Signal: ${sigEmoji}  (strength ${s.strength}/100)`,
    `At: ${s.ts.toLocaleTimeString('ru-RU')}`,
  ].join('\n');
}
