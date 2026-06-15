import axios from 'axios';
import { query } from '@lib/db';
import { checkBscTokenSafety, checkBscTopHolder } from '@lib/bsc';

// ─── Config ─────────────────────────────────────────────────────────────────
const MIN_LIQ        = Number(process.env.BSC_MIN_LIQUIDITY_USD  || '10000');
const MAX_LIQ        = Number(process.env.BSC_MAX_LIQUIDITY_USD  || '300000');
const MIN_PC1H       = Number(process.env.BSC_MIN_PC1H           || '3');    // was 8% — too strict, BSC memes move slower
const MAX_PC1H       = Number(process.env.BSC_MAX_PC1H           || '80');
const MAX_PC1H_FRESH = Number(process.env.BSC_MAX_PC1H_FRESH     || '400');  // fresh <1h: allow up to 400%
const FRESH_AGE_SEC  = Number(process.env.BSC_FRESH_AGE_SEC      || '3600');
const MIN_PC5M       = Number(process.env.BSC_MIN_PC5M           || '1');    // was 2%
const MIN_VOL_LIQ    = Number(process.env.BSC_MIN_VOL_LIQ_RATIO  || '0.10'); // was 0.18 — lower for BSC
const MAX_BS_RATIO   = Number(process.env.BSC_MAX_BUY_SELL_RATIO || '2.5');
const MAX_AGE_SEC    = Number(process.env.BSC_MAX_AGE_SEC        || '86400');  // 24h
const MIN_SAFE_SCORE = Number(process.env.BSC_MIN_SAFE_SCORE     || '40');
const MAX_BUY_TAX    = Number(process.env.BSC_MAX_BUY_TAX        || '5');     // BSC: >5% buy tax = risky
const MAX_SELL_TAX   = Number(process.env.BSC_MAX_SELL_TAX       || '5');     // BSC: >5% sell tax = honeypot risk
const MAX_TOP_HOLDER = Number(process.env.BSC_MAX_TOP_HOLDER_PCT || '30');    // dev holding >30% = rug risk
const MIN_BUYS_H1    = Number(process.env.BSC_MIN_BUYS_H1        || '5');     // was 10 — lower for fresh tokens

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

// ─── Four.meme ───────────────────────────────────────────────────────────────
// Four.meme is the main BSC memecoin launchpad (pump.fun equivalent)
// API routes confirmed working as of 2026-06
async function fetchFourMeme(): Promise<BscToken[]> {
  const tokens: BscToken[] = [];
  // Four.meme uses meme-api prefix (not /api/)
  const endpoints = [
    { url: 'https://four.meme/meme-api/v1/private/token/queryToken', method: 'post' as const,
      data: { pageIndex: 1, pageSize: 30, status: 0 } },  // status 0 = new/active
    { url: 'https://four.meme/meme-api/v1/private/token/hot', method: 'get' as const, data: null },
  ];

  for (const ep of endpoints) {
    try {
      const r = ep.method === 'post'
        ? await axios.post(ep.url, ep.data, {
            timeout: 8_000,
            headers: { 'User-Agent': 'Mozilla/5.0', 'Content-Type': 'application/json', 'Accept': 'application/json' },
          })
        : await axios.get(ep.url, {
            timeout: 8_000,
            headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
          });

      const items: any[] = r.data?.data?.rows ?? r.data?.data ?? r.data?.list ?? r.data ?? [];
      if (!Array.isArray(items)) continue;

      for (const t of items) {
        const addr = (t.tokenAddress ?? t.address ?? t.contract_address ?? '').toLowerCase();
        if (!addr || addr.length !== 42) continue;

        const createdTs = t.createTime ?? t.created_at ?? 0;
        const ageSec = createdTs > 0 ? (Date.now() / 1000 - createdTs / 1000) : 0;  // createTime is ms

        const liq = Math.max(0, Number(t.liquidity ?? t.liquidityUsd ?? t.tvl ?? 0));
        tokens.push({
          contract_address: addr,
          symbol:           t.symbol ?? 'UNKNOWN',
          name:             t.name   ?? t.symbol ?? 'Unknown',
          pair_address:     t.pairAddress  ?? t.pool ?? '',
          dex_id:           'four_meme',
          source:           'four_meme',
          liquidity_usd:    liq,
          volume_1h:        Math.max(0, Number(t.volume1h  ?? t.volume?.h1 ?? 0)),
          volume_24h:       Math.max(0, Number(t.volume24h ?? t.volume?.h24 ?? 0)),
          price_change_1h:  Number(t.priceChange1h ?? t.change1h ?? 0),
          price_change_5m:  Number(t.priceChange5m ?? t.change5m ?? 0),
          price_bnb:        Number(t.priceNative ?? t.price ?? 0),
          mcap_usd:         Math.max(0, Number(t.marketCap ?? t.mcap ?? 0)),
          age_sec:          Math.max(0, ageSec),
          buy_sell_ratio:   Number(t.buys ?? 1) / Math.max(1, Number(t.sells ?? 1)),
          txns_h1_buys:     Number(t.buys1h ?? t.buys ?? 0),
          is_honeypot:      false,
          buy_tax:          Number(t.buyTax ?? 0),
          sell_tax:         Number(t.sellTax ?? 0),
          top_holder_pct:   0,
          safe_score:       50,
        });
      }
    } catch (e: any) {
      console.debug(`[bsc-scan] Four.meme fetch failed (${ep.url}): ${e.message?.slice(0, 60)}`);
    }
  }
  return tokens;
}

// ─── DexScreener BSC ─────────────────────────────────────────────────────────
function mapDexPair(p: any): BscToken | null {
  const addr = p.baseToken?.address?.toLowerCase();
  if (!addr) return null;
  const createdAt = p.pairCreatedAt ? (Date.now() - Number(p.pairCreatedAt)) / 1000 : 0;
  return {
    contract_address: addr,
    symbol:           p.baseToken?.symbol ?? '',
    name:             p.baseToken?.name   ?? '',
    pair_address:     p.pairAddress ?? '',
    dex_id:           p.dexId ?? 'unknown',
    source:           'dexscreener',
    liquidity_usd:    Math.max(0, Number(p.liquidity?.usd    ?? 0)),  // guard negative (drained pools)
    volume_1h:        Math.max(0, Number(p.volume?.h1        ?? 0)),
    volume_24h:       Math.max(0, Number(p.volume?.h24       ?? 0)),
    price_change_1h:  Number(p.priceChange?.h1   ?? 0),
    price_change_5m:  Number(p.priceChange?.m5   ?? 0),
    price_bnb:        Number(p.priceNative       ?? 0),
    mcap_usd:         Math.max(0, Number(p.fdv ?? p.marketCap ?? 0)),
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

async function fetchDexScreenerBsc(): Promise<BscToken[]> {
  const tokens: BscToken[] = [];
  const seen = new Set<string>();

  // 1. Boosted tokens on BSC — paid promotions = dev has skin in the game
  try {
    const boostR = await axios.get('https://api.dexscreener.com/token-boosts/latest/v1', { timeout: 6_000 });
    const bscBoosted = (Array.isArray(boostR.data) ? boostR.data : []) as any[];
    const bscAddrs = bscBoosted
      .filter((b: any) => b.chainId === 'bsc' && b.tokenAddress)
      .map((b: any) => b.tokenAddress)
      .filter((a: string) => !seen.has(a.toLowerCase()))
      .slice(0, 15);
    if (bscAddrs.length) {
      bscAddrs.forEach((a: string) => seen.add(a.toLowerCase()));
      const pr = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${bscAddrs.join(',')}`, { timeout: 6_000 });
      for (const p of (pr.data?.pairs ?? []) as any[]) {
        if (p.chainId !== 'bsc') continue;
        const t = mapDexPair(p);
        if (t && !seen.has(t.contract_address)) { seen.add(t.contract_address); tokens.push(t); }
      }
    }
  } catch { }

  // 2. Latest token profiles on BSC
  try {
    const profR = await axios.get('https://api.dexscreener.com/token-profiles/latest/v1', { timeout: 6_000 });
    const bscMints: string[] = ((Array.isArray(profR.data) ? profR.data : []) as any[])
      .filter((p: any) => p.chainId === 'bsc' && p.tokenAddress && !seen.has(p.tokenAddress.toLowerCase()))
      .map((p: any) => { seen.add(p.tokenAddress.toLowerCase()); return p.tokenAddress; })
      .slice(0, 15);
    if (bscMints.length) {
      const pr = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${bscMints.join(',')}`, { timeout: 6_000 });
      for (const p of (pr.data?.pairs ?? []) as any[]) {
        if (p.chainId !== 'bsc') continue;
        const t = mapDexPair(p);
        if (t && !seen.has(t.contract_address)) { seen.add(t.contract_address); tokens.push(t); }
      }
    }
  } catch { }

  // 3. Targeted keyword searches — fresh BSC memes and recent launches
  const queries = ['bsc new launch', 'bnb meme pump', 'fourmeme bnb', 'bsc gem new', 'bnb cat dog', 'bsc ai meme'];
  for (const q of queries) {
    try {
      const r = await axios.get(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`, { timeout: 5_000 });
      for (const p of (r.data?.pairs ?? []) as any[]) {
        if (p.chainId !== 'bsc') continue;
        const addr = p.baseToken?.address?.toLowerCase();
        if (!addr || seen.has(addr)) continue;
        seen.add(addr);
        const t = mapDexPair(p);
        if (t) tokens.push(t);
      }
      await new Promise(r => setTimeout(r, 300));
    } catch { continue; }
  }

  return tokens;
}

// ─── Filter ──────────────────────────────────────────────────────────────────
function passesPreFilter(t: BscToken): string | null {
  if (t.liquidity_usd < MIN_LIQ)   return `liq:$${t.liquidity_usd.toFixed(0)} < $${MIN_LIQ}`;
  if (t.liquidity_usd > MAX_LIQ)   return `liq:$${t.liquidity_usd.toFixed(0)} > $${MAX_LIQ}`;
  if (t.price_change_1h < MIN_PC1H) return `pc1h:${t.price_change_1h.toFixed(1)}% < ${MIN_PC1H}%`;
  const maxPc1h = t.age_sec < FRESH_AGE_SEC ? MAX_PC1H_FRESH : MAX_PC1H;
  if (t.price_change_1h > maxPc1h)  return `pc1h:${t.price_change_1h.toFixed(1)}% > ${maxPc1h}% (age:${(t.age_sec/60).toFixed(0)}min)`;
  if (t.price_change_5m < MIN_PC5M) return `pc5m:${t.price_change_5m.toFixed(1)}% < ${MIN_PC5M}%`;
  if (t.volume_1h / Math.max(1, t.liquidity_usd) < MIN_VOL_LIQ)
    return `vol/liq:${(t.volume_1h / Math.max(1, t.liquidity_usd) * 100).toFixed(0)}% < ${MIN_VOL_LIQ * 100}%`;
  if (t.buy_sell_ratio > MAX_BS_RATIO) return `bs:${t.buy_sell_ratio.toFixed(1)} > ${MAX_BS_RATIO}`;
  if (t.txns_h1_buys < MIN_BUYS_H1)   return `buys1h:${t.txns_h1_buys} < ${MIN_BUYS_H1}`;
  if (t.age_sec > MAX_AGE_SEC)         return `age:${(t.age_sec/3600).toFixed(1)}h > ${MAX_AGE_SEC/3600}h`;
  return null;
}

function passesPostFilter(t: BscToken): string | null {
  if (t.is_honeypot)                return 'HONEYPOT';
  if (t.buy_tax > MAX_BUY_TAX)     return `buy_tax:${t.buy_tax.toFixed(1)}% > ${MAX_BUY_TAX}%`;
  if (t.sell_tax > MAX_SELL_TAX)   return `sell_tax:${t.sell_tax.toFixed(1)}% > ${MAX_SELL_TAX}%`;
  if (t.top_holder_pct > MAX_TOP_HOLDER) return `top_holder:${t.top_holder_pct.toFixed(1)}% > ${MAX_TOP_HOLDER}%`;
  if (t.safe_score < MIN_SAFE_SCORE) return `score:${t.safe_score} < ${MIN_SAFE_SCORE}`;
  return null;
}

// ─── Main scan cycle ─────────────────────────────────────────────────────────
const recentScanned = new Set<string>();

export async function runBscScanCycle(): Promise<BscToken[]> {
  const [fourMeme, dex] = await Promise.all([fetchFourMeme(), fetchDexScreenerBsc()]);

  // Dedupe by address, prefer Four.meme data when both sources have same token
  const seen = new Map<string, BscToken>();
  for (const t of [...fourMeme, ...dex]) {
    const existing = seen.get(t.contract_address);
    if (!existing || t.source === 'four_meme') seen.set(t.contract_address, t);
  }
  const all = [...seen.values()];

  console.info(`[bsc-scan] ${all.length} candidates — Four.meme:${fourMeme.length} DexScreener:${dex.length}`);

  const passed: BscToken[] = [];

  for (const token of all) {
    const preReason = passesPreFilter(token);
    if (preReason) {
      console.debug(`[bsc-scan] ✗ ${token.symbol} ${preReason}`);
      continue;
    }
    if (recentScanned.has(token.contract_address)) continue;

    // Safety check: honeypot.is + GoPlus + sell simulation
    const safety = await checkBscTokenSafety(token.contract_address).catch(() => null);
    if (safety) {
      token.is_honeypot = safety.is_honeypot;
      token.buy_tax     = safety.buy_tax;
      token.sell_tax    = safety.sell_tax;
      token.safe_score  = safety.safe_score;
    }

    // Top holder check (BscScan, non-blocking)
    const topHolder = await checkBscTopHolder(token.contract_address).catch(() => 0);
    token.top_holder_pct = topHolder;

    const postReason = passesPostFilter(token);
    if (postReason) {
      console.debug(`[bsc-scan] ✗ ${token.symbol} (safety) ${postReason}`);
      continue;
    }

    await upsertBscToken(token);
    recentScanned.add(token.contract_address);
    passed.push(token);
    console.info(
      `[bsc-scan] ✅ ${token.symbol} [${token.source}] ` +
      `liq:$${token.liquidity_usd.toFixed(0)} pc1h:${token.price_change_1h.toFixed(1)}% ` +
      `tax:${token.buy_tax.toFixed(1)}/${token.sell_tax.toFixed(1)}% score:${token.safe_score}`
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
       volume_1h=EXCLUDED.volume_1h, price_change_1h=EXCLUDED.price_change_1h,
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
