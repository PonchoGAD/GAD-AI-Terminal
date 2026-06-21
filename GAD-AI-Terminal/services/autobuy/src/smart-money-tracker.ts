/**
 * Smart Money Tracker v2 — weighted signal detection for Solana pump.fun.
 *
 * Architecture:
 *  - Wallet weights stored in DB (smart_money_wallets.reliability_weight)
 *  - Standard wallet = 1.0, proven sniper (top-10) = 2.0, elite (top-3 + multi-token) = 3.0
 *  - Signal triggers when total weight ≥ TRIGGER_THRESHOLD (default 2.5)
 *
 * Threshold logic:
 *   Elite (3.0) alone  → triggers (3.0 ≥ 2.5)
 *   Two standard (2.0) → triggers (2×1.0 ≥ 2.5? No → need 3 standard or 1 proven+1 standard)
 *   Proven + Standard  → triggers (2.0+1.0 = 3.0 ≥ 2.5)
 *   Three standard     → triggers (3×1.0 = 3.0 ≥ 2.5)
 *
 * Reduces false positives vs v1 (count-only) — weak co-entry of 2 standard wallets
 * is no longer enough; needs >= 2.5 weighted confidence.
 */

import { query } from '@lib/db';

const CONFIRMATION_WINDOW_MS = Number(process.env.SMART_MONEY_WINDOW_MS     ?? '120000');
const TRIGGER_THRESHOLD      = Number(process.env.SMART_MONEY_THRESHOLD     ?? '2.5');
const REFRESH_MS             = 15 * 60 * 1000;  // 15 min

// ─── Wallet registry (weight-aware) ─────────────────────────────────────────

interface SmWallet {
  address: string;
  weight:  number;
}

// in-memory weight map: address → weight
let smartMoneyMap = new Map<string, number>();
let lastRefresh   = 0;

async function refreshSmartMoneyList(): Promise<void> {
  if (Date.now() - lastRefresh < REFRESH_MS) return;
  lastRefresh = Date.now();

  const fresh = new Map<string, number>();

  // 1. From env (flat list, default weight 1.0)
  for (const addr of (process.env.SMART_MONEY_WALLETS ?? '').split(',').map(a => a.trim()).filter(Boolean)) {
    fresh.set(addr, 1.0);
  }

  // 2. From DB (includes reliability_weight)
  try {
    const { rows } = await query<{ wallet_address: string; reliability_weight: string }>(
      `SELECT wallet_address, reliability_weight
         FROM smart_money_wallets
        WHERE active = true AND (network = 'solana' OR network IS NULL)
        LIMIT 500`
    );
    for (const row of rows) {
      const w = Number(row.reliability_weight ?? 1.0);
      fresh.set(row.wallet_address, w);
    }
  } catch {
    // Table may not have network column yet (pre-migration) — fallback to simple query
    try {
      const { rows } = await query<{ wallet_address: string }>(
        `SELECT wallet_address FROM smart_money_wallets WHERE active = true LIMIT 500`
      );
      for (const row of rows) {
        if (!fresh.has(row.wallet_address)) fresh.set(row.wallet_address, 1.0);
      }
    } catch { /* env-only mode */ }
  }

  if (fresh.size !== smartMoneyMap.size) {
    console.info(`[smart-money] Loaded ${fresh.size} wallets (weighted)`);
  }
  smartMoneyMap = fresh;
}

// ─── Active signal registry ───────────────────────────────────────────────────

interface ActiveSignal {
  wallet:    string;
  weight:    number;
  timestamp: number;
}

// mint → [signals within window]
const activeSignals = new Map<string, ActiveSignal[]>();

function getValidSignals(mint: string): ActiveSignal[] {
  const now = Date.now();
  const signals = (activeSignals.get(mint) ?? []).filter(s => now - s.timestamp <= CONFIRMATION_WINDOW_MS);
  activeSignals.set(mint, signals);
  return signals;
}

function getTotalWeight(signals: ActiveSignal[]): number {
  return signals.reduce((sum, s) => sum + s.weight, 0);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Register a buy event. Returns current SM confirmation count (v1 compat).
 * Also updates weighted signal registry.
 */
export async function registerBuy(mint: string, buyer: string): Promise<number> {
  await refreshSmartMoneyList();

  const weight = smartMoneyMap.get(buyer);
  if (weight === undefined) return 0;  // not a SM wallet

  const now = Date.now();
  const signals = getValidSignals(mint);

  // Avoid duplicate from same wallet within window
  if (!signals.some(s => s.wallet === buyer)) {
    signals.push({ wallet: buyer, weight, timestamp: now });
    activeSignals.set(mint, signals);
  }

  const totalWeight = getTotalWeight(signals);
  const count       = signals.length;

  if (totalWeight >= TRIGGER_THRESHOLD) {
    const wallets = signals.map(s => `${s.wallet.slice(0, 6)}(w${s.weight})`).join(', ');
    console.info(`[smart-money] 🔥 Weight ${totalWeight.toFixed(1)}/${TRIGGER_THRESHOLD} on ${mint.slice(0, 8)} — ${wallets}`);
  } else if (count === 1) {
    console.debug(`[smart-money] 👀 SM w${weight} ${buyer.slice(0, 8)} → ${mint.slice(0, 8)}`);
  }

  return count;
}

/**
 * БЛОК 2.2: Weighted signal check.
 * Returns true if total weight of SM buys within window ≥ TRIGGER_THRESHOLD.
 * Use this instead of getConfirmations() for production trading decisions.
 */
export async function processSmartMoneyBuy(mint: string, buyerWallet: string): Promise<boolean> {
  await refreshSmartMoneyList();

  const weight = smartMoneyMap.get(buyerWallet);
  if (weight === undefined) return false;

  const now = Date.now();
  const signals = getValidSignals(mint);

  if (!signals.some(s => s.wallet === buyerWallet)) {
    signals.push({ wallet: buyerWallet, weight, timestamp: now });
    activeSignals.set(mint, signals);
  }

  const totalWeight = getTotalWeight(signals);

  if (totalWeight >= TRIGGER_THRESHOLD) {
    console.info(`[smart-money-v3] 🎯 Threshold passed for ${mint.slice(0, 8)}. Total weight: ${totalWeight.toFixed(1)}`);

    // Update signal count in DB (non-blocking)
    query(
      `UPDATE smart_money_wallets SET total_signals = total_signals + 1, last_signal_at = now()
        WHERE wallet_address = $1`,
      [buyerWallet]
    ).catch(() => {});

    return true;
  }

  return false;
}

/** Get current SM confirmation count (backward compat with v1). */
export function getConfirmations(mint: string): number {
  return getValidSignals(mint).length;
}

/** Get total weight of SM signals for a mint. */
export function getSignalWeight(mint: string): number {
  return getTotalWeight(getValidSignals(mint));
}

/** True if weight ≥ TRIGGER_THRESHOLD (recommended over getConfirmations). */
export function hasSmartMoneySignal(mint: string): boolean {
  return getSignalWeight(mint) >= TRIGGER_THRESHOLD;
}

/** Legacy: true if ≥ 2 SM confirmations (v1 compat). */
export function hasSmartMoneyCount(mint: string, minCount = 2): boolean {
  return getConfirmations(mint) >= minCount;
}

/** Prune expired entries. */
export function pruneRegistry(): void {
  for (const mint of activeSignals.keys()) {
    getValidSignals(mint);  // side-effect: prunes and updates
    if ((activeSignals.get(mint) ?? []).length === 0) activeSignals.delete(mint);
  }
}

setInterval(pruneRegistry, 5 * 60 * 1000);
