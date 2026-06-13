export type Side = 'LONG' | 'SHORT';
export type Signal = 'LONG' | 'SHORT' | 'FLAT';
export type CloseReason = 'TP' | 'SL' | 'TRAIL' | 'MANUAL' | 'DAILY_STOP' | 'FORCED';
export type TradingMode = 'paper' | 'live';

export interface OHLCV {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface MacroState {
  btcPrice: number;
  btcChange1h: number;
  btcChange24h: number;
  btcTrend: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  fearGreedIndex: number;
  fearGreedLabel: string;
  newsScore: number;       // -100..+100 (positive = bullish news)
  sp500Change: number;     // % change today
  dxyChange: number;       // USD index change (inverse correlation with SOL)
  score: number;           // 0-100 composite macro health
  ok: boolean;             // true = favorable for longs
  updatedAt: Date;
}

export interface TechnicalSignal {
  price: number;
  ema21: number;
  ema50: number;
  rsi14: number;
  volRatio: number;       // current vol vs 20-candle avg
  signal: Signal;
  strength: number;       // 0-100
  srLevels: { support: number; resistance: number };
  ts: Date;
}

export interface PositionSize {
  sizeUsdc: number;
  leverage: number;
  notionalUsdc: number;
  riskUsdc: number;
  tpPrice: number;
  slPrice: number;
  trailPct: number;
}

export interface OpenPosition {
  id: number;
  tradeId: string;
  symbol: string;
  side: Side;
  mode: TradingMode;
  entryPrice: number;
  sizeUsdc: number;
  leverage: number;
  notionalUsdc: number;
  openedAt: Date;
  currentPrice?: number;
  unrealizedPnl?: number;
  driftOrderId?: string;
}

export interface CapitalState {
  totalUsdc: number;
  availableUsdc: number;
  inTradeUsdc: number;
  dailyPnlUsdc: number;
  totalPnlUsdc: number;
  winStreak: number;
  lossStreak: number;
  tradesToday: number;
  dailyStopHit: boolean;
}
