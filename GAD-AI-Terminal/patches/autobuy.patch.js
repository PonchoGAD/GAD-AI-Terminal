/**
 * autobuy startup patch
 * Patches:
 * 1. bonding-smart shadow INSERT — persist WOULD-BUY recording across recreates
 * 2. PumpPortal reconnect delay 5s → 60s — stop hammering their server (reduces 403 risk)
 */

const fs = require('fs');
let patchCount = 0;

const bsPath = '/usr/src/app/services/autobuy/dist/bonding-smart.js';
let bs = fs.readFileSync(bsPath, 'utf8');

// Patch 1: shadow INSERT before doBuy
const SHADOW_MARKER = "INSERT INTO shadow_trades";
const DOBUY_CALL    = "await doBuy(state, decision.reason);";
const DECISION_BUY  = "if (decision.buy) {";

if (!bs.includes(SHADOW_MARKER) && bs.includes(DECISION_BUY)) {
  var shadowBlock = [
    '        try {',
    '            const entryEst = state.vSol > 0 ? state.vSol / 800000000 : 1e-9;',
    '            const velNow = state.events.filter(function(e){return e.isBuy&&Date.now()-e.ts<=60000;}).reduce(function(s,e){return s+e.solAmount;},0);',
    '            const buyersNow = new Set(state.events.filter(function(e){return e.isBuy&&Date.now()-e.ts<=300000;}).map(function(e){return e.buyer;})).size;',
    "            require('@lib/db').query(",
    "                'INSERT INTO shadow_trades (chain,strategy,symbol,contract_address,entry_price,entry_mcap_usd,filter_params,tp1_target,stop_pct) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING',",
    "                ['solana','bonding_smart',state.symbol,state.mint,entryEst,state.vSol*160,",
    '                 JSON.stringify({vel:velNow,buyers:buyersNow,curve:+(state.vSol/588*100).toFixed(1)}),',
    '                 entryEst*1.5,8]',
    '            ).catch(function(){});',
    "            console.info('[bonding-smart] SHADOW would-buy: ' + state.symbol);",
    '        } catch(_se) {}',
  ].join('\n');
  bs = bs.replace(DOBUY_CALL, shadowBlock + '\n        ' + DOBUY_CALL);
  patchCount++;
  console.log('[patch] autobuy bonding-smart.js: shadow INSERT added');
} else if (bs.includes(SHADOW_MARKER)) {
  console.log('[patch] autobuy bonding-smart.js: shadow INSERT already present');
} else {
  console.log('[patch] autobuy bonding-smart.js: doBuy pattern not found');
}

// Patch 2: increase PumpPortal reconnect delay 5s → 60s to avoid ban
if (bs.includes('reconnecting in 5s')) {
  bs = bs.replace(/reconnecting in 5s/g, 'reconnecting in 60s');
  bs = bs.replace(/setTimeout\(connectWS, 5000\)/g, 'setTimeout(connectWS, 60000)');
  bs = bs.replace(/setTimeout\(connectBondingWS, 5000\)/g, 'setTimeout(connectBondingWS, 60000)');
  patchCount++;
  console.log('[patch] autobuy bonding-smart.js: reconnect delay 5s -> 60s');
} else {
  // Try alternative pattern
  var changed = bs.replace(/setTimeout\(\s*connectWS\s*,\s*5000\s*\)/g, 'setTimeout(connectWS, 60000)');
  if (changed !== bs) {
    bs = changed;
    patchCount++;
    console.log('[patch] autobuy bonding-smart.js: reconnect delay patched (alt pattern)');
  } else {
    console.log('[patch] autobuy bonding-smart.js: reconnect delay already OK or pattern changed');
  }
}

fs.writeFileSync(bsPath, bs);
console.log('[patch] autobuy: ' + patchCount + ' patch(es) applied — starting service...');
