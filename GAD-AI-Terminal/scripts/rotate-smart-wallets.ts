/**
 * Weekly Smart Money Wallet Rotation
 *
 * Discovers high-performing wallets from whale_scores data and upserts them
 * into smart_money_wallets with tier-weighted reliability scores.
 *
 * Tier criteria (from 7-day rolling window):
 *   ELITE   → WR ≥ 45%  AND total_trades ≥ 30  → weight 3.0
 *   PROVEN  → WR ≥ 35%  AND total_trades ≥ 15  → weight 2.0
 *   STANDARD→ WR ≥ 25%  AND total_trades ≥ 10  → weight 1.0
 *   DEMOTE  → WR < 20%  OR  total_trades < 5   → deactivate
 *
 * Usage (run weekly via cron or manually):
 *   npx ts-node -p tsconfig.launch.json scripts/rotate-smart-wallets.ts
 *   OR after compiling: node dist_launch/rotate-smart-wallets.js
 */

import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL ?? 'postgresql://gad:gad@localhost:5432/gad_ai',
  max: 3,
});

interface TierConfig {
  name:         'elite' | 'proven' | 'standard';
  weight:       number;
  minWinRate:   number;  // 0–1
  minTrades:    number;
}

const TIERS: TierConfig[] = [
  { name: 'elite',    weight: 3.0, minWinRate: 0.45, minTrades: 30 },
  { name: 'proven',   weight: 2.0, minWinRate: 0.35, minTrades: 15 },
  { name: 'standard', weight: 1.0, minWinRate: 0.25, minTrades: 10 },
];

// Minimum to stay active; below this → deactivate
const DEMOTE_WIN_RATE  = 0.20;
const DEMOTE_MIN_TRADES = 5;

async function runRotation(): Promise<void> {
  const db = await pool.connect();
  try {
    // ── 1. Harvest candidates from whale_scores + wallets ────────────────────
    // Joins wallets.total_trades + wallets.win_rate (populated by whale-tracker service)
    const { rows: candidates } = await db.query<{
      address:     string;
      win_rate:    string;
      total_trades: string;
      pnl:         string;
    }>(`
      SELECT
        w.address,
        w.win_rate,
        w.total_trades,
        w.pnl
      FROM wallets w
      INNER JOIN whale_scores ws ON ws.wallet_id = w.id
      WHERE w.total_trades >= $1
        AND ws.last_scored > NOW() - INTERVAL '30 days'
      ORDER BY w.win_rate DESC, w.total_trades DESC
      LIMIT 200
    `, [DEMOTE_MIN_TRADES]);

    console.log(`[rotate] Found ${candidates.length} candidate wallets from whale_scores`);

    let promoted = 0, demoted = 0, unchanged = 0;

    for (const c of candidates) {
      const wr     = Number(c.win_rate);
      const trades = Number(c.total_trades);
      const addr   = c.address;

      // Determine target tier
      let targetTier: TierConfig | null = null;
      for (const tier of TIERS) {
        if (wr >= tier.minWinRate && trades >= tier.minTrades) {
          targetTier = tier;
          break; // TIERS is ordered best-first
        }
      }

      if (!targetTier || wr < DEMOTE_WIN_RATE) {
        // Deactivate underperforming wallet
        const r = await db.query(
          `UPDATE smart_money_wallets SET active = false
            WHERE wallet_address = $1 AND active = true`,
          [addr]
        );
        if ((r.rowCount ?? 0) > 0) {
          console.log(`[rotate] ⬇  DEMOTE ${addr.slice(0,10)} WR:${(wr*100).toFixed(0)}% trades:${trades}`);
          demoted++;
        }
        continue;
      }

      // Upsert with correct tier and weight
      const { rowCount, rows: updated } = await db.query<{ tier: string; reliability_weight: string }>(
        `INSERT INTO smart_money_wallets
           (wallet_address, network, chain, tier, reliability_weight, active, created_at)
         VALUES ($1, 'solana', 'SOLANA', $2, $3, true, NOW())
         ON CONFLICT (chain, wallet_address) DO UPDATE
           SET tier               = EXCLUDED.tier,
               reliability_weight = EXCLUDED.reliability_weight,
               active             = true
         RETURNING tier, reliability_weight`,
        [addr, targetTier.name, targetTier.weight]
      );

      const row = updated[0];
      console.log(`[rotate] ✅ UPSERT ${addr.slice(0,10)} → ${row?.tier} w${row?.reliability_weight} WR:${(wr*100).toFixed(0)}% trades:${trades}`);
      promoted++;
    }

    // ── 2. Summary ────────────────────────────────────────────────────────────
    const { rows: summary } = await db.query<{ tier: string; cnt: string; avg_wr: string }>(`
      SELECT
        tier,
        COUNT(*) as cnt,
        ROUND(AVG(ws.win_rate)::numeric * 100, 1) as avg_wr
      FROM smart_money_wallets smw
      JOIN wallets w ON w.address = smw.wallet_address
      JOIN whale_scores ws ON ws.wallet_id = w.id
      WHERE smw.active = true
      GROUP BY tier
      ORDER BY tier
    `);

    console.log('\n[rotate] === Post-rotation summary ===');
    for (const s of summary) {
      console.log(`  ${s.tier.padEnd(10)} ${s.cnt.padStart(4)} wallets  avg_WR:${s.avg_wr}%`);
    }
    console.log(`\n  Promoted: ${promoted}  Demoted: ${demoted}  Unchanged: ${unchanged}`);

  } finally {
    db.release();
    await pool.end();
  }
}

// ── Manual harvest: add wallet addresses directly by tier ────────────────────
// Use when you have addresses from external sources (manual research, Nansen, etc.)
export async function addWalletManually(
  address:  string,
  tier:     'elite' | 'proven' | 'standard',
  network:  'solana' | 'base' | 'bsc' = 'solana',
): Promise<void> {
  const db = await pool.connect();
  try {
    const weight = tier === 'elite' ? 3.0 : tier === 'proven' ? 2.0 : 1.0;
    const chain  = network === 'solana' ? 'SOLANA' : network === 'base' ? 'BASE' : 'BSC';
    await db.query(
      `INSERT INTO smart_money_wallets
         (wallet_address, network, chain, tier, reliability_weight, active, created_at)
       VALUES ($1, $2, $3, $4, $5, true, NOW())
       ON CONFLICT (chain, wallet_address) DO UPDATE
         SET tier=EXCLUDED.tier, reliability_weight=EXCLUDED.reliability_weight, active=true`,
      [address, network, chain, tier, weight]
    );
    console.log(`[sm-add] ✅ ${address.slice(0,10)} added as ${tier} (w${weight}) on ${network}`);
  } finally {
    db.release();
  }
}

runRotation().catch(err => {
  console.error('[rotate] Fatal:', err.message);
  process.exit(1);
});
