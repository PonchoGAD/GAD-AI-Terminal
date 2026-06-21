import { query } from '@lib/db';
import { discoverTonTokens, checkJettonSafety, buyJetton, getTonBalance, getWalletAddress, TonToken, checkTonSmartMoney } from '@lib/ton';

const TON_REQUIRE_SM = process.env.TON_REQUIRE_SM_SIGNAL === 'true';
const TON_SM_MIN_WEIGHT = Number(process.env.TON_SM_MIN_WEIGHT ?? '2.0');

// ─── Config ────────────────────────────────────────────────────────────────────
const AUTO_BUY       = process.env.TON_AUTO_BUY       === 'true';
const BUY_TON        = Number(process.env.TON_BUY_AMOUNT        || '2');
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
        console.info(`${label} 📡 ${t.symbol} liq:$${t.liquidity_usd.toFixed(0)} pc1h:${t.price_change_1h.toFixed(1)}%${smTag} (dry-run — TON_AUTO_BUY=false)`);
        continue;
      }

      // Safety check
      const safety = await checkJettonSafety(addr);
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
      if (tonBal < BUY_TON + 0.5) {
        console.warn(`${label} ⚠️ Low TON balance: ${tonBal.toFixed(3)} TON`);
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

export function startTonScanner(): void {
  console.info(`[ton-scan] starting — AUTO_BUY:${AUTO_BUY} BUY:${BUY_TON}TON interval:${SCAN_INTERVAL/1000}s min_liq:$${MIN_LIQ} min_pc1h:${MIN_PC1H}%`);
  runTonScanCycle();
  setInterval(runTonScanCycle, SCAN_INTERVAL);
}
