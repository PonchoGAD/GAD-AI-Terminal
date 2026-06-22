/**
 * Shadow Mode — log what ALL bots WOULD buy, without spending real money.
 *
 * Purpose: validate filters are actually profitable before risking funds.
 * Every 30min/1h/4h/8h a checker job looks up open shadow trades and updates
 * what the actual price movement was. After 50+ shadow trades we can calculate
 * real win rate and average ROI per bot strategy.
 *
 * Usage in any bot scanner:
 *   if (passesAllFilters && SHADOW_MODE) {
 *     await recordShadowTrade({ chain:'solana', strategy:'raydium', ... });
 *     continue; // don't buy
 *   }
 *
 * Check results: SELECT * FROM shadow_trades ORDER BY created_at DESC LIMIT 20;
 */

import { query } from '@lib/db';

export interface ShadowTradeInput {
  chain:           string;         // 'solana' | 'base' | 'bsc' | 'ton' | 'pumpfun'
  strategy:        string;         // 'raydium' | 'base-scan' | 'bsc-scan' | 'bonding-smart'
  symbol:          string;
  contract_address: string;
  entry_price:     number;
  entry_mcap_usd?: number;
  entry_liq_usd?:  number;
  entry_pc1h?:     number;
  filter_params?:  Record<string, any>;
  tp1_target?:     number;         // e.g. 30 = 30% TP target
  stop_pct?:       number;         // e.g. 8 = 8% stop-loss
}

export async function recordShadowTrade(t: ShadowTradeInput): Promise<void> {
  try {
    await query(
      `INSERT INTO shadow_trades
         (chain, strategy, symbol, contract_address, entry_price, entry_mcap_usd,
          entry_liq_usd, entry_pc1h, filter_params, tp1_target, stop_pct)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT DO NOTHING`,
      [
        t.chain, t.strategy, t.symbol, t.contract_address.toLowerCase(),
        t.entry_price, t.entry_mcap_usd ?? null, t.entry_liq_usd ?? null,
        t.entry_pc1h ?? null,
        t.filter_params ? JSON.stringify(t.filter_params) : null,
        t.tp1_target ?? null, t.stop_pct ?? null,
      ],
    );
    console.info(`[shadow] 📝 ${t.strategy}/${t.chain} WOULD BUY ${t.symbol} @ mcap:$${(t.entry_mcap_usd ?? 0).toFixed(0)} liq:$${(t.entry_liq_usd ?? 0).toFixed(0)} pc1h:${(t.entry_pc1h ?? 0).toFixed(1)}%`);
  } catch (e: any) {
    console.warn(`[shadow] recordShadowTrade error: ${e.message?.slice(0, 60)}`);
  }
}

// ─── Price fetcher (DexScreener — works for all chains) ───────────────────────
async function fetchCurrentPrice(chain: string, contractAddress: string): Promise<number | null> {
  try {
    const { default: axios } = await import('axios');
    const r = await axios.get(
      `https://api.dexscreener.com/latest/dex/tokens/${contractAddress}`,
      { timeout: 6000 }
    );
    const pairs: any[] = (r.data?.pairs ?? []).filter((p: any) => p.chainId === chain || p.chainId === `${chain}chain`);
    if (!pairs.length) return null;
    return Number(pairs[0].priceNative ?? 0) || null;
  } catch { return null; }
}

function chainToDexScreenerId(chain: string): string {
  const map: Record<string, string> = {
    solana: 'solana', base: 'base', bsc: 'bsc', ton: 'ton', pumpfun: 'solana',
  };
  return map[chain] ?? chain;
}

// ─── Checker — run every 30 min via scheduler ────────────────────────────────
export async function checkShadowTrades(): Promise<void> {
  // Fetch open trades older than 30 min
  const open = await query<{
    id: string; chain: string; symbol: string; contract_address: string;
    entry_price: number; tp1_target: number; stop_pct: number;
    created_at: Date; check_30m_pct: number | null; check_1h_pct: number | null;
    check_4h_pct: number | null; check_8h_pct: number | null;
  }>(
    `SELECT id, chain, symbol, contract_address, entry_price::float,
            tp1_target::float, stop_pct::float, created_at,
            check_30m_pct::float, check_1h_pct::float, check_4h_pct::float, check_8h_pct::float
     FROM shadow_trades
     WHERE status = 'open' AND created_at > NOW() - INTERVAL '9 hours'
     ORDER BY created_at ASC LIMIT 50`
  );

  if (!open.rows.length) return;

  let checked = 0;
  for (const row of open.rows) {
    const ageMin = (Date.now() - new Date(row.created_at).getTime()) / 60000;
    const dexChain = chainToDexScreenerId(row.chain);
    const price = await fetchCurrentPrice(dexChain, row.contract_address);
    if (!price || !row.entry_price) continue;

    const pct = ((price - row.entry_price) / row.entry_price) * 100;
    const updates: string[] = [];
    const params: any[] = [];
    let paramIdx = 1;

    if (ageMin >= 30  && !row.check_30m_pct) { updates.push(`check_30m_pct=$${paramIdx++}`); params.push(pct); }
    if (ageMin >= 60  && !row.check_1h_pct)  { updates.push(`check_1h_pct=$${paramIdx++}`);  params.push(pct); }
    if (ageMin >= 240 && !row.check_4h_pct)  { updates.push(`check_4h_pct=$${paramIdx++}`);  params.push(pct); }
    if (ageMin >= 480 && !row.check_8h_pct)  { updates.push(`check_8h_pct=$${paramIdx++}`);  params.push(pct); }

    // Determine final outcome after 8h
    let newStatus: string | null = null;
    if (ageMin >= 480) {
      newStatus = pct >= (row.tp1_target ?? 25) ? 'tp1_hit'
                : pct <= -(row.stop_pct ?? 8)   ? 'stopped'
                : 'expired';
      updates.push(`status=$${paramIdx++}`, `outcome_price=$${paramIdx++}`, `outcome_pct=$${paramIdx++}`, `outcome_at=NOW()`);
      params.push(newStatus, price, pct);
    }

    if (!updates.length) continue;
    params.push(row.id);
    await query(`UPDATE shadow_trades SET ${updates.join(',')} WHERE id=$${paramIdx}`, params);
    checked++;

    if (newStatus) {
      const icon = newStatus === 'tp1_hit' ? '✅' : newStatus === 'stopped' ? '🔴' : '⏳';
      console.info(`[shadow] ${icon} ${row.symbol} FINAL: ${pct >= 0 ? '+' : ''}${pct.toFixed(1)}% (${newStatus})`);
    }
  }

  if (checked) console.info(`[shadow] Updated ${checked} shadow trade checkpoints`);
}

// ─── Report — summary stats ───────────────────────────────────────────────────
export async function shadowReport(): Promise<string> {
  const r = await query<any>(`
    SELECT strategy, chain,
      COUNT(*) as total,
      COUNT(*) FILTER (WHERE status='tp1_hit') as wins,
      COUNT(*) FILTER (WHERE status='stopped') as losses,
      COUNT(*) FILTER (WHERE status='expired') as expired,
      COUNT(*) FILTER (WHERE status='open') as open,
      ROUND(AVG(outcome_pct)::numeric, 1) as avg_pct,
      ROUND(AVG(check_1h_pct)::numeric, 1) as avg_1h,
      ROUND(AVG(check_4h_pct)::numeric, 1) as avg_4h
    FROM shadow_trades
    GROUP BY strategy, chain
    ORDER BY chain, strategy
  `);

  if (!r.rows.length) return 'No shadow trades yet.';

  let out = '📊 Shadow Mode Report:\n';
  for (const row of r.rows) {
    const wr = row.total > 0 ? Math.round((row.wins / Math.max(1, row.wins + row.losses)) * 100) : 0;
    out += `\n[${row.strategy}/${row.chain}] ${row.total} trades | WR:${wr}% | avg:${row.avg_pct ?? '?'}% | 1h:${row.avg_1h ?? '?'}% 4h:${row.avg_4h ?? '?'}% | open:${row.open}`;
  }
  return out;
}
