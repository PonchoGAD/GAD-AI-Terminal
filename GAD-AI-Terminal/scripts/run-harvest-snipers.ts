/**
 * Quick harvest runner — populates smart_money_wallets DB with elite snipers
 * from verified $100M+ pump.fun tokens.
 *
 * Uses the 6 pre-loaded tokens (GOAT, PNUT, ACT, FARTCOIN, ZEREBRO, MICHI).
 * Add SUCCESSFUL_TOKENS=mint1,mint2,... env to override with custom list.
 *
 * Run locally:
 *   npx tsc --target ES2020 --module CommonJS --esModuleInterop true --skipLibCheck true \
 *     --allowSyntheticDefaultImports true --outDir dist_harvest --strict false \
 *     --paths '{"@lib/db":["libs/db/src/index.ts"]}' \
 *     scripts/run-harvest-snipers.ts
 *   SOLANA_RPC=<helius> node dist_harvest/run-harvest-snipers.js
 *
 * Or directly with ts-node (if configured):
 *   SOLANA_RPC=<helius> npx ts-node -p tsconfig.launch.json scripts/run-harvest-snipers.ts
 */

import { harvestSmartMoney } from '../services/autobuy/src/harvest-snipers';

console.log('🔍 Starting Smart Money Harvest...');
console.log('Tokens: GOAT, PNUT, ACT, FARTCOIN, ZEREBRO, MICHI (+ SUCCESSFUL_TOKENS env)');
console.log('Output: smart_money_candidates.txt + DB smart_money_wallets\n');

harvestSmartMoney()
  .then((wallets) => {
    console.log(`\n✅ Harvest complete. Found ${wallets.length} SM wallets.`);
    console.log('\nNext steps:');
    console.log('1. Copy elite wallets (weight 3.0) to VPS .env SMART_MONEY_WALLETS');
    console.log('2. Run migration 024 on VPS:');
    console.log('   docker compose exec -T postgres psql -U gad -d gad_ai < migrations/024_smart_money_weighted.sql');
    console.log('3. Set BONDING_SMART_ENABLED=true in VPS .env (after balance check)');
    process.exit(0);
  })
  .catch((err) => {
    console.error('Harvest failed:', err.message);
    process.exit(1);
  });
