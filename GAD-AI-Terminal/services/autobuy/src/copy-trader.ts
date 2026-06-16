/**
 * Copy-Trader: mirrors buys from curated profitable wallets via Helius.
 *
 * Flow:
 *   1. Poll Helius every POLL_MS for new SWAP txs on tracked wallets
 *   2. Detect token buys (SOL → token on Raydium/Orca/Meteora/PumpSwap)
 *   3. Execute same buy via Jupiter with COPY_SOL amount
 *   4. Insert into autobuy_jobs so the existing scheduler handles TP/stop-loss/time-limit
 *
 * Wallets are managed via copy_wallets table:
 *   INSERT INTO copy_wallets (address, label) VALUES ('...', 'my_whale');
 * Telegram: /wallets, /addwallet <addr> <label>, /rmwallet <addr>
 */

import axios from 'axios';
import { query } from '@lib/db';
import { executeAutoBuy, getKeypairFromEnv, getConnection } from '@lib/autobuy';
import { Keypair, Connection } from '@solana/web3.js';

// ─── Config ──────────────────────────────────────────────────────────────────
const HELIUS_KEY     = process.env.HELIUS_API_KEY ?? '';
const COPY_ENABLED   = process.env.COPY_TRADE_ENABLED !== 'false';
const COPY_SOL       = Number(process.env.COPY_TRADE_SOL         || '0.03');
const MAX_COPY_POS   = Number(process.env.COPY_MAX_POSITIONS      || '5');
const MIN_COPY_LIQ   = Number(process.env.COPY_MIN_LIQ_USD        || '20000'); // min $20k liq — avoid illiquid tokens
const DAILY_MAX_SOL  = Number(process.env.COPY_DAILY_MAX_SOL      || '0.3');
const POLL_MS        = Number(process.env.COPY_POLL_SEC            || '5') * 1000;
const MIN_COPY_SOL   = Number(process.env.COPY_MIN_WALLET_SOL     || '0.05');  // skip tiny buys from tracked wallet

// Only copy trades on Jupiter-routable DEXes — avoid bonding curves
const COPY_DEX_WHITELIST = new Set(['raydium', 'orca', 'meteora', 'lifinity', 'pumpswap']);

// ─── State ───────────────────────────────────────────────────────────────────
const lastSig   = new Map<string, string>(); // wallet → last processed signature
const copyLock  = new Set<string>();         // mint → buy in progress (prevent duplicate buys)

// ─── Wallet management ───────────────────────────────────────────────────────
interface CopyWallet {
  id: string;
  address: string;
  label: string;
}

export async function getCopyWallets(): Promise<CopyWallet[]> {
  try {
    const r = await query<CopyWallet>(
      `SELECT id, address, label FROM copy_wallets WHERE enabled = true ORDER BY added_at`
    );
    return r.rows;
  } catch { return []; }
}

export async function addCopyWallet(address: string, label: string): Promise<void> {
  await query(
    `INSERT INTO copy_wallets (address, label) VALUES ($1, $2)
     ON CONFLICT (address) DO UPDATE SET label=$2, enabled=true, updated_at=NOW()`,
    [address, label]
  );
}

export async function removeCopyWallet(address: string): Promise<void> {
  await query(
    `UPDATE copy_wallets SET enabled=false, updated_at=NOW() WHERE address=$1`,
    [address]
  );
}

// ─── Helius transaction fetch ─────────────────────────────────────────────────
async function fetchNewSwaps(address: string): Promise<any[]> {
  if (!HELIUS_KEY) return [];
  try {
    const r = await axios.get(
      `https://api.helius.xyz/v0/addresses/${address}/transactions` +
      `?api-key=${HELIUS_KEY}&limit=10&type=SWAP`,
      { timeout: 8_000 }
    );
    const txs: any[] = Array.isArray(r.data) ? r.data : [];

    const last = lastSig.get(address);
    if (!last) {
      // Baseline: mark current state, don't copy old trades
      if (txs.length > 0) lastSig.set(address, txs[0].signature);
      return [];
    }

    const newTxs: any[] = [];
    for (const tx of txs) {
      if (tx.signature === last) break;
      newTxs.push(tx);
    }
    if (newTxs.length > 0) lastSig.set(address, txs[0].signature);
    return newTxs;
  } catch (e: any) {
    if (!e.message?.includes('429')) {
      console.debug(`[copy-trader] Helius ${address.slice(0,8)}: ${e.message?.slice(0, 60)}`);
    }
    return [];
  }
}

// ─── Buy detection ────────────────────────────────────────────────────────────
// Returns {mint, solSpent} if this transaction is a token buy by walletAddress
function detectBuy(tx: any, walletAddress: string): { mint: string; solSpent: number } | null {
  const walletLower = walletAddress.toLowerCase();
  const swap = tx.events?.swap;

  // Primary: events.swap (most reliable — Helius enhanced parse)
  if (swap) {
    const nativeIn  = swap.nativeInput;
    const tokensOut = (swap.tokenOutputs ?? []) as any[];
    if (
      nativeIn &&
      String(nativeIn.account).toLowerCase() === walletLower &&
      tokensOut.length > 0
    ) {
      const out = tokensOut.find((t: any) =>
        String(t.userAccount).toLowerCase() === walletLower &&
        t.mint !== 'So11111111111111111111111111111111111111112'
      );
      if (out) return { mint: out.mint, solSpent: Number(nativeIn.amount) / 1e9 };
    }
  }

  // Fallback: raw nativeTransfers + tokenTransfers
  const nativeTxfrs: any[] = tx.nativeTransfers ?? [];
  const tokenTxfrs: any[]  = tx.tokenTransfers  ?? [];

  const solSent = nativeTxfrs
    .filter((t: any) => String(t.fromUserAccount).toLowerCase() === walletLower)
    .reduce((s: number, t: any) => s + Number(t.amount ?? 0), 0) / 1e9;

  if (solSent < 0.005) return null;

  const received = tokenTxfrs.find((t: any) =>
    String(t.toUserAccount).toLowerCase() === walletLower &&
    t.mint !== 'So11111111111111111111111111111111111111112'
  );
  if (!received) return null;

  return { mint: received.mint, solSpent: solSent };
}

// ─── Pre-trade checks ─────────────────────────────────────────────────────────
async function getDailySpent(): Promise<number> {
  const r = await query<{ spent: string }>(
    `SELECT COALESCE(SUM(total_spent_sol), 0) AS spent FROM autobuy_jobs
     WHERE created_at > now() - interval '24 hours' AND label LIKE 'auto:copytrade%'`
  );
  return Number(r.rows[0]?.spent ?? 0);
}

async function getOpenCount(): Promise<number> {
  const r = await query<{ cnt: string }>(
    `SELECT COUNT(*) AS cnt FROM autobuy_jobs
     WHERE active = true AND label LIKE 'auto:copytrade%'`
  );
  return Number(r.rows[0]?.cnt ?? 0);
}

async function recentlyCopied(mint: string): Promise<boolean> {
  const r = await query<{ cnt: string }>(
    `SELECT COUNT(*) AS cnt FROM autobuy_jobs
     WHERE mint_address = $1 AND label LIKE 'auto:copytrade%'
       AND created_at > now() - interval '6 hours'`,
    [mint]
  );
  return Number(r.rows[0]?.cnt ?? 0) > 0;
}

interface TokenInfo { liq: number; dex: string; pc1h: number }

async function getTokenInfo(mint: string): Promise<TokenInfo> {
  try {
    const r = await axios.get(
      `https://api.dexscreener.com/latest/dex/tokens/${mint}`,
      { timeout: 5_000 }
    );
    const pairs: any[] = (r.data?.pairs ?? [])
      .filter((p: any) => p.chainId === 'solana')
      .sort((a: any, b: any) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
    if (!pairs.length) return { liq: 0, dex: '', pc1h: 0 };
    const p = pairs[0];
    return {
      liq:  Number(p.liquidity?.usd ?? 0),
      dex:  p.dexId ?? '',
      pc1h: Number(p.priceChange?.h1 ?? 0),
    };
  } catch { return { liq: 0, dex: '', pc1h: 0 }; }
}

// ─── Execute copy trade ───────────────────────────────────────────────────────
async function executeCopy(
  walletLabel: string,
  walletAddress: string,
  mint: string,
  solSpent: number,
  keypair: Keypair,
  connection: Connection
): Promise<void> {
  if (copyLock.has(mint)) return;

  // Guards
  if (await getOpenCount() >= MAX_COPY_POS) {
    console.debug(`[copy-trader] Max positions (${MAX_COPY_POS}) — skip ${mint.slice(0,8)}`);
    return;
  }
  if (await getDailySpent() + COPY_SOL > DAILY_MAX_SOL) {
    console.info(`[copy-trader] Daily limit ${DAILY_MAX_SOL} SOL reached`);
    return;
  }
  if (await recentlyCopied(mint)) {
    console.debug(`[copy-trader] Already copied ${mint.slice(0,8)} today — skip`);
    return;
  }
  if (solSpent < MIN_COPY_SOL) {
    console.debug(`[copy-trader] ${walletLabel} bought only ${solSpent.toFixed(3)} SOL — too small, skip`);
    return;
  }

  const info = await getTokenInfo(mint);
  if (info.liq < MIN_COPY_LIQ) {
    console.info(
      `[copy-trader] ⚡ ${walletLabel} bought ${mint.slice(0,8)} liq:$${info.liq.toFixed(0)} < $${MIN_COPY_LIQ} — skip`
    );
    return;
  }
  if (!COPY_DEX_WHITELIST.has(info.dex.toLowerCase())) {
    console.info(
      `[copy-trader] ⚡ ${walletLabel} bought ${mint.slice(0,8)} on ${info.dex} — not Jupiter tradeable, skip`
    );
    return;
  }
  if (info.pc1h < -30) {
    console.info(
      `[copy-trader] ⚡ ${mint.slice(0,8)} pc1h:${info.pc1h.toFixed(0)}% — freefall, skip`
    );
    return;
  }

  console.info(
    `[copy-trader] 🔔 ${walletLabel} bought ${mint.slice(0,8)} (${solSpent.toFixed(3)} SOL) ` +
    `— copying ${COPY_SOL} SOL liq:$${info.liq.toFixed(0)} dex:${info.dex}`
  );

  copyLock.add(mint);
  try {
    const result = await executeAutoBuy(
      { mintAddress: mint, amountSol: COPY_SOL, slippageBps: 300 },
      connection,
      keypair
    );

    if (!result.success) {
      console.warn(`[copy-trader] ❌ Copy buy failed ${mint.slice(0,8)}: ${result.error}`);
      return;
    }

    const label       = `auto:copytrade:${walletLabel.slice(0, 12).replace(/\s/g, '_')}:${info.dex}`;
    const tokensBought = result.outputAmountRaw ?? 0n;
    const entryPrice  = result.entryPriceSol ?? 0;

    // Insert as pre-bought position — next_run_at=far future so scheduler never re-buys
    const { rows } = await query<{ id: string }>(
      `INSERT INTO autobuy_jobs
         (mint_address, label, amount_sol, slippage_bps, interval_seconds,
          wallet_address, autosell_enabled, time_limit_seconds, time_limit_enabled,
          last_tx_signature, entry_price_sol, token_amount_bought,
          bought_at, last_activity_at, total_buys, total_spent_sol,
          next_run_at)
       VALUES ($1,$2,$3,300,86400,$4,true,3600,true,$5,$6,$7,now(),now(),1,$3,
               now() + interval '99 years')
       RETURNING id`,
      [
        mint, label, COPY_SOL,
        keypair.publicKey.toBase58(),
        result.txSignature,
        entryPrice,
        tokensBought.toString(),
      ]
    );

    const jobId = rows[0]?.id;
    if (jobId && tokensBought > 0n && entryPrice > 0) {
      // Create TP sell stages: +30% → 90%, +3x → rest
      // Slightly conservative — copied trades may already be mid-move
      const tokens90pct = (tokensBought * 90n) / 100n;
      await query(
        `INSERT INTO autosell_stages
           (autobuy_job_id, wallet_address, mint_address, stage_number,
            trigger_mult, sell_percent, tokens_at_stage, status)
         VALUES
           ($1, $2, $3, 1, 1.30, 90, $4, 'pending'),
           ($1, $2, $3, 2, 3.00, 100, $5, 'pending')
         ON CONFLICT DO NOTHING`,
        [
          jobId,
          keypair.publicKey.toBase58(),
          mint,
          tokensBought.toString(), // stage 1: full balance, sells 90%
          (tokensBought - tokens90pct).toString(), // stage 2: remaining 10%
        ]
      );
    }

    console.info(
      `[copy-trader] ✅ Copied ${walletLabel} → ${mint.slice(0,8)} ` +
      `${COPY_SOL} SOL @ ${entryPrice.toFixed(10)} | tx:${result.txSignature?.slice(0,12)}`
    );

    await query(
      `UPDATE copy_wallets SET total_copies = total_copies + 1, last_copy_at = NOW()
       WHERE address = $1`,
      [walletAddress]
    ).catch(() => {});

  } finally {
    copyLock.delete(mint);
  }
}

// ─── Wallet discovery from Birdeye ───────────────────────────────────────────
export async function discoverTopWallets(): Promise<void> {
  const apiKey = process.env.BIRDEYE_API_KEY;
  if (!apiKey) return;
  try {
    const r = await axios.get(
      'https://public-api.birdeye.so/trader/gainers-losers?type=7d&sort_by=PnL&sort_type=desc&limit=20',
      { headers: { 'X-API-KEY': apiKey, 'x-chain': 'solana' }, timeout: 8_000 }
    );
    const traders: any[] = r.data?.data?.items ?? [];
    let added = 0;
    for (const t of traders) {
      const addr = t.address;
      if (!addr) continue;
      const pnl = Number(t.pnl ?? 0);
      const wr  = Number(t.winRate ?? 0);
      if (pnl < 2 || wr < 0.55) continue; // min 2 SOL PnL + 55% WR in 7d
      await query(
        `INSERT INTO copy_wallets (address, label, win_rate, enabled)
         VALUES ($1, $2, $3, true)
         ON CONFLICT (address) DO UPDATE SET win_rate=$3, updated_at=NOW()`,
        [addr, `birdeye:wr${(wr * 100).toFixed(0)}pct:pnl${pnl.toFixed(0)}sol`, wr]
      ).catch(() => {});
      added++;
    }
    if (added > 0) console.info(`[copy-trader] 🔍 Discovered ${added} wallets from Birdeye 7d leaderboard`);
  } catch (e: any) {
    console.debug(`[copy-trader] Birdeye discovery: ${e.message?.slice(0, 60)}`);
  }
}

// ─── Main cycle ───────────────────────────────────────────────────────────────
export async function runCopyTradeCycle(
  keypair: Keypair,
  connection: Connection
): Promise<void> {
  if (!COPY_ENABLED || !HELIUS_KEY) return;

  const wallets = await getCopyWallets();
  if (!wallets.length) return;

  await Promise.all(wallets.map(async (w) => {
    const txs = await fetchNewSwaps(w.address);
    for (const tx of txs) {
      const buy = detectBuy(tx, w.address);
      if (!buy) continue;
      await executeCopy(w.label, w.address, buy.mint, buy.solSpent, keypair, connection)
        .catch(e => console.warn(`[copy-trader] ${w.label} error: ${e.message?.slice(0, 80)}`));
    }
  }));
}

// ─── Startup ─────────────────────────────────────────────────────────────────
export async function startCopyTrader(
  keypair: Keypair,
  connection: Connection
): Promise<void> {
  if (!COPY_ENABLED) {
    console.info('[copy-trader] Disabled (COPY_TRADE_ENABLED=false)');
    return;
  }
  if (!HELIUS_KEY) {
    console.warn('[copy-trader] HELIUS_API_KEY not set — copy-trading disabled');
    return;
  }

  const wallets = await getCopyWallets();
  console.info(
    `[copy-trader] Starting — ${wallets.length} wallets | ${COPY_SOL} SOL/copy | ` +
    `max ${MAX_COPY_POS} positions | min liq $${MIN_COPY_LIQ}`
  );

  // Set baseline — don't copy historic trades on startup
  await Promise.all(wallets.map(w => fetchNewSwaps(w.address)));

  // Discover profitable wallets from Birdeye on startup + weekly
  discoverTopWallets().catch(() => {});
  setInterval(() => discoverTopWallets().catch(() => {}), 7 * 24 * 3600 * 1000);

  async function loop(): Promise<void> {
    try { await runCopyTradeCycle(keypair, connection); }
    catch (e: any) { console.error(`[copy-trader] Loop error: ${e.message}`); }
    setTimeout(loop, POLL_MS);
  }
  setTimeout(loop, POLL_MS);
}
