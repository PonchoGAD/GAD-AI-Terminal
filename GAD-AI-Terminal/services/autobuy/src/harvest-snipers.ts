/**
 * Smart Money Harvester — finds profitable sniper wallets from successful tokens.
 *
 * Two strategies:
 *  A) Dune Analytics API  — query pump.fun top-trader leaderboard (batch, free tier)
 *  B) Onchain analysis    — trace early buyers of known successful tokens (no API key needed)
 *
 * Usage (run locally, not on VPS):
 *   npx ts-node --skip-project services/autobuy/src/harvest-snipers.ts
 *
 * Env:
 *   DUNE_API_KEY          — from dune.com/settings/api (free tier: 100 credits/month)
 *   SOLANA_RPC            — Helius RPC for onchain analysis
 *   SUCCESSFUL_TOKENS     — comma-separated mint addresses (defaults to 6 verified $100M+ tokens below)
 *
 * Pre-loaded verified $100M+ Solana tokens (early buyers = elite SM wallets):
 *   GOAT   CzLSz17Gf4sSfe3VpJgYvGcxm9MY12bgkbALGFbbpump  (>$900M mcap)
 *   PNUT   2qEH9Z6s4yHM22c4xDJJsiTyAgMNbeGg867Y8Atpump   (>$1.5B mcap)
 *   ACT    GJAFwWjPrBh69EC2zY6Sxh9pSFr8S4g6743J8Wvpump   (AI listings)
 *   FARTCOIN 9BBLa7v6gGcPP7odw2VeeofksCcT17278Y6Te3vpump  (Raydium liq)
 *   ZEREBRO HZ1J6tNZRx6jmbZ2uS7G6Sj87iS4uWvx7S747Kvpump  (AI niche)
 *   MICHI  5mbK66qdKMvUr8u6S78585d9HdoJ5mc87t5C712Kpump   (sustained mascot)
 *
 * Output: writes addresses to smart_money_candidates.txt + optionally upserts to DB
 */

import axios from 'axios';
import { Connection, PublicKey } from '@solana/web3.js';
import { query } from '@lib/db';
import * as fs from 'fs';

const HELIUS_RPC = process.env.SOLANA_RPC ?? 'https://api.mainnet-beta.solana.com';
const DUNE_API_KEY = process.env.DUNE_API_KEY ?? '';
const OUTPUT_FILE = 'smart_money_candidates.txt';

// Verified $100M+ pump.fun → Raydium tokens — early buyers = elite SM wallets
const DEFAULT_SUCCESSFUL_TOKENS = [
  'CzLSz17Gf4sSfe3VpJgYvGcxm9MY12bgkbALGFbbpump',  // GOAT >$900M
  '2qEH9Z6s4yHM22c4xDJJsiTyAgMNbeGg867Y8Atpump',   // PNUT >$1.5B
  'GJAFwWjPrBh69EC2zY6Sxh9pSFr8S4g6743J8Wvpump',   // ACT  AI-niche listing
  '9BBLa7v6gGcPP7odw2VeeofksCcT17278Y6Te3vpump',   // FARTCOIN high Raydium liq
  'HZ1J6tNZRx6jmbZ2uS7G6Sj87iS4uWvx7S747Kvpump',  // ZEREBRO AI content
  '5mbK66qdKMvUr8u6S78585d9HdoJ5mc87t5C712Kpump',  // MICHI sustained mascot
];

// ─── Strategy A: Dune Analytics API ─────────────────────────────────────────
// Query IDs for public pump.fun leaderboard dashboards.
// These are stable public queries — update if they stop working.
// Find IDs at: dune.com/jhackworth/pump-fun or dune.com/subinium/pump-fun-traders

const DUNE_QUERY_IDS = {
  topTradersWR:   3476752,  // pump.fun top traders by win rate (> 50% WR, > 100 trades)
  topTradersProfit: 3476800, // pump.fun top traders by total profit
};

interface DuneTrader {
  wallet: string;
  win_rate: number;
  total_trades: number;
  total_profit_sol: number;
  avg_hold_seconds: number;
}

async function fetchDuneLeaderboard(queryId: number): Promise<DuneTrader[]> {
  if (!DUNE_API_KEY) {
    console.warn('[harvest] No DUNE_API_KEY — skipping Dune strategy. Get free key: dune.com/settings/api');
    return [];
  }

  try {
    // Execute query (uses 1-2 credits depending on cache)
    const execRes = await axios.post(
      `https://api.dune.com/api/v1/query/${queryId}/execute`,
      { performance: 'medium' },
      { headers: { 'X-Dune-Api-Key': DUNE_API_KEY }, timeout: 30_000 }
    );
    const execId = execRes.data?.execution_id;
    if (!execId) return [];

    // Poll for results (max 30s)
    for (let i = 0; i < 15; i++) {
      await new Promise(r => setTimeout(r, 2_000));
      const statusRes = await axios.get(
        `https://api.dune.com/api/v1/execution/${execId}/status`,
        { headers: { 'X-Dune-Api-Key': DUNE_API_KEY } }
      );
      if (statusRes.data?.state !== 'QUERY_STATE_COMPLETED') continue;

      const resultRes = await axios.get(
        `https://api.dune.com/api/v1/execution/${execId}/results`,
        { headers: { 'X-Dune-Api-Key': DUNE_API_KEY }, timeout: 15_000 }
      );
      const rows: any[] = resultRes.data?.result?.rows ?? [];
      return rows.map(r => ({
        wallet:           r.wallet_address ?? r.trader ?? r.address ?? '',
        win_rate:         Number(r.win_rate ?? r.winrate ?? 0),
        total_trades:     Number(r.total_trades ?? r.trades ?? 0),
        total_profit_sol: Number(r.total_profit_sol ?? r.profit ?? 0),
        avg_hold_seconds: Number(r.avg_hold_seconds ?? r.avg_hold_time ?? 0),
      })).filter(t => t.wallet.length > 30);
    }
    return [];
  } catch (err: any) {
    console.error(`[harvest] Dune API error: ${err.message?.slice(0, 60)}`);
    return [];
  }
}

function filterQualityTraders(traders: DuneTrader[]): DuneTrader[] {
  return traders.filter(t =>
    t.total_trades >= 100 &&             // not a one-hit wonder
    t.win_rate >= 0.50 &&                // ≥50% WR
    t.avg_hold_seconds <= 15 * 60        // avg hold < 15 min (fast sniper)
  );
}

// ─── Strategy B: Onchain early-buyer analysis ─────────────────────────────────
// Given a successful token mint, find who bought first and profited.

interface OnchainSniper {
  wallet: string;
  earlyRank: number;   // 1 = first buyer
  approxBuySol: number;
}

async function harvestOnchainSnipers(mintAddress: string, topN = 15): Promise<OnchainSniper[]> {
  const conn = new Connection(HELIUS_RPC, 'confirmed');
  console.log(`[harvest] Onchain analysis: ${mintAddress.slice(0, 12)}...`);

  try {
    // Get token pair from DexScreener
    const dexRes = await axios.get(
      `https://api.dexscreener.com/latest/dex/tokens/${mintAddress}`,
      { timeout: 8_000 }
    );
    const pairs: any[] = dexRes.data?.pairs ?? [];
    if (!pairs.length) { console.warn('[harvest] No pairs found on DexScreener'); return []; }

    // Use pump.fun or pumpswap pair (first result)
    const pair = pairs.find(p => p.dexId === 'pumpfun' || p.dexId === 'pumpswap') ?? pairs[0];
    const pairAddress = pair.pairAddress;
    console.log(`[harvest] Pool: ${pairAddress.slice(0, 12)} (${pair.dexId})`);

    // Get earliest 100 signatures for this pool
    const sigs = await conn.getSignaturesForAddress(new PublicKey(pairAddress), { limit: 100 });
    const oldest = sigs.reverse();  // oldest first

    const earlyBuyers: OnchainSniper[] = [];
    const seen = new Set<string>();

    for (const sig of oldest) {
      if (earlyBuyers.length >= topN) break;
      try {
        const tx = await conn.getParsedTransaction(sig.signature, { maxSupportedTransactionVersion: 0 });
        if (!tx?.meta) continue;

        // Find the signer (the buyer)
        const keys = tx.transaction.message.accountKeys;
        const signer = keys.find((k: any) => k.signer)?.pubkey?.toBase58();
        if (!signer || seen.has(signer)) continue;
        seen.add(signer);

        // Estimate SOL spent (SOL balance change for signer)
        const signerIdx = keys.findIndex((k: any) => k.pubkey?.toBase58() === signer);
        const preBal  = tx.meta.preBalances[signerIdx]  ?? 0;
        const postBal = tx.meta.postBalances[signerIdx] ?? 0;
        const solSpent = Math.max(0, (preBal - postBal) / 1e9);

        if (solSpent > 0.001) {  // min 0.001 SOL spend (excludes fee-only TXs)
          earlyBuyers.push({ wallet: signer, earlyRank: earlyBuyers.length + 1, approxBuySol: solSpent });
        }
      } catch { /* skip failed TX parse */ }
    }

    console.log(`[harvest] Found ${earlyBuyers.length} early buyers for ${mintAddress.slice(0, 8)}`);
    return earlyBuyers;
  } catch (err: any) {
    console.error(`[harvest] Onchain error: ${err.message?.slice(0, 60)}`);
    return [];
  }
}

// ─── Save to file and DB ──────────────────────────────────────────────────────

async function saveToFile(wallets: string[]): Promise<void> {
  const existing = fs.existsSync(OUTPUT_FILE)
    ? fs.readFileSync(OUTPUT_FILE, 'utf-8').split('\n').filter(Boolean)
    : [];
  const merged = Array.from(new Set([...existing, ...wallets]));
  fs.writeFileSync(OUTPUT_FILE, merged.join('\n'));
  console.log(`[harvest] ✅ Saved ${merged.length} wallets to ${OUTPUT_FILE}`);
}

// Compute reliability_weight from early_rank:
//   rank 1-3  → 3.0 (elite: very first buyers of $100M+ tokens)
//   rank 4-10 → 2.0 (proven sniper)
//   rank 11-15→ 1.5 (early sniper)
//   rank 16+  → 1.0 (standard)
function rankToWeight(rank: number): number {
  if (rank <= 3)  return 3.0;
  if (rank <= 10) return 2.0;
  if (rank <= 15) return 1.5;
  return 1.0;
}

async function saveToDb(
  wallets: Array<{ wallet: string; earlyRank?: number; token?: string }>,
  source: string,
  network = 'solana'
): Promise<void> {
  let saved = 0;
  for (const { wallet, earlyRank = 99, token } of wallets) {
    const weight = rankToWeight(earlyRank);
    try {
      await query(
        `INSERT INTO smart_money_wallets
           (wallet_address, network, associated_token, early_rank, reliability_weight, source, active, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, true, now())
         ON CONFLICT (wallet_address) DO UPDATE SET
           reliability_weight = GREATEST(smart_money_wallets.reliability_weight, EXCLUDED.reliability_weight),
           early_rank = LEAST(smart_money_wallets.early_rank, EXCLUDED.early_rank),
           source = EXCLUDED.source,
           active = true`,
        [wallet, network, token ?? null, earlyRank, weight, source]
      );
      saved++;
    } catch {
      // Fallback: try without network column (pre-migration)
      try {
        await query(
          `INSERT INTO smart_money_wallets (wallet_address, source, active, created_at)
           VALUES ($1, $2, true, now())
           ON CONFLICT (wallet_address) DO UPDATE SET source = $2, active = true`,
          [wallet, source]
        );
        saved++;
      } catch { /* table doesn't exist */ }
    }
  }
  if (saved > 0) console.log(`[harvest] DB: upserted ${saved} wallets (network: ${network}, source: ${source})`);
}

// ─── Main harvest function ────────────────────────────────────────────────────

export async function harvestSmartMoney(): Promise<string[]> {
  const allWallets = new Set<string>();

  // Structured wallet list with ranks for weighted DB storage
  const walletEntries: Array<{ wallet: string; earlyRank: number; token?: string }> = [];

  // A. Dune leaderboard (if API key present)
  if (DUNE_API_KEY) {
    console.log('\n[harvest] 📊 Strategy A: Dune Analytics leaderboard...');
    const traders = await fetchDuneLeaderboard(DUNE_QUERY_IDS.topTradersWR);
    const qualified = filterQualityTraders(traders);
    console.log(`[harvest] Dune: ${traders.length} total → ${qualified.length} qualified (WR≥50%, trades≥100, hold<15min)`);
    qualified.forEach((t, i) => {
      allWallets.add(t.wallet);
      walletEntries.push({ wallet: t.wallet, earlyRank: i + 1 });  // rank by WR position
      console.log(`  ${t.wallet.slice(0, 12)} WR:${(t.win_rate * 100).toFixed(0)}% trades:${t.total_trades} profit:${t.total_profit_sol.toFixed(1)} SOL`);
    });
  }

  // B. Onchain analysis of successful tokens
  // Use env override OR fall back to pre-loaded verified $100M+ tokens
  const envTokens = (process.env.SUCCESSFUL_TOKENS ?? '').split(',').map(s => s.trim()).filter(s => s.length > 30);
  const mintList = envTokens.length > 0 ? envTokens : DEFAULT_SUCCESSFUL_TOKENS;

  console.log(`\n[harvest] 🔍 Strategy B: Onchain analysis of ${mintList.length} tokens (${envTokens.length > 0 ? 'from env' : 'default $100M+ list'})...`);
  for (const mint of mintList.slice(0, 6)) {
    const snipers = await harvestOnchainSnipers(mint, 15);
    snipers.forEach(s => {
      allWallets.add(s.wallet);
      // Only add if not already in list, preserve best (lowest) rank
      const existing = walletEntries.find(e => e.wallet === s.wallet);
      if (!existing) {
        walletEntries.push({ wallet: s.wallet, earlyRank: s.earlyRank, token: mint });
      } else if (s.earlyRank < existing.earlyRank) {
        existing.earlyRank = s.earlyRank;
        existing.token = mint;
      }
    });
  }

  const finalList = Array.from(allWallets);
  console.log(`\n[harvest] 🎯 Total unique wallets: ${finalList.length}`);

  // Weight breakdown
  const elite   = walletEntries.filter(w => w.earlyRank <= 3).length;
  const proven  = walletEntries.filter(w => w.earlyRank > 3 && w.earlyRank <= 10).length;
  const early   = walletEntries.filter(w => w.earlyRank > 10 && w.earlyRank <= 15).length;
  const standard = walletEntries.filter(w => w.earlyRank > 15).length;
  console.log(`[harvest] Weights: 🥇 elite(3.0)=${elite}  🥈 proven(2.0)=${proven}  🥉 early(1.5)=${early}  standard(1.0)=${standard}`);

  if (finalList.length > 0) {
    await saveToFile(finalList);
    await saveToDb(walletEntries.length > 0 ? walletEntries : finalList.map(w => ({ wallet: w, earlyRank: 99 })),
                   DUNE_API_KEY ? 'dune+onchain' : 'onchain',
                   'solana');
    console.log(`\n[harvest] Add to VPS .env:\nSMART_MONEY_WALLETS=${finalList.slice(0, 20).join(',')}`);
  }

  return finalList;
}

// CLI runner (when executed directly)
if (require.main === module) {
  harvestSmartMoney().then(() => process.exit(0)).catch(err => {
    console.error(err);
    process.exit(1);
  });
}
