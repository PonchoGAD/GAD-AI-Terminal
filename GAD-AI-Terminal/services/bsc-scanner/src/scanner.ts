import axios from 'axios';
import { query } from '@lib/db';
import { checkBscTokenSafety } from '@lib/bsc';

// ─── Config — Dip Buyer Strategy ─────────────────────────────────────────────
// Target: established BSC tokens ($20M+ mcap) bought on significant dips.
// Exit: sell 50% at 2x from entry, hold rest with trailing stop.

const MIN_MCAP_USD   = Number(process.env.BSC_DIP_MIN_MCAP_USD  || '20000000');  // $20M min market cap
const MAX_MCAP_USD   = Number(process.env.BSC_DIP_MAX_MCAP_USD  || '300000000'); // $300M max (smaller caps move more)
const MIN_VOL_24H    = Number(process.env.BSC_DIP_MIN_VOL_24H   || '200000');    // $200k 24h volume — must have real liquidity
const MIN_LIQ_USD    = Number(process.env.BSC_DIP_MIN_LIQ_USD   || '100000');    // $100k min pool liquidity (execute our buy cleanly)
const DIP_PC24H_MIN  = Number(process.env.BSC_DIP_PC24H_MIN     || '-60');       // not in free-fall
const DIP_PC24H_MAX  = Number(process.env.BSC_DIP_PC24H_MAX     || '-10');       // must actually be on a dip (-10% min)
const STAB_PC1H_MIN  = Number(process.env.BSC_DIP_PC1H_MIN      || '-12');       // not still crashing fast
const STAB_PC1H_MAX  = Number(process.env.BSC_DIP_PC1H_MAX      || '25');        // not already recovered 25%+ in 1h
const MAX_BUY_TAX    = Number(process.env.BSC_MAX_BUY_TAX       || '5');
const MAX_SELL_TAX   = Number(process.env.BSC_MAX_SELL_TAX       || '5');
const MIN_SAFE_SCORE = Number(process.env.BSC_MIN_SAFE_SCORE     || '40');

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
  price_change_24h: number;  // key dip signal
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
    // Use marketCap (circulating) first, not FDV — FDV can be 3-10x circulating for BSC tokens.
    // FDV-based mcap filter passes tokens with tiny circulating supply that fail the $20M threshold.
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
// Strategy: find established BSC tokens that have recently dropped -10% to -60%.
// We look at multiple angle to build a universe of $20M+ mcap BSC tokens,
// then filter them for dip conditions.
async function fetchBscDipCandidates(): Promise<BscToken[]> {
  const seen  = new Set<string>();
  const results: BscToken[] = [];

  // Source 1: DexScreener BSC pairs with broad keyword searches.
  // These queries return many established BSC tokens across DeFi, gaming, meme sectors.
  const queries = [
    'bnb defi', 'pancakeswap bsc', 'bsc gaming', 'bnb meme', 'bsc ai token',
    'bsc metaverse', 'bnb yield', 'bsc nft', 'bnb ecosystem', 'cake bsc',
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

  // Source 2: DexScreener top-boosted BSC tokens — often established projects with communities.
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

  // Source 3: CoinGecko BNB Chain ecosystem — top tokens by volume, includes established projects.
  try {
    const cgR = await axios.get(
      'https://api.coingecko.com/api/v3/coins/markets' +
      '?vs_currency=usd&category=bnb-chain-ecosystem' +
      '&order=volume_desc&per_page=100&sparkline=false' +
      '&price_change_percentage=24h',
      { timeout: 10_000, headers: { 'Accept': 'application/json' } }
    );
    const cgTokens: any[] = cgR.data ?? [];
    // For tokens matching our criteria, look up BSC pair on DexScreener
    const candidates = cgTokens
      .filter(t =>
        (t.market_cap ?? 0) >= MIN_MCAP_USD &&
        (t.total_volume ?? 0) >= MIN_VOL_24H &&
        (t.price_change_percentage_24h ?? 0) <= DIP_PC24H_MAX &&
        (t.price_change_percentage_24h ?? 0) >= DIP_PC24H_MIN
      )
      .slice(0, 20);

    if (candidates.length > 0) {
      const symbols = candidates.map(t => t.symbol?.toUpperCase()).filter(Boolean);
      console.info(`[bsc-scan] CoinGecko: ${candidates.length} BSC dip candidates: ${symbols.slice(0, 5).join(', ')}`);
      for (const cg of candidates) {
        try {
          const searchR = await axios.get(
            `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(cg.symbol + ' bsc')}`,
            { timeout: 5_000 }
          );
          for (const p of (searchR.data?.pairs ?? []) as any[]) {
            if (p.chainId !== 'bsc') continue;
            const addr = p.baseToken?.address?.toLowerCase();
            if (!addr || seen.has(addr)) continue;
            seen.add(addr);
            const t = mapDexPair(p);
            if (t) results.push(t);
          }
          await new Promise(r => setTimeout(r, 300));
        } catch { continue; }
      }
    }
  } catch (e: any) {
    console.debug(`[bsc-scan] CoinGecko fetch failed: ${e.message?.slice(0, 60)}`);
  }

  console.info(`[bsc-scan] Discovery: ${results.length} BSC pairs found`);
  return results;
}

// ─── Dip Filter ──────────────────────────────────────────────────────────────
// Passes ONLY established tokens in clear dip that may recover.
function passesDipFilter(t: BscToken): string | null {
  // Must have real market cap (established token)
  if (t.mcap_usd < MIN_MCAP_USD) return `mcap:$${(t.mcap_usd/1e6).toFixed(1)}M < $${(MIN_MCAP_USD/1e6).toFixed(0)}M`;
  if (t.mcap_usd > MAX_MCAP_USD) return `mcap:$${(t.mcap_usd/1e6).toFixed(0)}M > $${(MAX_MCAP_USD/1e6).toFixed(0)}M`;

  // Must have real liquidity and volume
  if (t.liquidity_usd < MIN_LIQ_USD) return `liq:$${t.liquidity_usd.toFixed(0)} < $${MIN_LIQ_USD}`;
  if (t.volume_24h < MIN_VOL_24H)    return `vol24h:$${t.volume_24h.toFixed(0)} < $${MIN_VOL_24H}`;

  // Must be on a dip (24h decline required)
  if (t.price_change_24h > DIP_PC24H_MAX) return `pc24h:${t.price_change_24h.toFixed(1)}% not a dip (need ≤${DIP_PC24H_MAX}%)`;
  if (t.price_change_24h < DIP_PC24H_MIN) return `pc24h:${t.price_change_24h.toFixed(1)}% free-fall (min:${DIP_PC24H_MIN}%)`;

  // Must be stabilizing (not still in free-fall in the last 1h)
  if (t.price_change_1h < STAB_PC1H_MIN) return `pc1h:${t.price_change_1h.toFixed(1)}% still falling (min:${STAB_PC1H_MIN}%)`;
  if (t.price_change_1h > STAB_PC1H_MAX) return `pc1h:${t.price_change_1h.toFixed(1)}% already recovering too fast`;

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
  const candidates = await fetchBscDipCandidates();

  const passed: BscToken[] = [];

  for (const token of candidates) {
    const dipReason = passesDipFilter(token);
    if (dipReason) {
      console.debug(`[bsc-scan] ✗dip  ${token.symbol.padEnd(10)} ${dipReason}`);
      continue;
    }
    if (recentScanned.has(token.contract_address)) {
      console.debug(`[bsc-scan] ✗cool ${token.symbol} already in portfolio (7-day cooldown)`);
      continue;
    }

    console.info(
      `[bsc-scan] 🎯 DIP CANDIDATE ${token.symbol} ` +
      `mcap:$${(token.mcap_usd/1e6).toFixed(1)}M ` +
      `vol24h:$${(token.volume_24h/1000).toFixed(0)}k ` +
      `pc24h:${token.price_change_24h.toFixed(1)}% ` +
      `pc1h:${token.price_change_1h.toFixed(1)}% ` +
      `liq:$${(token.liquidity_usd/1000).toFixed(0)}k`
    );

    // Safety check: honeypot.is + GoPlus — FAIL-CLOSED: if API unavailable, skip token.
    // Bug fix: previous code defaulted safe_score=50 (pass) when safety API failed.
    // Now: failed safety check = rejected, not silently passed.
    const safety = await checkBscTokenSafety(token.contract_address).catch(() => null);
    if (!safety) {
      console.info(`[bsc-scan] ✗safe ${token.symbol} — safety API unavailable, skipping (fail-closed)`);
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
      `mcap:$${(token.mcap_usd/1e6).toFixed(1)}M ` +
      `pc24h:${token.price_change_24h.toFixed(1)}% ` +
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
