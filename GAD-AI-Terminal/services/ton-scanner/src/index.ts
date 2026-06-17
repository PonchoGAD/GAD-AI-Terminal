import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import { query } from '@lib/db';
import { getTonBalance, getWalletAddress } from '@lib/ton';
import { startTonScanner } from './scanner';
import { startTonMonitor } from './monitor';

const PORT = Number(process.env.PORT || '4007');
const app  = express();
app.use(express.json());

// ─── Health / status ──────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ ok: true, service: 'ton-scanner' }));

app.get('/status', async (_req, res) => {
  try {
    const [balance, walletAddress] = await Promise.all([getTonBalance(), getWalletAddress()]);
    const [positions, trades] = await Promise.all([
      query<{ cnt: string }>(`SELECT COUNT(*) AS cnt FROM ton_positions WHERE is_active=true`, []),
      query<{ cnt: string }>(`SELECT COUNT(*) AS cnt FROM ton_positions WHERE sold_at IS NOT NULL`, []),
    ]);
    res.json({
      ok: true,
      wallet:    walletAddress,
      balance:   `${balance.toFixed(3)} TON`,
      auto_buy:  process.env.TON_AUTO_BUY === 'true',
      open_positions: Number(positions[0]?.cnt ?? 0),
      total_trades:   Number(trades[0]?.cnt ?? 0),
    });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── Positions ────────────────────────────────────────────────────────────────
app.get('/positions', async (_req, res) => {
  try {
    const rows = await query(
      `SELECT id, jetton_address, symbol, name, dex,
              amount_ton, token_amount, entry_price_ton, entry_mcap_usd,
              tp_index, trail_high, safe_score, liq_at_entry, pc1h_at_entry,
              bought_at
       FROM ton_positions WHERE is_active=true ORDER BY bought_at DESC`,
      []
    );
    res.json({ ok: true, positions: rows });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── Trade history ────────────────────────────────────────────────────────────
app.get('/trades', async (req, res) => {
  const limit = Number(req.query.limit ?? 30);
  try {
    const rows = await query(
      `SELECT id, symbol, dex, amount_ton, entry_price_ton,
              total_sold_ton, sell_reason, bought_at, sold_at
       FROM ton_positions WHERE sold_at IS NOT NULL
       ORDER BY sold_at DESC LIMIT $1`,
      [limit]
    );
    res.json({ ok: true, trades: rows });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── PnL ─────────────────────────────────────────────────────────────────────
app.get('/pnl', async (_req, res) => {
  try {
    const r = await query<{
      total_trades: string; wins: string; losses: string;
      total_spent: string;  total_received: string;
    }>(
      `SELECT
         COUNT(*) FILTER (WHERE sold_at IS NOT NULL) AS total_trades,
         COUNT(*) FILTER (WHERE sold_at IS NOT NULL AND total_sold_ton > amount_ton) AS wins,
         COUNT(*) FILTER (WHERE sold_at IS NOT NULL AND total_sold_ton <= amount_ton) AS losses,
         COALESCE(SUM(amount_ton) FILTER (WHERE sold_at IS NOT NULL), 0) AS total_spent,
         COALESCE(SUM(total_sold_ton) FILTER (WHERE sold_at IS NOT NULL), 0) AS total_received
       FROM ton_positions`,
      []
    );
    const d = r[0];
    const net = Number(d.total_received) - Number(d.total_spent);
    res.json({
      ok: true,
      total_trades: Number(d.total_trades),
      wins:         Number(d.wins),
      losses:       Number(d.losses),
      total_spent:  Number(d.total_spent),
      total_received: Number(d.total_received),
      net_pnl_ton:  net,
    });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.info(`[ton-scanner] HTTP listening on :${PORT}`);
});

startTonScanner();
startTonMonitor();
