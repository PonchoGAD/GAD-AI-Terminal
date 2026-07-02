import axios from 'axios';
import { query } from '@lib/db';
import { discoverTonTokens, checkJettonSafety, buyJetton, getTonBalance, getWalletAddress, TonToken, checkTonSmartMoney, checkTonHolderConcentration } from '@lib/ton';

const TON_REQUIRE_SM = process.env.TON_REQUIRE_SM_SIGNAL === 'true';
const TON_SM_MIN_WEIGHT = Number(process.env.TON_SM_MIN_WEIGHT ?? '2.0');

// ─── Config ────────────────────────────────────────────────────────────────────
const AUTO_BUY       = process.env.TON_AUTO_BUY       === 'true';
// 3.5 TON minimum: STON.fi swap = 0.12-0.18 TON gas; at 0.5 TON that's 30-35% fees.
// 3.5 TON keeps gas overhead <10% of position size.
const BUY_TON        = Number(process.env.TON_BUY_AMOUNT        || '3.5');
const MAX_POSITIONS  = Number(process.env.TON_MAX_POSITIONS      || '3');
const DAILY_MAX_TON  = Number(process.env.TON_DAILY_MAX_TON      || '20');
const SCAN_INTERVAL  = Number(process.env.TON_SCAN_INTERVAL_SEC  || '60') * 1000;

const MIN_LIQ        = Number(process.env.TON_MIN_LIQUIDITY_USD  || '5000');
const MAX_LIQ        = Number(process.env.TON_MAX_LIQUIDITY_USD  || '200000');
const MIN_PC1H       = Number(process.env.TON_MIN_PC1H           || '5');
const MAX_PC1H       = Number(process.env.TON_MAX_PC1H           || '60');
const MIN_PC5M       = Number(process.env.TON_MIN_PC5M           || '1');
const MAX_AGE_SEC    = Number(process.env.TON_MAX_AGE_SEC        || '86400'); // 24h
const MAX_BS_RATIO   = Number(process.env.TON_MAX_BUY_SELL_RATIO  || '3.0');
const MIN_BUYS_H1    = Number(process.env.TON_MIN_BUYS_H1        || '5');
const MIN_SAFE_SCORE = Number(process.env.TON_MIN_SAFE_SCORE     || '40');

const seen = new Set<string>();

// Seen tokens expire after 4h so fresh entries can be reconsidered
setInterval(() => seen.clear(), 4 * 60 * 60 * 1000);

async function getDailySpend(): Promise<number> {
  const r = await query<{ total: string }>(
    `SELECT COALESCE(SUM(amount_ton),0) AS total
     FROM ton_positions
     WHERE bought_at >= NOW() - INTERVAL '24 hours'`,
    []
  );
  return Number(r.rows[0]?.total ?? 0);
}

async function getOpenCount(): Promise<number> {
  const r = await query<{ cnt: string }>(
    `SELECT COUNT(*) AS cnt FROM ton_positions WHERE is_active = true`,
    []
  );
  return Number(r.rows[0]?.cnt ?? 0);
}

function filterToken(t: TonToken): string | null {
  if (!t.jetton_address) return 'no_address';
  if (t.liquidity_usd < MIN_LIQ) return `liq:${t.liquidity_usd.toFixed(0)}<${MIN_LIQ}`;
  if (t.liquidity_usd > MAX_LIQ) return `liq:${t.liquidity_usd.toFixed(0)}>${MAX_LIQ}`;
  if (t.age_sec > MAX_AGE_SEC)   return `age:${Math.floor(t.age_sec/3600)}h>${MAX_AGE_SEC/3600}h`;
  if (t.price_change_1h < MIN_PC1H) return `pc1h:${t.price_change_1h.toFixed(1)}%<${MIN_PC1H}%`;
  if (t.price_change_1h > MAX_PC1H) return `pc1h:${t.price_change_1h.toFixed(1)}%>${MAX_PC1H}% (overheated)`;
  if (t.price_change_5m !== 0 && t.price_change_5m < MIN_PC5M) return `pc5m:${t.price_change_5m.toFixed(1)}%<${MIN_PC5M}%`;
  if (t.price_change_5m > 30)  return `pc5m:${t.price_change_5m.toFixed(1)}% (mayhem)`;
  if (t.buy_sell_ratio > MAX_BS_RATIO) return `bs:${t.buy_sell_ratio.toFixed(2)}x>${MAX_BS_RATIO}x`;
  if (t.txns_h1_buys < MIN_BUYS_H1)   return `buys1h:${t.txns_h1_buys}<${MIN_BUYS_H1}`;
  return null;
}

export async function runTonScanCycle(): Promise<void> {
  const label = '[ton-scan]';
  let discovered = 0, filtered = 0, skipped = { seen: 0, safety: 0, rug: 0, daily: 0, cap: 0 };
  let bought = 0;

  try {
    const tokens = await discoverTonTokens();
    discovered = tokens.length;

    for (const t of tokens) {
      const addr = t.jetton_address;
      if (seen.has(addr)) { skipped.seen++; continue; }

      const reject = filterToken(t);
      if (reject) {
        console.debug(`${label} ✗ ${t.symbol?.padEnd(10)} ${reject}`);
        filtered++;
        seen.add(addr);
        continue;
      }

      seen.add(addr);

      // Holder concentration check — rejects rug-setup wallets (top-5 > 45% supply)
      const holderCheck = await checkTonHolderConcentration(addr).catch(() => ({ ok: true, topHoldersShare: 0 }));
      if (!holderCheck.ok) {
        console.info(`${label} 🚨 SKIP ${t.symbol} ${(holderCheck as any).reason ?? ''} (top5:${holderCheck.topHoldersShare.toFixed(1)}%)`);
        skipped.rug++;
        continue;
      }

      // Smart Money signal check (non-blocking)
      let smWeight = 0;
      try {
        const smResult = await checkTonSmartMoney(addr);
        smWeight = smResult.weight;
      } catch { /* fail open */ }

      if (TON_REQUIRE_SM && smWeight < TON_SM_MIN_WEIGHT) {
        console.debug(`${label} ✗ ${t.symbol} SM weight ${smWeight} < ${TON_SM_MIN_WEIGHT} (TON_REQUIRE_SM_SIGNAL=true)`);
        continue;
      }

      const smTag = smWeight >= TON_SM_MIN_WEIGHT ? ` 🔥SM(w${smWeight})` : '';

      if (!AUTO_BUY) {
        console.info(`${label} 📡 ${t.symbol} liq:$${t.liquidity_usd.toFixed(0)} pc1h:${t.price_change_1h.toFixed(1)}%${smTag} (shadow — TON_AUTO_BUY=false)`);
        // Record shadow trade for statistics — lets us evaluate strategy without real money.
        // UNIT FIX (02.07.26): entry_price is now ALWAYS USD per readable token.
        // Old mixed-unit rows (GT=TON, DS=quote-token) produced +622536% anomalies.
        // price_unit marker lets the monitor reject legacy rows instead of computing garbage.
        try {
          if (t.price_usd > 0) {
            await query(
              `INSERT INTO shadow_trades
                 (chain, strategy, symbol, contract_address, entry_price, entry_mcap_usd, filter_params, tp1_target, stop_pct)
               VALUES ('ton','ton_scan',$1,$2,$3,$4,$5,$6,$7)
               ON CONFLICT DO NOTHING`,
              [
                t.symbol, addr,
                t.price_usd, t.mcap_usd,
                JSON.stringify({ liq: t.liquidity_usd, pc1h: t.price_change_1h, pc5m: t.price_change_5m, age_h: +(t.age_sec/3600).toFixed(1), sm: smWeight, price_unit: 'usd' }),
                35, 10,  // tp1_target=35% (=1.35x), stop_pct=10%
              ]
            );
          } else {
            console.debug(`${label} shadow skip ${t.symbol} — no USD price from source`);
          }
        } catch { /* non-fatal */ }
        continue;
      }

      // Safety check — isSafe blocks blacklisted + unverified tokens (verification='none')
      const safety = await checkJettonSafety(addr);
      if (!safety.isSafe) {
        console.info(`${label} 🚨 SKIP ${t.symbol} unsafe: ${safety.flags.join(',')} score:${safety.safe_score}`);
        skipped.rug++;
        continue;
      }
      if (safety.safe_score < MIN_SAFE_SCORE) {
        console.info(`${label} 🚨 SKIP ${t.symbol} safe_score:${safety.safe_score} flags:${safety.flags.join(',')}`);
        skipped.safety++;
        continue;
      }
      if (safety.mintable && !safety.admin_renounced) {
        console.info(`${label} 🚨 SKIP ${t.symbol} mintable+admin_not_renounced`);
        skipped.rug++;
        continue;
      }

      // Capacity / daily limit
      const [openCnt, dailySpend] = await Promise.all([getOpenCount(), getDailySpend()]);
      if (openCnt >= MAX_POSITIONS) { skipped.cap++; continue; }
      if (dailySpend + BUY_TON > DAILY_MAX_TON) { skipped.daily++; continue; }

      const tonBal = await getTonBalance();
      // GAS_RESERVE = 1.0 TON wallet floor: covers 2 sell TXs (2 × 0.15 TON) + buffer
      const TON_GAS_RESERVE = Number(process.env.TON_GAS_RESERVE || '1.0');
      if (tonBal < BUY_TON + TON_GAS_RESERVE) {
        console.warn(`${label} ⚠️ Low TON balance: ${tonBal.toFixed(3)} TON (need ${(BUY_TON + TON_GAS_RESERVE).toFixed(1)})`);
        continue;
      }

      const walletAddr = await getWalletAddress();
      console.info(`${label} 🟢 BUYING ${t.symbol} liq:$${t.liquidity_usd.toFixed(0)} pc1h:${t.price_change_1h.toFixed(1)}% safe:${safety.safe_score}${smTag}`);

      const result = await buyJetton(addr, BUY_TON);
      if (!result.ok) {
        console.error(`${label} ❌ BUY FAILED ${t.symbol}: ${result.error}`);
        continue;
      }

      // Record position in DB
      await query(
        `INSERT INTO ton_positions
         (jetton_address, pool_address, symbol, name, wallet, amount_ton,
          token_amount, entry_price_ton, entry_mcap_usd, dex, buy_tx,
          safe_score, liq_at_entry, pc1h_at_entry)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          addr, t.pool_address, t.symbol, t.name,
          walletAddr, BUY_TON,
          result.jetton_amount ?? '0',
          t.price_ton, t.mcap_usd,
          t.dex, result.tx_id,
          safety.safe_score,
          t.liquidity_usd, t.price_change_1h,
        ]
      );

      console.info(`${label} ✅ POSITION OPENED ${t.symbol} tx:${result.tx_id} jettons:${result.amount_out}`);
      bought++;
    }

    console.info(`${label} cycle done — found:${discovered} filtered:${filtered} bought:${bought} skip(seen:${skipped.seen} safety:${skipped.safety} rug:${skipped.rug} daily:${skipped.daily} cap:${skipped.cap})`);
  } catch (e: any) {
    console.error(`${label} cycle error:`, e.message);
  }
}

// ─── Shadow Trade Monitor ─────────────────────────────────────────────────────
// TON shadow trades are INSERTED during scan but never CLOSED — bug fix.
// DexScreener chainId for TON = 'ton'; priceNative = price in TON per token.
async function monitorTonShadowTrades(): Promise<void> {
  try {
    const { rows: openTrades } = await query<{
      id: number; symbol: string; contract_address: string;
      entry_price: number; tp1_target: number; stop_pct: number; created_at: string;
      filter_params: any;
    }>(
      `SELECT id, symbol, contract_address, entry_price, tp1_target, stop_pct, created_at, filter_params
       FROM shadow_trades
       WHERE strategy = 'ton_scan' AND status = 'open'`
    );
    if (!openTrades.length) return;

    for (const trade of openTrades) {
      try {
        // UNIT GUARD (02.07.26): only rows marked price_unit='usd' have a trustworthy
        // entry price. Legacy rows mixed TON/quote-token units → close as 'invalid'
        // so they stop polluting win-rate statistics.
        const fp = typeof trade.filter_params === 'string'
          ? JSON.parse(trade.filter_params || '{}')
          : (trade.filter_params ?? {});
        if (fp.price_unit !== 'usd') {
          await query(`UPDATE shadow_trades SET status='invalid', outcome_pct=NULL WHERE id=$1`, [trade.id]);
          console.info(`[ton-shadow] INVALID ${trade.symbol} — legacy mixed-unit entry price, excluded from stats`);
          continue;
        }

        const ageHours = (Date.now() - new Date(trade.created_at).getTime()) / 3_600_000;

        // Time limit: 24h — close with last known price
        if (ageHours >= 24) {
          await query(
            `UPDATE shadow_trades SET status='stopped', outcome_pct=0 WHERE id=$1`,
            [trade.id]
          );
          console.info(`[ton-shadow] TIME_LIMIT ${trade.symbol} (24h)`);
          continue;
        }

        // Fetch current TON price via DexScreener
        const r = await axios.get(
          `https://api.dexscreener.com/latest/dex/tokens/${trade.contract_address}`,
          { timeout: 5_000 }
        );
        const tonPairs: any[] = (r.data?.pairs ?? []).filter((p: any) => p.chainId === 'ton');
        if (!tonPairs.length) continue;

        const bestPair = tonPairs.sort((a: any, b: any) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
        // priceUsd — same unit as entry_price (USD per readable token). Never priceNative:
        // it's denominated in the pair's QUOTE token and caused the +622536% anomalies.
        const currentPrice = Number(bestPair.priceUsd ?? 0);
        if (!currentPrice || !trade.entry_price) continue;

        const mult = currentPrice / trade.entry_price;
        // Anomaly guard: >20x in <24h on TON = data error, not a real trade we'd catch.
        // Real winners exit at TP1 (1.35x) anyway — a 20x cap can't hide legitimate wins.
        if (mult > 20 || mult <= 0) {
          await query(`UPDATE shadow_trades SET status='invalid', outcome_pct=NULL WHERE id=$1`, [trade.id]);
          console.warn(`[ton-shadow] INVALID ${trade.symbol} — mult ${mult.toFixed(1)}x is a data anomaly`);
          continue;
        }
        const outcomePct = (mult - 1) * 100;
        const tpMult  = 1 + (trade.tp1_target  / 100);  // e.g. tp1_target=35 → 1.35x
        const slMult  = 1 - (trade.stop_pct    / 100);  // e.g. stop_pct=10  → 0.90x

        if (mult >= tpMult) {
          await query(
            `UPDATE shadow_trades SET status='tp1_hit', outcome_price=$1, outcome_pct=$2 WHERE id=$3`,
            [currentPrice, outcomePct, trade.id]
          );
          console.info(`[ton-shadow] TP1 ${trade.symbol} +${outcomePct.toFixed(1)}% (${mult.toFixed(3)}x)`);
        } else if (mult <= slMult) {
          await query(
            `UPDATE shadow_trades SET status='stopped', outcome_pct=$1 WHERE id=$2`,
            [outcomePct, trade.id]
          );
          console.info(`[ton-shadow] SL ${trade.symbol} ${outcomePct.toFixed(1)}% (${mult.toFixed(3)}x)`);
        }
      } catch { /* fail-open per trade — skip and retry next cycle */ }
    }
  } catch (e: any) {
    console.debug(`[ton-shadow] monitor error: ${e.message?.slice(0, 60)}`);
  }
}

export function startTonScanner(): void {
  console.info(`[ton-scan] starting — AUTO_BUY:${AUTO_BUY} BUY:${BUY_TON}TON interval:${SCAN_INTERVAL/1000}s min_liq:$${MIN_LIQ} min_pc1h:${MIN_PC1H}%`);
  runTonScanCycle();
  setInterval(runTonScanCycle, SCAN_INTERVAL);
  // Monitor shadow trades every 5 min — close TP/SL/TIME_LIMIT positions
  setTimeout(() => {
    monitorTonShadowTrades();
    setInterval(monitorTonShadowTrades, 5 * 60 * 1000);
  }, 30_000); // 30s delay on startup
}
