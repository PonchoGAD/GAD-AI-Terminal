import express from 'express';
import { query } from '@lib/db';
import { getBnbBalance, buyBscToken, getBscStatus, checkBscTokenSafety } from '@lib/bsc';
import { runBscScanCycle, loadBscRecentBuys, BscToken } from './scanner';
import { startBscMonitor, getBscPositionSummary } from './monitor';

const PORT     = Number(process.env.PORT          || '4006');
const BUY_BNB  = Number(process.env.BSC_BUY_BNB  || '0.03');
const MAX_POS  = Number(process.env.BSC_MAX_POSITIONS || '3');
const AUTO_BUY = process.env.BSC_AUTO_BUY !== 'false';
const WALLET   = process.env.BSC_WALLET_PUBLIC_KEY ?? 'unknown';

const app = express();
app.use(express.json());

// ─── Health ───────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ ok: true, service: 'bsc-scanner' }));

// ─── Status ───────────────────────────────────────────────────────────────────
app.get('/bsc/status', async (_req, res) => {
  try {
    const [summary, bscStatus] = await Promise.all([
      getBscPositionSummary(),
      getBscStatus().catch(() => null),
    ]);
    res.json({ ok: true, data: { ...summary, ...bscStatus, auto_buy: AUTO_BUY, wallet: WALLET } });
  } catch (e: any) { res.json({ ok: false, error: e.message }); }
});

// ─── Open positions ───────────────────────────────────────────────────────────
app.get('/bsc/positions', async (req, res) => {
  try {
    const limit  = Math.min(Number(req.query.limit  ?? 20), 50);
    const offset = Number(req.query.offset ?? 0);
    const r = await query(
      `SELECT id, contract_address, symbol, amount_bnb, entry_price_bnb,
              bought_at, tp_index, buy_tax, sell_tax, total_sold_bnb, sell_reason
       FROM bsc_positions WHERE is_active=true
       ORDER BY bought_at DESC LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    res.json({ ok: true, data: r.rows });
  } catch (e: any) { res.json({ ok: false, error: e.message }); }
});

// ─── Recent closed trades ─────────────────────────────────────────────────────
app.get('/bsc/trades', async (req, res) => {
  try {
    const limit  = Math.min(Number(req.query.limit ?? 10), 50);
    const offset = Number(req.query.offset ?? 0);
    const r = await query(
      `SELECT id, contract_address, symbol, amount_bnb, total_sold_bnb,
              bought_at, sold_at, sell_reason, sell_tx, buy_tax, sell_tax
       FROM bsc_positions WHERE sold_at IS NOT NULL
       ORDER BY sold_at DESC LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    res.json({ ok: true, data: r.rows });
  } catch (e: any) { res.json({ ok: false, error: e.message }); }
});

// ─── Discovered tokens list ───────────────────────────────────────────────────
app.get('/bsc/tokens', async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit ?? 20), 50);
    const r = await query(
      `SELECT contract_address, symbol, name, liquidity_usd, volume_1h,
              price_change_1h, is_honeypot, buy_tax, sell_tax, safe_score,
              top_holder_pct, source, last_seen
       FROM bsc_tokens ORDER BY last_seen DESC LIMIT $1`,
      [limit]
    );
    res.json({ ok: true, data: r.rows });
  } catch (e: any) { res.json({ ok: false, error: e.message }); }
});

// ─── Daily stats ──────────────────────────────────────────────────────────────
app.get('/bsc/stats', async (req, res) => {
  try {
    const days = Math.min(Number(req.query.days ?? 7), 30);
    const r = await query(
      `SELECT date, trades, wins, bnb_in, bnb_out, pnl_bnb
       FROM bsc_stats ORDER BY date DESC LIMIT $1`,
      [days]
    );
    res.json({ ok: true, data: r.rows });
  } catch (e: any) { res.json({ ok: false, error: e.message }); }
});

// ─── Safety check ─────────────────────────────────────────────────────────────
app.get('/bsc/safety/:address', async (req, res) => {
  try {
    const result = await checkBscTokenSafety(req.params.address);
    res.json({ ok: true, data: result });
  } catch (e: any) { res.json({ ok: false, error: e.message }); }
});

// ─── Manual buy ───────────────────────────────────────────────────────────────
app.post('/bsc/buy', async (req, res) => {
  const { contract_address, bnb_amount } = req.body ?? {};
  if (!contract_address) return res.status(400).json({ ok: false, error: 'contract_address required' });
  try {
    const safety = await checkBscTokenSafety(contract_address);
    if (safety.is_honeypot) return res.json({ ok: false, error: `HONEYPOT — ${safety.flags.join(', ')}` });
    const result = await buyBscToken(contract_address, bnb_amount ?? BUY_BNB);
    res.json({ ok: result.ok, data: result });
  } catch (e: any) { res.json({ ok: false, error: e.message }); }
});

// ─── Buy failure cooldown ────────────────────────────────────────────────────
const buyFailBlacklist = new Map<string, number>();
const BUY_FAIL_COOLDOWN = 2 * 60 * 60 * 1000;

// ─── Auto-buy hook ───────────────────────────────────────────────────────────
async function handleNewBscToken(token: BscToken): Promise<void> {
  if (!AUTO_BUY) return;
  if (buyFailBlacklist.get(token.contract_address) ?? 0 > Date.now()) return;

  // ПРОМТ-4: Check for existing active position (prevents duplicate buys like ELITE)
  const existing = await query(
    'SELECT id FROM bsc_positions WHERE contract_address = $1 AND is_active = true',
    [token.contract_address]
  );
  if (existing.rows.length > 0) {
    console.info(`[bsc-scanner] ⏭️ Skip ${token.symbol} — already have active position`);
    return;
  }

  const openCount = await query(
    `SELECT COUNT(*) as cnt FROM bsc_positions WHERE sold_at IS NULL AND is_active=true`
  );
  if (Number(openCount.rows[0]?.cnt ?? 0) >= MAX_POS) {
    console.info(`[bsc-scanner] Max positions (${MAX_POS}) reached — skipping ${token.symbol}`);
    return;
  }

  const bnbBal = await getBnbBalance().catch(() => 0);
  if (bnbBal < BUY_BNB * 1.05) {
    console.warn(`[bsc-scanner] Insufficient BNB: ${bnbBal.toFixed(4)} (need ${BUY_BNB})`);
    return;
  }

  const maxDaily = Number(process.env.BSC_DAILY_MAX_BNB || '0.5');
  const dailyUsed = await query(
    `SELECT COALESCE(SUM(bnb_in),0) as used FROM bsc_stats WHERE date=CURRENT_DATE AND wallet=$1`,
    [WALLET]
  );
  if (Number(dailyUsed.rows[0]?.used ?? 0) + BUY_BNB > maxDaily) {
    console.info(`[bsc-scanner] Daily BNB limit reached`);
    return;
  }

  console.info(
    `[bsc-scanner] 🛒 Buying ${token.symbol} ${BUY_BNB} BNB | ` +
    `liq:$${token.liquidity_usd.toFixed(0)} score:${token.safe_score} ` +
    `tax:${token.buy_tax.toFixed(1)}/${token.sell_tax.toFixed(1)}% [${token.source}]`
  );

  const result = await buyBscToken(token.contract_address, BUY_BNB, 5 + token.buy_tax);
  if (!result.ok) {
    buyFailBlacklist.set(token.contract_address, Date.now() + BUY_FAIL_COOLDOWN);
    console.error(`[bsc-scanner] ❌ Buy FAILED ${token.symbol}: ${result.error} — blacklisted 2h`);
    return;
  }

  console.info(`[bsc-scanner] ✅ ${token.symbol} bought tx:${result.tx_hash?.slice(0, 12)}`);

  // Record position in DB
  const tokenBalance = BigInt(result.amount_out || '0');
  await query(
    `INSERT INTO bsc_positions
       (contract_address, symbol, wallet, amount_bnb, token_amount, entry_price_bnb,
        dex, buy_tx, buy_tax, sell_tax, is_active, last_activity_at)
     VALUES ($1,$2,$3,$4,$5,$6,'pancakeswap_v2',$7,$8,$9,true,NOW())`,
    [
      token.contract_address, token.symbol, WALLET,
      BUY_BNB, tokenBalance.toString(), token.price_bnb,
      result.tx_hash, token.buy_tax, token.sell_tax,
    ]
  ).catch(e => console.error(`[bsc-scanner] DB insert failed: ${e.message}`));
}

// ─── Startup ──────────────────────────────────────────────────────────────────
app.listen(PORT, () => console.info(`[bsc-scanner] API on port ${PORT}`));
startBscMonitor();

if (AUTO_BUY) {
  console.info(`[bsc-scanner] Auto-buy ENABLED — ${BUY_BNB} BNB per trade, max ${MAX_POS} positions`);
} else {
  console.info(`[bsc-scanner] Auto-buy DISABLED (BSC_AUTO_BUY=false) — scan only`);
}

// Log wallet balance on startup
getBnbBalance()
  .then(bal => {
    console.info(`[bsc-scanner] 💰 Wallet ${WALLET} — Balance: ${bal.toFixed(4)} BNB`);
    if (AUTO_BUY && bal < BUY_BNB * 1.1) {
      console.warn(`[bsc-scanner] ⚠️  Insufficient BNB! Need ${(BUY_BNB * 1.1).toFixed(4)} BNB for trading. Auto-buy will be skipped until funded.`);
    }
  })
  .catch(e => console.warn(`[bsc-scanner] Could not check BNB balance: ${e.message}`));

const SCAN_INTERVAL = Number(process.env.BSC_SCAN_INTERVAL_SEC || '30') * 1000;

async function runLoop(): Promise<void> {
  const tokens = await runBscScanCycle().catch(() => [] as BscToken[]);
  await Promise.all(tokens.map(t => handleNewBscToken(t).catch(console.error)));
}

// Load recently bought tokens into cooldown set before first scan
loadBscRecentBuys().catch(() => {}).then(() => {
  runLoop().catch(console.error);
  setInterval(() => runLoop().catch(console.error), SCAN_INTERVAL);
});
