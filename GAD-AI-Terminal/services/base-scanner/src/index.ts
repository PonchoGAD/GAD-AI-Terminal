import express from 'express';
import { query } from '@lib/db';
import { getEthBalance, buyToken } from '@lib/base';
import { runScanCycle, BaseToken } from './scanner';
import { startMonitor, getPositionSummary } from './monitor';

const PORT      = Number(process.env.PORT         || '4005');
const BUY_ETH   = Number(process.env.BASE_BUY_ETH || '0.005');
const MAX_POS   = Number(process.env.BASE_MAX_POSITIONS || '5');
const AUTO_BUY  = process.env.BASE_AUTO_BUY !== 'false';
const WALLET    = process.env.BASE_WALLET_PUBLIC_KEY ?? 'unknown';

const app = express();
app.use(express.json());

// ─── Health ───────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ ok: true, service: 'base-scanner' }));

// ─── Status ──────────────────────────────────────────────────────────────────
app.get('/base/status', async (_req, res) => {
  try {
    const [summary, ethBal] = await Promise.all([
      getPositionSummary(),
      getEthBalance().catch(() => 0),
    ]);
    res.json({ ok: true, data: { ...summary, eth_balance: ethBal, auto_buy: AUTO_BUY, wallet: WALLET } });
  } catch (e: any) {
    res.json({ ok: false, error: e.message });
  }
});

// ─── Open positions ───────────────────────────────────────────────────────────
app.get('/base/positions', async (req, res) => {
  try {
    const limit  = Math.min(Number(req.query.limit  ?? 20), 50);
    const offset = Number(req.query.offset ?? 0);
    const r = await query(
      `SELECT id, contract_address, symbol, amount_eth, entry_price_eth,
              bought_at, tp_index, dex, total_sold_eth, sell_reason
       FROM base_positions
       WHERE is_active = true
       ORDER BY bought_at DESC LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    res.json({ ok: true, data: r.rows });
  } catch (e: any) {
    res.json({ ok: false, error: e.message });
  }
});

// ─── Single position ─────────────────────────────────────────────────────────
app.get('/base/positions/:id', async (req, res) => {
  try {
    const r = await query(`SELECT * FROM base_positions WHERE id=$1`, [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ ok: false, error: 'not found' });
    res.json({ ok: true, data: r.rows[0] });
  } catch (e: any) {
    res.json({ ok: false, error: e.message });
  }
});

// ─── Recent closed trades ─────────────────────────────────────────────────────
app.get('/base/trades', async (req, res) => {
  try {
    const limit  = Math.min(Number(req.query.limit  ?? 10), 50);
    const offset = Number(req.query.offset ?? 0);
    const r = await query(
      `SELECT id, contract_address, symbol, amount_eth, total_sold_eth,
              bought_at, sold_at, sell_reason, sell_tx
       FROM base_positions
       WHERE sold_at IS NOT NULL
       ORDER BY sold_at DESC LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    res.json({ ok: true, data: r.rows });
  } catch (e: any) {
    res.json({ ok: false, error: e.message });
  }
});

// ─── Daily stats ──────────────────────────────────────────────────────────────
app.get('/base/stats', async (req, res) => {
  try {
    const days = Math.min(Number(req.query.days ?? 7), 30);
    const r = await query(
      `SELECT date, trades, wins, eth_in, eth_out, pnl_eth
       FROM base_stats
       ORDER BY date DESC LIMIT $1`,
      [days]
    );
    res.json({ ok: true, data: r.rows });
  } catch (e: any) {
    res.json({ ok: false, error: e.message });
  }
});

// ─── Discovered tokens list ───────────────────────────────────────────────────
app.get('/base/tokens', async (req, res) => {
  try {
    const limit  = Math.min(Number(req.query.limit ?? 20), 50);
    const r = await query(
      `SELECT contract_address, symbol, name, liquidity_usd, volume_1h,
              price_change_1h, safe_score, dex_id, last_seen
       FROM base_tokens
       ORDER BY last_seen DESC LIMIT $1`,
      [limit]
    );
    res.json({ ok: true, data: r.rows });
  } catch (e: any) {
    res.json({ ok: false, error: e.message });
  }
});

// ─── Manual buy ──────────────────────────────────────────────────────────────
app.post('/base/buy', async (req, res) => {
  const { contract_address, eth_amount } = req.body ?? {};
  if (!contract_address) return res.status(400).json({ ok: false, error: 'contract_address required' });
  try {
    const result = await buyToken(contract_address, eth_amount ?? BUY_ETH);
    res.json({ ok: result.ok, data: result });
  } catch (e: any) {
    res.json({ ok: false, error: e.message });
  }
});

// ─── Auto-buy hook (called by scanner on new signals) ─────────────────────────
export async function handleNewToken(token: BaseToken): Promise<void> {
  if (!AUTO_BUY) return;

  const openCount = await query(
    `SELECT COUNT(*) as cnt FROM base_positions WHERE sold_at IS NULL AND is_active=true`
  );
  if (Number(openCount.rows[0]?.cnt ?? 0) >= MAX_POS) {
    console.info(`[base-scanner] Max positions (${MAX_POS}) reached — skipping ${token.symbol}`);
    return;
  }

  const ethBal = await getEthBalance().catch(() => 0);
  if (ethBal < BUY_ETH * 1.1) {
    console.warn(`[base-scanner] Insufficient ETH balance: ${ethBal.toFixed(5)} ETH (need ${BUY_ETH})`);
    return;
  }

  // Check daily ETH limit
  const dailyUsed = await query(
    `SELECT COALESCE(SUM(eth_in),0) as eth_in FROM base_stats WHERE date=CURRENT_DATE AND wallet=$1`,
    [WALLET]
  );
  const maxDaily = Number(process.env.BASE_MAX_ETH_DAILY || '0.1');
  if (Number(dailyUsed.rows[0]?.eth_in ?? 0) + BUY_ETH > maxDaily) {
    console.info(`[base-scanner] Daily ETH limit reached — skipping ${token.symbol}`);
    return;
  }

  console.info(`[base-scanner] 🛒 Buying ${token.symbol} ${BUY_ETH} ETH | liq:$${token.liquidity_usd.toFixed(0)} score:${token.safe_score}`);

  const ethBalBefore = await getEthBalance().catch(() => 0);
  const result = await buyToken(token.contract_address, BUY_ETH);

  if (!result.ok) {
    console.error(`[base-scanner] Buy failed ${token.symbol}: ${result.error}`);
    return;
  }

  console.info(`[base-scanner] ✅ ${token.symbol} bought ${result.amount_out} tokens tx:${result.tx_hash?.slice(0,12)}`);

  await query(
    `INSERT INTO base_positions
       (contract_address, symbol, wallet, amount_eth, token_amount, entry_price_eth,
        bought_at, dex, fee_tier, tp_index, is_active, trail_high, buy_tx)
     VALUES ($1,$2,$3,$4,$5,$6,NOW(),$7,$8,0,true,$6,$9)`,
    [
      token.contract_address,
      token.symbol,
      WALLET,
      BUY_ETH,
      result.amount_out,
      token.price_eth,
      result.dex,
      result.fee_tier ?? 3000,
      result.tx_hash,
    ]
  );
}

// ─── Startup ──────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.info(`[base-scanner] API listening on port ${PORT}`);
});

startMonitor();

if (AUTO_BUY) {
  console.info(`[base-scanner] Auto-buy ENABLED — ${BUY_ETH} ETH per trade, max ${MAX_POS} positions`);
} else {
  console.info(`[base-scanner] Auto-buy DISABLED — scan only mode`);
}

const SCAN_INTERVAL_MS = Number(process.env.BASE_SCAN_INTERVAL_SEC || '30') * 1000;

async function runLoop(): Promise<void> {
  const tokens = await runScanCycle().catch(() => [] as BaseToken[]);
  await Promise.all(tokens.map(t => handleNewToken(t).catch(console.error)));
}

runLoop().catch(console.error);
setInterval(() => runLoop().catch(console.error), SCAN_INTERVAL_MS);
