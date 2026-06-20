import express from 'express';
import axios from 'axios';
import { query } from '@lib/db';
import { fetchActiveMarkets, syncMarketsToDb, getMarketsFromDb } from './markets';
import { processNewsSignal, processGdeltSignal } from './scorer';
import { openPosition } from './trader';
import { startMonitor } from './monitor';

const PORT         = Number(process.env.PORT                   || '4009');
const DRY_RUN      = process.env.POLYMARKET_DRY_RUN            !== 'false';
const SYNC_MIN     = Number(process.env.POLYMARKET_SYNC_MIN    || '15');
const CHECK_MIN    = Number(process.env.POLYMARKET_CHECK_MIN   || '2');
const MAX_OPEN     = Number(process.env.POLYMARKET_MAX_OPEN    || '3');
const MIN_VOLUME   = Number(process.env.POLYMARKET_MIN_VOLUME  || '50000');
const TG_TOKEN     = process.env.TELEGRAM_BOT_TOKEN            ?? '';
const ADMIN_CHAT   = process.env.ADMIN_CHAT_ID                 ?? '';
const ENABLED      = process.env.POLYMARKET_ENABLED            !== 'false';

// How many dry-run trades done so far (check before going live)
const DRY_RUN_TARGET = Number(process.env.POLYMARKET_DRY_TARGET || '30');

async function tg(text: string): Promise<void> {
  if (!TG_TOKEN || !ADMIN_CHAT) return;
  await axios.post(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`,
    { chat_id: ADMIN_CHAT, text, parse_mode: 'Markdown' },
    { timeout: 6000 }
  ).catch(() => {});
}

// ─── Market sync ─────────────────────────────────────────────────────────────

async function syncMarkets(): Promise<void> {
  console.info('[poly] Syncing active markets from Polymarket...');
  const markets = await fetchActiveMarkets(MIN_VOLUME);
  if (markets.length) {
    await syncMarketsToDb(markets);
    console.info(`[poly] Synced ${markets.length} markets (vol ≥ $${MIN_VOLUME.toLocaleString()})`);
  } else {
    console.warn('[poly] fetchActiveMarkets returned 0 — Gamma API may be down');
  }
}

// ─── Strategy 1: X/Twitter trend signals (x_trend_signals table) ─────────────

async function processXTrendSignals(): Promise<void> {
  const { rows } = await query<{ id: string; theme: string; keywords: string; engagement: number }>(
    `SELECT s.id::text AS id, s.theme, s.keywords, s.engagement
     FROM x_trend_signals s
     WHERE s.created_at > NOW() - INTERVAL '90 minutes'
       AND s.engagement >= 5000
       AND NOT EXISTS (
         SELECT 1 FROM polymarket_signals ps WHERE ps.source_signal_id = s.id::text
       )
     ORDER BY s.engagement DESC LIMIT 5`
  );

  for (const signal of rows) {
    const newsText = [signal.theme, signal.keywords].filter(Boolean).join(' | ').slice(0, 400);
    console.info(`[poly-signal] X trend: "${newsText.slice(0, 80)}..." (eng:${signal.engagement})`);

    const scored = await processNewsSignal(newsText, 'x_trends', signal.id).catch(e => {
      console.error('[poly-signal] Scoring error:', e.message);
      return null;
    });

    if (scored) {
      await tryOpenPosition(scored);
    }
  }
}

// ─── Strategy 2: GDELT / trend_clusters (second signal source) ───────────────

async function processGdeltSignals(): Promise<void> {
  const { rows } = await query<{ id: string; main_title: string; summary: string }>(
    `SELECT id::text AS id, main_title, summary
     FROM trend_clusters
     WHERE created_at > NOW() - INTERVAL '60 minutes'
       AND NOT EXISTS (
         SELECT 1 FROM polymarket_signals ps
         WHERE ps.source_signal_id = id::text
           AND ps.created_at > NOW() - INTERVAL '60 minutes'
       )
     ORDER BY created_at DESC LIMIT 3`
  );

  for (const row of rows) {
    const newsText = `${row.main_title}: ${row.summary}`.slice(0, 400);
    const scored = await processGdeltSignal(newsText).catch(() => null);
    if (scored) await tryOpenPosition(scored);
  }
}

// ─── Strategy 3: Volume spike detection ──────────────────────────────────────
// Markets where trading volume spiked recently (updated from Gamma API)
// may have new information not yet fully reflected in price

async function processVolumeSpikes(): Promise<void> {
  // We compare current DB prices to freshly fetched prices
  const fresh = await fetchActiveMarkets(MIN_VOLUME * 2).catch(() => [] as any[]);
  const { rows: cached } = await query<{ market_id: string; price_yes: string; volume_usd: string }>(
    `SELECT market_id, price_yes::float AS price_yes, volume_usd::float AS volume_usd
     FROM polymarket_markets WHERE is_active=true`
  );

  for (const f of fresh) {
    const c = cached.find(r => r.market_id === f.id);
    if (!c) continue;

    // Detect: volume increased by ≥50% since last sync AND price barely moved (<3%)
    const volRatio = f.volumeUsd / Number(c.volume_usd || 1);
    const priceChg = Math.abs(f.priceYes - Number(c.price_yes));
    if (volRatio < 1.5 || priceChg > 0.03) continue;

    // Sudden volume but stable price → information asymmetry opportunity
    const newsText = `Volume spike detected on Polymarket: "${f.title}" — ` +
      `volume +${((volRatio-1)*100).toFixed(0)}% but YES price unchanged at ${(f.priceYes*100).toFixed(0)}%`;
    console.info(`[poly-vol-spike] ${newsText.slice(0, 100)}`);

    const scored = await processNewsSignal(newsText, 'volume_spike').catch(() => null);
    if (scored) await tryOpenPosition(scored);
  }
}

// ─── Common: open position with guards ───────────────────────────────────────

async function tryOpenPosition(scored: Awaited<ReturnType<typeof processNewsSignal>>) {
  if (!scored) return;

  // Guard: max open positions
  const { rows: open } = await query<{ cnt: string }>(
    `SELECT COUNT(*) AS cnt FROM polymarket_positions WHERE is_active=true`
  );
  if (Number(open[0]?.cnt ?? 0) >= MAX_OPEN) {
    console.info(`[poly] Max positions (${MAX_OPEN}) reached — skipping`);
    return;
  }

  // Guard: don't trade the same market twice (one position per market)
  const { rows: dup } = await query(
    `SELECT 1 FROM polymarket_positions WHERE market_id=$1 AND is_active=true LIMIT 1`,
    [scored.marketId]
  );
  if (dup.length) {
    console.info(`[poly] Already have position on market ${scored.marketId.slice(0, 12)} — skipping`);
    return;
  }

  // Get the signal_id for the last inserted signal
  const { rows: sig } = await query<{ id: number }>(
    `SELECT id FROM polymarket_signals WHERE market_id=$1 ORDER BY created_at DESC LIMIT 1`,
    [scored.marketId]
  );
  const signalId = sig[0]?.id ?? null;

  await openPosition(scored, signalId);

  await tg(
    `🔮 *Polymarket Signal* [${DRY_RUN ? 'DRY-RUN' : '🔴 LIVE'}]\n` +
    `📊 ${scored.marketTitle.slice(0, 60)}\n` +
    `📍 Outcome: *${scored.outcome}* @ $${scored.entryPrice.toFixed(3)}\n` +
    `🤖 AI Prob: ${(scored.aiProbability * 100).toFixed(0)}% | EV: +${(scored.evScore * 100).toFixed(0)}%\n` +
    `🎯 Confidence: ${scored.confidence}\n` +
    `💡 ${scored.reasoning.slice(0, 120)}`
  );
}

// ─── Dry-run progress check ───────────────────────────────────────────────────

async function checkDryRunProgress(): Promise<void> {
  if (!DRY_RUN) return;
  const { rows } = await query<{ trades: string; wins: string; pnl_usdc: string }>(
    `SELECT SUM(trades)::text AS trades, SUM(wins)::text AS wins, SUM(pnl_usdc)::text AS pnl_usdc
     FROM polymarket_stats WHERE is_dry_run=true`
  );
  const trades = Number(rows[0]?.trades ?? 0);
  const wins   = Number(rows[0]?.wins ?? 0);
  const pnl    = Number(rows[0]?.pnl_usdc ?? 0);
  const wr     = trades > 0 ? (wins / trades * 100).toFixed(0) : '0';

  if (trades > 0 && trades % 5 === 0) {
    console.info(`[poly] Dry-run progress: ${trades}/${DRY_RUN_TARGET} trades | WR:${wr}% | PnL:${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`);
    if (trades >= DRY_RUN_TARGET) {
      const msg =
        `🎓 *Polymarket Dry-Run Complete!*\n` +
        `📊 ${trades} trades | WR: ${wr}% | PnL: $${pnl.toFixed(2)}\n` +
        (Number(wr) >= 65
          ? `✅ *WR ≥65% — ready for LIVE mode!*\nSet POLYMARKET_DRY_RUN=false in .env`
          : `❌ WR < 65% — continue dry-run or tune strategy`);
      await tg(msg);
    }
  }
}

// ─── Express API ─────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

app.get('/health', (_, res) => res.json({
  status: 'ok', mode: DRY_RUN ? 'dry-run' : 'live', enabled: ENABLED,
}));

app.get('/positions', async (_, res) => {
  const { rows } = await query(
    `SELECT p.id, p.outcome, p.amount_usdc, p.shares, p.entry_price,
            p.is_dry_run, p.is_active, p.close_price, p.pnl_usdc, p.close_reason,
            p.created_at, p.closed_at, m.title AS market_title
     FROM polymarket_positions p
     LEFT JOIN polymarket_markets m ON m.market_id = p.market_id
     ORDER BY p.created_at DESC LIMIT 50`
  );
  res.json(rows);
});

app.get('/stats', async (_, res) => {
  const { rows } = await query(
    `SELECT date, is_dry_run, trades, wins,
            ROUND(100.0*wins/NULLIF(trades,0),1) AS win_rate,
            ROUND(pnl_usdc::numeric,3) AS pnl_usdc
     FROM polymarket_stats ORDER BY date DESC LIMIT 30`
  );
  res.json(rows);
});

app.get('/markets', async (req, res) => {
  const { rows } = await query(
    `SELECT market_id, title, category,
            ROUND(volume_usd::numeric,0) AS volume_usd,
            ROUND(price_yes::numeric,3) AS price_yes,
            ROUND(price_no::numeric,3) AS price_no,
            ends_at
     FROM polymarket_markets WHERE is_active=true AND ends_at > NOW()
     ORDER BY volume_usd DESC LIMIT 50`
  );
  res.json(rows);
});

app.get('/signals', async (_, res) => {
  const { rows } = await query(
    `SELECT s.id, s.outcome, s.entry_price, s.ai_probability, s.ev_score,
            s.confidence, s.reasoning, s.news_source, s.created_at, m.title
     FROM polymarket_signals s
     LEFT JOIN polymarket_markets m ON m.market_id = s.market_id
     ORDER BY s.created_at DESC LIMIT 30`
  );
  res.json(rows);
});

// ─── Startup ─────────────────────────────────────────────────────────────────

async function start(): Promise<void> {
  app.listen(PORT, () => {
    console.info(`[poly] Polymarket bot — port:${PORT} | mode:${DRY_RUN ? 'DRY-RUN' : '🔴LIVE'} | enabled:${ENABLED}`);
  });

  if (!ENABLED) {
    console.info('[poly] POLYMARKET_ENABLED=false — scheduler not started');
    return;
  }

  // Initial sync
  await syncMarkets().catch(e => console.error('[poly] Initial sync error:', e.message));

  // Market sync every N minutes
  setInterval(() => syncMarkets().catch(console.error), SYNC_MIN * 60 * 1000);

  // Signal checks every 2 minutes
  setInterval(async () => {
    await processXTrendSignals().catch(e => console.error('[poly] X signal error:', e.message));
    await processGdeltSignals().catch(e => console.error('[poly] GDELT signal error:', e.message));
    await checkDryRunProgress().catch(console.error);
  }, CHECK_MIN * 60 * 1000);

  // Volume spike check every 30 minutes
  setInterval(() => processVolumeSpikes().catch(console.error), 30 * 60 * 1000);

  // Start position monitor
  startMonitor();

  // First signal check after 60s (markets need to sync first)
  setTimeout(async () => {
    await processXTrendSignals().catch(console.error);
  }, 60 * 1000);

  console.info('[poly] Scheduler started');
}

start().catch(e => {
  console.error('[poly] Fatal startup error:', e.message);
  process.exit(1);
});
