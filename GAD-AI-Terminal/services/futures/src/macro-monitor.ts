import axios from 'axios';
import { MacroState } from './types';

const CRYPTOPANIC_KEY = process.env.CRYPTOPANIC_API_KEY || '';
const STOOQ_TIMEOUT   = 5_000;

let cached: MacroState | null = null;
let lastFetch = 0;
const CACHE_MS = 5 * 60_000; // 5 min

// ── BTC price + change from Binance public API ──────────────────────────────
async function fetchBtcData(): Promise<{ price: number; change1h: number; change24h: number }> {
  const [ticker, klines] = await Promise.all([
    axios.get('https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT', { timeout: 5_000 }),
    axios.get('https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1h&limit=2', { timeout: 5_000 }),
  ]);
  const price    = parseFloat(ticker.data.lastPrice);
  const change24 = parseFloat(ticker.data.priceChangePercent);

  const prevHourClose = parseFloat(klines.data[0][4]);
  const change1h = prevHourClose > 0 ? ((price - prevHourClose) / prevHourClose) * 100 : 0;

  return { price, change1h, change24h: change24 };
}

// ── Fear & Greed from alternative.me ────────────────────────────────────────
async function fetchFearGreed(): Promise<{ value: number; label: string }> {
  const res = await axios.get('https://api.alternative.me/fng/?limit=1', { timeout: 5_000 });
  const d   = res.data.data[0];
  return { value: parseInt(d.value, 10), label: d.value_classification };
}

// ── SP500 from Stooq CSV (free, no auth) ────────────────────────────────────
async function fetchSp500Change(): Promise<number> {
  try {
    const res = await axios.get(
      'https://stooq.com/q/l/?s=^spx&f=sd2t2ohlcv&h&e=csv',
      { timeout: STOOQ_TIMEOUT, responseType: 'text' }
    );
    const lines  = String(res.data).trim().split('\n');
    const fields = lines[1]?.split(',');
    if (!fields || fields.length < 7) return 0;
    const open  = parseFloat(fields[3]);
    const close = parseFloat(fields[6]);
    return open > 0 ? ((close - open) / open) * 100 : 0;
  } catch {
    return 0; // non-critical
  }
}

// ── CryptoPanic news sentiment ────────────────────────────────────────────────
async function fetchNewsScore(): Promise<number> {
  try {
    const url = CRYPTOPANIC_KEY
      ? `https://cryptopanic.com/api/v1/posts/?auth_token=${CRYPTOPANIC_KEY}&currencies=SOL&filter=hot&public=true`
      : `https://cryptopanic.com/api/v1/posts/?currencies=SOL&filter=hot&public=true`;

    const res   = await axios.get(url, { timeout: 5_000 });
    const posts = res.data.results?.slice(0, 20) ?? [];

    let score = 0;
    for (const p of posts) {
      const v = (p.votes?.positive || 0) - (p.votes?.negative || 0);
      if (v > 0) score += 5;
      else if (v < 0) score -= 5;
    }
    return Math.max(-100, Math.min(100, score));
  } catch {
    return 0;
  }
}

// ── Composite macro score (0-100) ─────────────────────────────────────────────
function calcMacroScore(
  btcChange1h: number,
  btcChange24h: number,
  fg: number,
  news: number,
  sp500Change: number
): { score: number; ok: boolean } {

  // BTC trend: +40 pts
  let btcPts = 0;
  if (btcChange1h > 0.5)   btcPts += 20;
  else if (btcChange1h < -0.5) btcPts -= 20;
  if (btcChange24h > 2)    btcPts += 20;
  else if (btcChange24h < -2)  btcPts -= 20;

  // Fear & Greed: +30 pts  (30-70 = neutral = ok)
  let fgPts = 0;
  if (fg >= 60)       fgPts = 30;  // greed/extreme greed
  else if (fg >= 40)  fgPts = 15;  // neutral
  else if (fg >= 20)  fgPts = 5;   // fear
  else                fgPts = -10; // extreme fear

  // News: +20 pts
  const newsPts = Math.round((news / 100) * 20);

  // SP500: +10 pts
  let spPts = 0;
  if (sp500Change > 0.3)     spPts = 10;
  else if (sp500Change < -0.5) spPts = -10;

  const raw   = 50 + btcPts + fgPts + newsPts + spPts;
  const score = Math.max(0, Math.min(100, raw));

  // ok = conditions are favorable for opening LONG positions
  const ok = score >= 45 && btcChange1h > -1 && fg >= 20;

  return { score, ok };
}

// ── Public API ───────────────────────────────────────────────────────────────
export async function getMacroState(forceRefresh = false): Promise<MacroState> {
  if (!forceRefresh && cached && Date.now() - lastFetch < CACHE_MS) return cached!;

  const [btc, fg, sp500, news] = await Promise.all([
    fetchBtcData().catch(() => ({ price: 0, change1h: 0, change24h: 0 })),
    fetchFearGreed().catch(() => ({ value: 30, label: 'Fear' })),
    fetchSp500Change().catch(() => 0),
    fetchNewsScore().catch(() => 0),
  ]);

  const btcTrend: MacroState['btcTrend'] =
    btc.change1h > 0.5  ? 'BULLISH' :
    btc.change1h < -0.5 ? 'BEARISH' : 'NEUTRAL';

  const { score, ok } = calcMacroScore(btc.change1h, btc.change24h, fg.value, news, sp500);

  cached = {
    btcPrice:       btc.price,
    btcChange1h:    btc.change1h,
    btcChange24h:   btc.change24h,
    btcTrend,
    fearGreedIndex: fg.value,
    fearGreedLabel: fg.label,
    newsScore:      news,
    sp500Change:    sp500,
    dxyChange:      0, // placeholder — can add Stooq DXY later
    score,
    ok,
    updatedAt:      new Date(),
  };

  lastFetch = Date.now();
  return cached!;
}

export function formatMacroReport(m: MacroState): string {
  const btcArrow = m.btcChange1h > 0.5 ? '↑' : m.btcChange1h < -0.5 ? '↓' : '→';
  const fgEmoji  = m.fearGreedIndex >= 60 ? '😈' : m.fearGreedIndex >= 40 ? '😐' : m.fearGreedIndex >= 20 ? '😨' : '🆘';
  const okBadge  = m.ok ? '✅ FAVORABLE' : '⛔ CAUTION';

  return [
    `📊 MACRO MONITOR | ${okBadge}`,
    ``,
    `BTC  $${m.btcPrice.toFixed(0)}  ${btcArrow} 1h:${m.btcChange1h > 0 ? '+' : ''}${m.btcChange1h.toFixed(2)}%  24h:${m.btcChange24h > 0 ? '+' : ''}${m.btcChange24h.toFixed(2)}%`,
    `F&G  ${m.fearGreedIndex}/100 — ${m.fearGreedLabel} ${fgEmoji}`,
    `SP500 ${m.sp500Change > 0 ? '+' : ''}${m.sp500Change.toFixed(2)}%  |  News ${m.newsScore > 0 ? '+' : ''}${m.newsScore}`,
    ``,
    `Macro Score: ${m.score}/100`,
    `Updated: ${m.updatedAt.toLocaleTimeString('ru-RU')}`,
  ].join('\n');
}
