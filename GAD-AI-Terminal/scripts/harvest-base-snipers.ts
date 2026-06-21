/**
 * Harvest Base Network smart money wallets from early token buyers.
 *
 * Uses Basescan `tokentx` API to find wallets that bought DEGEN/HIGHER/TOSHI/KEYCAT
 * in the first 100 transfers after deployment — early buyers who caught major movers.
 * Saves discovered wallets to smart_money_wallets with chain='BASE'.
 *
 * Usage: npx ts-node scripts/harvest-base-snipers.ts
 *        (or: tsc --outDir dist_harvest && node dist_harvest/harvest-base-snipers.js)
 *
 * ENV required:
 *   BASESCAN_API_KEY  — from basescan.org (free tier ok, 5 req/s)
 *   DATABASE_URL      — postgres connection string
 */

import axios from 'axios';
import { Pool } from 'pg';

const BASESCAN_API = 'https://api.basescan.org/api';
const BASESCAN_KEY = process.env.BASESCAN_API_KEY ?? '';
const DB_URL       = process.env.DATABASE_URL ?? '';

// Major Base tokens — early buyers of these ≈ smart money on Base
const TARGET_TOKENS: Array<{ symbol: string; address: string; deployBlock?: number }> = [
  { symbol: 'DEGEN',  address: '0x4ed4e862860bed51a9570b96d89af5e1b0efefed' },
  { symbol: 'HIGHER', address: '0x0578d8a44db98b23bf096a382e016e29a5ce0ffe' },
  { symbol: 'TOSHI',  address: '0xac1bd2486aaf3b5c0fc3fd868558b082a531b2b4' },
  { symbol: 'KEYCAT', address: '0x9a26f5433671751c3276a065f57e5a02d2817973' },
];

const EARLY_BUYER_LIMIT = 100;  // first N unique buyers = "early"
const MIN_BUY_VALUE_ETH = 0.001; // skip dust (<0.001 ETH equivalent)
const NULL_ADDRESS      = '0x0000000000000000000000000000000000000000';
const SLEEP_MS          = 250; // rate-limit buffer between Basescan calls

interface TokenTx {
  blockNumber:     string;
  from:            string;
  to:              string;
  value:           string;
  tokenDecimal:    string;
  hash:            string;
}

interface HarvestResult {
  symbol:  string;
  found:   number;
  inserted:number;
  skipped: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

async function fetchEarlyBuyers(tokenAddress: string): Promise<string[]> {
  // Fetch first page of transfers sorted by block ascending
  const url = `${BASESCAN_API}?module=account&action=tokentx` +
    `&contractaddress=${tokenAddress}` +
    `&page=1&offset=500&sort=asc` +
    `&apikey=${BASESCAN_KEY}`;

  const res = await axios.get(url, { timeout: 15000 });
  if (res.data.status !== '1' || !Array.isArray(res.data.result)) {
    console.warn(`[harvest-base] Basescan non-ok: ${res.data.message}`);
    return [];
  }

  const txs: TokenTx[] = res.data.result;

  // Collect early unique buyers (exclude: zero address, token contract itself)
  const seen = new Set<string>();
  const buyers: string[] = [];

  for (const tx of txs) {
    const buyer = tx.to.toLowerCase();
    if (buyer === NULL_ADDRESS) continue;
    if (buyer === tokenAddress.toLowerCase()) continue;
    if (seen.has(buyer)) continue;

    const decimals = Number(tx.tokenDecimal || 18);
    const tokenAmt = Number(tx.value) / 10 ** decimals;
    if (tokenAmt < 1) continue; // dust filter

    seen.add(buyer);
    buyers.push(buyer);

    if (buyers.length >= EARLY_BUYER_LIMIT) break;
  }

  return buyers;
}

async function upsertWallets(
  pool: Pool,
  wallets: string[],
  symbol: string,
): Promise<{ inserted: number; skipped: number }> {
  let inserted = 0;
  let skipped  = 0;

  for (const addr of wallets) {
    try {
      const res = await pool.query(
        `INSERT INTO smart_money_wallets
           (wallet_address, chain, tier, notes, created_at, reliability_weight)
         VALUES ($1, 'BASE', 'STANDARD', $2, NOW(), 1.0)
         ON CONFLICT (wallet_address, chain) DO NOTHING`,
        [addr.toLowerCase(), `Early buyer of $${symbol} on Base — auto-harvested`]
      );
      if ((res.rowCount ?? 0) > 0) inserted++;
      else skipped++;
    } catch (err: any) {
      console.warn(`[harvest-base] DB insert failed for ${addr}: ${err.message}`);
      skipped++;
    }
  }

  return { inserted, skipped };
}

async function harvestToken(
  pool: Pool,
  token: { symbol: string; address: string },
): Promise<HarvestResult> {
  console.info(`[harvest-base] Fetching early buyers of $${token.symbol} (${token.address})`);

  const buyers = await fetchEarlyBuyers(token.address);
  console.info(`[harvest-base] $${token.symbol}: found ${buyers.length} early buyers`);

  if (!buyers.length) {
    return { symbol: token.symbol, found: 0, inserted: 0, skipped: 0 };
  }

  const { inserted, skipped } = await upsertWallets(pool, buyers, token.symbol);
  console.info(`[harvest-base] $${token.symbol}: ${inserted} inserted, ${skipped} already known`);
  return { symbol: token.symbol, found: buyers.length, inserted, skipped };
}

async function main(): Promise<void> {
  if (!BASESCAN_KEY) {
    console.error('[harvest-base] BASESCAN_API_KEY not set');
    process.exit(1);
  }
  if (!DB_URL) {
    console.error('[harvest-base] DATABASE_URL not set');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: DB_URL });

  console.info('[harvest-base] Starting Base sniper harvest…');
  const results: HarvestResult[] = [];

  for (const token of TARGET_TOKENS) {
    try {
      const r = await harvestToken(pool, token);
      results.push(r);
    } catch (err: any) {
      console.error(`[harvest-base] Error harvesting $${token.symbol}: ${err.message}`);
      results.push({ symbol: token.symbol, found: 0, inserted: 0, skipped: 0 });
    }
    await sleep(SLEEP_MS);
  }

  console.info('\n[harvest-base] ── SUMMARY ──');
  let totalInserted = 0;
  for (const r of results) {
    console.info(`  $${r.symbol.padEnd(8)} found=${r.found}  inserted=${r.inserted}  skipped=${r.skipped}`);
    totalInserted += r.inserted;
  }
  console.info(`[harvest-base] Total new Base SM wallets: ${totalInserted}`);
  console.info('[harvest-base] Done.');

  await pool.end();
}

main().catch(err => {
  console.error('[harvest-base] Fatal:', err);
  process.exit(1);
});
