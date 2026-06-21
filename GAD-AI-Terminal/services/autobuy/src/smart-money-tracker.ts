/**
 * Smart Money Tracker — real-time monitoring of profitable wallets.
 *
 * Maintains an in-memory registry of "smart money" wallet purchases.
 * When ≥2 smart money wallets buy the same token within 120s → BUY signal.
 *
 * Smart money list sourced from:
 *  1. SMART_MONEY_WALLETS env var (comma-separated, for quick config)
 *  2. smart_money_wallets DB table (for managed lists)
 *
 * Win rate uplift observed in open-source sniper research:
 *  0 SM wallets → baseline WR
 *  1 SM wallet  → +10-15% WR uplift
 *  2+ SM wallets → +25-30% WR uplift
 */

import { query } from '@lib/db';

// Window for smart money co-buy detection
const CONFIRMATION_WINDOW_MS = Number(process.env.SMART_MONEY_WINDOW_MS ?? '120000');  // 120s
const MIN_SM_CONFIRMATIONS   = Number(process.env.SMART_MONEY_MIN_CONFIRM ?? '2');

// In-memory: mint → Map<smWallet, timestamp>
const buyRegistry = new Map<string, Map<string, number>>();

// Smart money wallet list — loaded once at startup, refreshed every 15 min
let smartMoneySet = new Set<string>();
let lastRefresh = 0;
const REFRESH_MS = 15 * 60 * 1000;

async function refreshSmartMoneyList(): Promise<void> {
  if (Date.now() - lastRefresh < REFRESH_MS) return;
  lastRefresh = Date.now();

  const fresh = new Set<string>();

  // 1. From env (always available)
  const fromEnv = process.env.SMART_MONEY_WALLETS ?? '';
  for (const addr of fromEnv.split(',').map(a => a.trim()).filter(Boolean)) {
    fresh.add(addr);
  }

  // 2. From DB table (if it exists)
  try {
    const { rows } = await query<{ wallet_address: string }>(
      `SELECT wallet_address FROM smart_money_wallets WHERE active = true LIMIT 200`
    );
    for (const row of rows) fresh.add(row.wallet_address);
  } catch {
    // Table may not exist yet — env-only mode is fine
  }

  if (fresh.size !== smartMoneySet.size) {
    console.info(`[smart-money] Loaded ${fresh.size} smart money wallets`);
  }
  smartMoneySet = fresh;
}

/**
 * Called on every buy event from PumpPortal WebSocket.
 * Returns the number of SM confirmations for this mint (including this one).
 */
export async function registerBuy(mint: string, buyer: string): Promise<number> {
  await refreshSmartMoneyList();

  if (!smartMoneySet.has(buyer)) return 0;

  const now = Date.now();

  // Init registry for this mint
  if (!buyRegistry.has(mint)) {
    buyRegistry.set(mint, new Map());
  }
  const mintMap = buyRegistry.get(mint)!;

  // Add this SM wallet's buy
  mintMap.set(buyer, now);

  // Prune expired entries (outside confirmation window)
  for (const [wallet, ts] of mintMap) {
    if (now - ts > CONFIRMATION_WINDOW_MS) mintMap.delete(wallet);
  }

  const confirmations = mintMap.size;

  if (confirmations >= MIN_SM_CONFIRMATIONS) {
    const wallets = Array.from(mintMap.keys()).map(w => w.slice(0, 8)).join(', ');
    console.info(`[smart-money] 🔥 ${confirmations} confirmations on ${mint.slice(0, 8)} — wallets: ${wallets}`);
  } else if (confirmations === 1) {
    console.debug(`[smart-money] 👀 SM wallet ${buyer.slice(0, 8)} entered ${mint.slice(0, 8)}`);
  }

  return confirmations;
}

/** Get current SM confirmation count for a mint (0 if none or expired). */
export function getConfirmations(mint: string): number {
  const mintMap = buyRegistry.get(mint);
  if (!mintMap) return 0;
  const now = Date.now();
  let count = 0;
  for (const [, ts] of mintMap) {
    if (now - ts <= CONFIRMATION_WINDOW_MS) count++;
  }
  return count;
}

/** True if this mint has ≥ MIN_SM_CONFIRMATIONS smart money buys within window. */
export function hasSmartMoneySignal(mint: string): boolean {
  return getConfirmations(mint) >= MIN_SM_CONFIRMATIONS;
}

/** Clean up old mint entries (call periodically to prevent memory leak). */
export function pruneRegistry(): void {
  const now = Date.now();
  for (const [mint, mintMap] of buyRegistry) {
    for (const [wallet, ts] of mintMap) {
      if (now - ts > CONFIRMATION_WINDOW_MS) mintMap.delete(wallet);
    }
    if (mintMap.size === 0) buyRegistry.delete(mint);
  }
}

// Periodic prune every 5 minutes
setInterval(pruneRegistry, 5 * 60 * 1000);
