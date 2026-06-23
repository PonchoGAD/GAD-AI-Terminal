/**
 * autobuy startup patch
 * Applied on every container start via docker-compose.override.yml
 *
 * Patches applied:
 * 1. bonding-smart shadow INSERT — persist WOULD-BUY recording across recreates
 */

const fs = require('fs');
let patchCount = 0;

const bsPath = '/usr/src/app/services/autobuy/dist/bonding-smart.js';
let bs = fs.readFileSync(bsPath, 'utf8');

// Patch: ensure shadow INSERT exists before doBuy call
const SHADOW_MARKER = "INSERT INTO shadow_trades";
const DOBUY_CALL    = "await doBuy(state, decision.reason);";
const DECISION_BUY  = "if (decision.buy) {";

if (!bs.includes(SHADOW_MARKER) && bs.includes(DECISION_BUY)) {
  const shadowBlock = `
        try {
            const entryEst = state.vSol > 0 ? state.vSol / 800000000 : 1e-9;
            const velNow = state.events.filter(e=>e.isBuy&&Date.now()-e.ts<=60000).reduce((s,e)=>s+e.solAmount,0);
            const buyersNow = new Set(state.events.filter(e=>e.isBuy&&Date.now()-e.ts<=300000).map(e=>e.buyer)).size;
            await require('@lib/db').query(
                'INSERT INTO shadow_trades (chain,strategy,symbol,contract_address,entry_price,entry_mcap_usd,filter_params,tp1_target,stop_pct) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING',
                ['solana','bonding_smart',state.symbol,state.mint,entryEst,state.vSol*160,
                 JSON.stringify({vel:velNow,buyers:buyersNow,curve:+(state.vSol/588*100).toFixed(1)}),
                 entryEst*1.5,8]
            );
        } catch(_se) {}`;
  bs = bs.replace(DOBUY_CALL, shadowBlock + '\n        ' + DOBUY_CALL);
  fs.writeFileSync(bsPath, bs);
  patchCount++;
  console.log('[patch] autobuy bonding-smart.js: shadow INSERT added');
} else if (bs.includes(SHADOW_MARKER)) {
  console.log('[patch] autobuy bonding-smart.js: shadow INSERT already present');
} else {
  console.log('[patch] autobuy bonding-smart.js: pattern not found — check dist structure');
}

console.log('[patch] autobuy: ' + patchCount + ' patch(es) applied — starting service...');
