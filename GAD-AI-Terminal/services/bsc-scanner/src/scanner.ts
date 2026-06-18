import axios from 'axios';
import { query } from '@lib/db';
import { checkBscTokenSafety } from '@lib/bsc';

// ─── Config — Momentum Strategy ──────────────────────────────────────────────
// Target: BSC meme coins $500k-$10M mcap with active upward momentum.
// Entry: pc1h >= 3%, pc5m >= 0.5%, vol/liq momentum visible.
// Exit: TP1 at 1.3x (sell 70%), TP2 at 2.5x (sell 100%), trail 12%, stop 8%.

const MIN_MCAP_USD   = Number(process.env.BSC_MIN_MCAP_USD    || '500000');    // $500k min
const MAX_MCAP_USD   = Number(process.env.BSC_MAX_MCAP_USD    || '10000000');  // $10M max (pre-pump range)
const MIN_VOL_24H    = Number(process.env.BSC_MIN_VOL_24H     || '50000');     // $50k 24h volume
const MIN_LIQ_USD    = Number(process.env.BSC_MIN_LIQUIDITY_USD || '50000');   // $50k liquidity
const MIN_PC1H       = Number(process.env.BSC_MIN_PC1H        || '3');         // 3%+ momentum in 1h
const MAX_PC1H       = Number(process.env.BSC_MAX_PC1H        || '80');        // not already pumped 80%
const MIN_PC5M       = Number(process.env.BSC_MIN_PC5M        || '0.5');       // 0.5%+ in last 5m
const MIN_BS_RATIO   = Number(process.env.BSC_MIN_BS_RATIO    || '1.2');       // buyers dominating
const MAX_BUY_TAX    = Number(process.env.BSC_MAX_BUY_TAX     || '5');
const MAX_SELL_TAX   = Number(process.env.BSC_MAX_SELL_TAX    || '5');
const MIN_SAFE_SCORE = Number(process.env.BSC_MIN_SAFE_SCORE  || '40');

export interface BscToken {
  contract_address: string;
  symbol:           string;
  name:             string;
  pair_address:     string;
  dex_id:           string;
  source:           string;
  liquidity_usd:    number;
  volume_1h:        number;
  volume_24h:       number;
  price_change_1h:  number;
  price_change_24h: number;
  price_change_5m:  number;
  price_bnb:        number;
  mcap_usd:         number;
  age_sec:          number;
  buy_sell_ratio:   number;
  txns_h1_buys:     number;
  is_honeypot:      boolean;
  buy_tax:          number;
  sell_tax:         number;
  top_holder_pct:   number;
  safe_score:       number;
}

// ─── DexScreener BSC pair mapper ──────────────────────────────────────────────
function mapDexPair(p: any): BscToken | null {
  const addr = p.baseToken?.address?.toLowerCase();
  if (!addr || p.chainId !== 'bsc') return null;
  const createdAt = p.pairCreatedAt ? (Date.now() - Number(p.pairCreatedAt)) / 1000 : 0;
  return {
    contract_address: addr,
    symbol:           p.baseToken?.symbol ?? '',
    name:             p.baseToken?.name   ?? '',
    pair_address:     p.pairAddress ?? '',
    dex_id:           p.dexId ?? 'unknown',
    source:           'dexscreener',
    liquidity_usd:    Math.max(0, Number(p.liquidity?.usd    ?? 0)),
    volume_1h:        Math.max(0, Number(p.volume?.h1        ?? 0)),
    volume_24h:       Math.max(0, Number(p.volume?.h24       ?? 0)),
    price_change_1h:  Number(p.priceChange?.h1  ?? 0),
    price_change_24h: Number(p.priceChange?.h24 ?? 0),
    price_change_5m:  Number(p.priceChange?.m5  ?? 0),
    price_bnb:        Number(p.priceNative       ?? 0),
    mcap_usd:         Math.max(0, Number(p.marketCap ?? p.fdv ?? 0)),
    age_sec:          Math.max(0, createdAt),
    buy_sell_ratio:   Number(p.txns?.h1?.buys ?? 1) / Math.max(1, Number(p.txns?.h1?.sells ?? 1)),
    txns_h1_buys:     Number(p.txns?.h1?.buys ?? 0),
    is_honeypot:      false,
    buy_tax:          0,
    sell_tax:         0,
    top_holder_pct:   0,
    safe_score:       50,
  };
}

// ─── Token Discovery ──────────────────────────────────────────────────────────
// Strategy: find BSC meme coins $500k-$10M mcap with active momentum.
// Multiple search angles to build a universe of candidates.
async function fetchBscMomentumCandidates(): Promise<BscToken[]> {
  const seen    = new Set<string>();
  const results: BscToken[] = [];

  // Source 1: DexScreener BSC meme/trending keyword searches
  const queries = [
    'bsc meme', 'bnb meme coin', 'bsc pepe', 'bsc doge', 'bsc shib',
    'bsc trending', 'bnb viral', 'bsc ai token', 'bsc new meme', 'bnb pump',
  ];
  for (const q of queries) {
    try {
      const r = await axios.get(
        `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`,
        { timeout: 5_000 }
      );
      for (const p of (r.data?.pairs ?? []) as any[]) {
        if (p.chainId !== 'bsc') continue;
        const addr = p.baseToken?.address?.toLowerCase();
        if (!addr || seen.has(addr)) continue;
        seen.add(addr);
        const t = mapDexPair(p);
        if (t) results.push(t);
      }
      await new Promise(r => setTimeout(r, 250));
    } catch { continue; }
  }

  // Source 2: DexScreener top-boosted BSC tokens — often recently trending memes
  try {
    const boostR = await axios.get('https://api.dexscreener.com/token-boosts/top/v1', { timeout: 6_000 });
    const bscAddrs = ((Array.isArray(boostR.data) ? boostR.data : []) as any[])
      .filter(b => b.chainId === 'bsc' && b.tokenAddress)
      .map(b => b.tokenAddress as string)
      .filter(a => !seen.has(a.toLowerCase()))
      .slice(0, 20);
    if (bscAddrs.length) {
      bscAddrs.forEach(a => seen.add(a.toLowerCase()));
      const pr = await axios.get(
        `https://api.dexscreener.com/latest/dex/tokens/${bscAddrs.join(',')}`,
        { timeout: 6_000 }
      );
      for (const p of (pr.data?.pairs ?? []) as any[]) {
        if (p.chainId !== 'bsc') continue;
        const t = mapDexPair(p);
        if (t && !seen.has(t.contract_address)) { seen.add(t.contract_address); results.push(t); }
      }
    }
  } catch { }

  // Source 3: DexScreener latest BSC token profiles — new projects being promoted
  try {
    const profileR = await axios.get('https://api.dexscreener.com/token-profiles/latest/v1', { timeout: 6_000 });
    const bscProfiles = ((Array.isArray(profileR.data) ? profileR.data : []) as any[])
      .filter(p => p.chainId === 'bsc' && p.tokenAddress)
      .map(p => p.tokenAddress as string)
      .filter(a => !seen.has(a.toLowerCase()))
      .slice(0, 15);
    if (bscProfiles.length) {
      bscProfiles.forEach(a => seen.add(a.toLowerCase()));
      const pr = await axios.get(
        `https://api.dexscreener.com/latest/dex/tokens/${bscProfiles.join(',')}`,
        { timeout: 6_000 }
      );
      for (const p of (pr.data?.pairs ?? []) as any[]) {
        if (p.chainId !== 'bsc') continue;
        const t = mapDexPair(p);
        if (t && !seen.has(t.contract_address)) { seen.add(t.contract_address); results.push(t); }
      }
    }
  } catch { }

  console.info(`[bsc-scan] Discovery: ${results.length} BSC pairs found`);
  return results;
}

// ─── Momentum Filter ─────────────────────────────────────────────────────────
// Passes ONLY tokens with active upward momentum in the meme mcap range.
function passesMomentumFilter(t: BscToken): string | null {
  // mcap range: meme coins $500k-$10M
  if (t.mcap_usd < MIN_MCAP_USD) return `mcap:$${(t.mcap_usd/1000).toFixed(0)}k < $${(MIN_MCAP_USD/1000).toFixed(0)}k`;
  if (t.mcap_usd > MAX_MCAP_USD) return `mcap:$${(t.mcap_usd/1e6).toFixed(1)}M > $${(MAX_MCAP_USD/1e6).toFixed(0)}M`;

  // Must have real liquidity and volume
  if (t.liquidity_usd < MIN_LIQ_USD) return `liq:$${t.liquidity_usd.toFixed(0)} < $${MIN_LIQ_USD}`;
  if (t.volume_24h < MIN_VOL_24H)    return `vol24h:$${t.volume_24h.toFixed(0)} < $${MIN_VOL_24H}`;

  // Momentum: must be moving up right now
  if (t.price_change_1h < MIN_PC1H) return `pc1h:${t.price_change_1h.toFixed(1)}% < ${MIN_PC1H}% (no momentum)`;
  if (t.price_change_1h > MAX_PC1H) return `pc1h:${t.price_change_1h.toFixed(1)}% > ${MAX_PC1H}% (already pumped)`;
  if (t.price_change_5m < MIN_PC5M) return `pc5m:${t.price_change_5m.toFixed(1)}% < ${MIN_PC5M}% (stalling)`;

  // Buyers dominating
  if (t.buy_sell_ratio < MIN_BS_RATIO) return `bs_ratio:${t.buy_sell_ratio.toFixed(2)} < ${MIN_BS_RATIO} (sellers dominating)`;

  return null;
}

function passesSafetyFilter(t: BscToken): string | null {
  if (t.is_honeypot)              return 'HONEYPOT';
  if (t.buy_tax > MAX_BUY_TAX)   return `buy_tax:${t.buy_tax.toFixed(1)}% > ${MAX_BUY_TAX}%`;
  if (t.sell_tax > MAX_SELL_TAX) return `sell_tax:${t.sell_tax.toFixed(1)}% > ${MAX_SELL_TAX}%`;
  if (t.safe_score < MIN_SAFE_SCORE) return `score:${t.safe_score} < ${MIN_SAFE_SCORE}`;
  return null;
}

// ─── Cooldown ────────────────────────────────────────────────────────────────
const recentScanned = new Set<string>();

export async function loadBscRecentBuys(): Promise<void> {
  try {
    const result = await query<{ contract_address: string }>(
      `SELECT DISTINCT contract_address FROM bsc_positions WHERE bought_at > NOW() - INTERVAL '7 days'`
    );
    for (const row of result.rows) recentScanned.add(row.contract_address);
    if (result.rows.length > 0) {
      console.info(`[bsc-scan] Cooldown: ${result.rows.length} recent tokens skipped (7-day cooldown)`);
    }
  } catch { }
}

// ─── Main scan cycle ─────────────────────────────────────────────────────────
export async function runBscScanCycle(): Promise<BscToken[]> {
  const candidates = await fetchBscMomentumCandidates();
  const passed: BscToken[] = [];

  for (const token of candidates) {
    const momentumReason = passesMomentumFilter(token);
    if (momentumReason) {
      console.debug(`[bsc-scan] ✗mom  ${token.symbol.padEnd(10)} ${momentumReason}`);
      continue;
    }
    if (recentScanned.has(token.contract_address)) {
      console.debug(`[bsc-scan] ✗cool ${token.symbol} already in portfolio (7-day cooldown)`);
      continue;
    }

    console.info(
      `[bsc-scan] 🎯 MOMENTUM ${token.symbol} ` +
      `mcap:$${(token.mcap_usd/1000).toFixed(0)}k ` +
      `pc1h:${token.price_change_1h.toFixed(1)}% ` +
      `pc5m:${token.price_change_5m.toFixed(1)}% ` +
      `bs:${token.buy_sell_ratio.toFixed(2)} ` +
      `liq:$${(token.liquidity_usd/1000).toFixed(0)}k`
    );

    // Safety: fail-closed — skip if API unavailable
    const safety = await checkBscTokenSafety(token.contract_address).catch(() => null);
    if (!safety) {
      console.info(`[bsc-scan] ✗safe ${token.symbol} — safety API unavailable, skipping`);
      continue;
    }
    token.is_honeypot = safety.is_honeypot;
    token.buy_tax     = safety.buy_tax;
    token.sell_tax    = safety.sell_tax;
    token.safe_score  = safety.safe_score;

    const safetyReason = passesSafetyFilter(token);
    if (safetyReason) {
      console.info(`[bsc-scan] ✗safe ${token.symbol} — ${safetyReason}`);
      continue;
    }

    await upsertBscToken(token);
    recentScanned.add(token.contract_address);
    passed.push(token);

    console.info(
      `[bsc-scan] ✅ BUY SIGNAL ${token.symbol} ` +
      `mcap:$${(token.mcap_usd/1000).toFixed(0)}k ` +
      `pc1h:${token.price_change_1h.toFixed(1)}% pc5m:${token.price_change_5m.toFixed(1)}% ` +
      `tax:${token.buy_tax.toFixed(1)}/${token.sell_tax.toFixed(1)}% ` +
      `score:${token.safe_score}`
    );
  }

  return passed;
}

async function upsertBscToken(t: BscToken): Promise<void> {
  await query(
    `INSERT INTO bsc_tokens
       (contract_address, symbol, name, liquidity_usd, volume_1h, volume_24h,
        price_change_1h, price_change_5m, is_honeypot, buy_tax, sell_tax,
        safe_score, top_holder_pct, dex_id, pair_address, source, last_seen)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,NOW())
     ON CONFLICT (contract_address) DO UPDATE SET
       symbol=EXCLUDED.symbol, liquidity_usd=EXCLUDED.liquidity_usd,
       volume_1h=EXCLUDED.volume_1h, volume_24h=EXCLUDED.volume_24h,
       price_change_1h=EXCLUDED.price_change_1h,
       price_change_5m=EXCLUDED.price_change_5m, is_honeypot=EXCLUDED.is_honeypot,
       buy_tax=EXCLUDED.buy_tax, sell_tax=EXCLUDED.sell_tax,
       safe_score=EXCLUDED.safe_score, top_holder_pct=EXCLUDED.top_holder_pct,
       last_seen=NOW()`,
    [
      t.contract_address, t.symbol, t.name, t.liquidity_usd, t.volume_1h, t.volume_24h,
      t.price_change_1h, t.price_change_5m, t.is_honeypot, t.buy_tax, t.sell_tax,
      t.safe_score, t.top_holder_pct, t.dex_id, t.pair_address, t.source,
    ]
  ).catch(() => {});
}
