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

// ── PATCH 3: auto-signal.js — fix stale filter values ───────────────────────
const asPath = '/usr/src/app/services/autobuy/dist/auto-signal.js';
let as = fs.readFileSync(asPath, 'utf8');

// Fix FEAR liq floor: 35000 → 25000 (the $27-33k range is profitable per data)
if (as.includes('liq < 35000')) {
  as = as.replace(/liq < 35000/g, 'liq < 25000');
  as = as.replace(/<\s*\$35k floor in FEAR/g, '< $25k floor in FEAR');
  patchCount++;
  console.log('[patch] auto-signal.js: FEAR liq floor 35k → 25k');
} else if (as.includes('liq < 25000')) {
  console.log('[patch] auto-signal.js: FEAR floor already 25k');
} else {
  console.log('[patch] auto-signal.js: FEAR floor pattern not found — check dist');
}

// Fix max liq default: 80000 → 120000 (WOJAK $107k was getting blocked by old 80k cap)
if (as.includes("|| '80000'")) {
  as = as.replace("|| '80000'", "|| '120000'");
  patchCount++;
  console.log('[patch] auto-signal.js: max liq default 80k → 120k');
} else if (as.includes("|| '120000'")) {
  console.log('[patch] auto-signal.js: max liq already 120k');
} else {
  console.log('[patch] auto-signal.js: max liq pattern not found — may be using env override');
}

fs.writeFileSync(asPath, as);

// ── PATCH 4: bonding-smart.js — disable social filter (default now env-driven) ─
// BONDING_SMART_REQUIRE_SOCIAL is false by default in source, but old dist still
// has hardcoded `if (!state.hasTwitter && !state.hasTelegram) return skip(...)`.
// This patch makes it env-controlled so we don't need to rebuild.
if (bs.includes("'no_socials: no Twitter/Telegram'")) {
  bs = bs.replace(
    /if\s*\(!state\.hasTwitter\s*&&\s*!state\.hasTelegram\)\s*return\s+skip\(['"](no_socials[^'"]*)['"]\)/,
    function(m) {
      return 'if ((process.env.BONDING_SMART_REQUIRE_SOCIAL === "true") && !state.hasTwitter && !state.hasTelegram) return skip("no_socials: no Twitter/Telegram")';
    }
  );
  fs.writeFileSync(bsPath, bs);
  patchCount++;
  console.log('[patch] bonding-smart.js: social filter now env-controlled (BONDING_SMART_REQUIRE_SOCIAL)');
} else {
  console.log('[patch] bonding-smart.js: social filter already env-controlled or pattern changed');
}

// ── PATCH 6: graduation-scanner.js — slow down reconnect 15s → 60s ──────────
const gsPath = '/usr/src/app/services/autobuy/dist/graduation-scanner.js';
let gs = fs.readFileSync(gsPath, 'utf8');
if (gs.includes('reconnecting in 15s')) {
  gs = gs.replace(/reconnecting in 15s/g, 'reconnecting in 60s');
  gs = gs.replace(/setTimeout\(connectGradWS,\s*15000\)/g, 'setTimeout(connectGradWS, 60000)');
  // fallback: any 15000 reconnect in this file
  gs = gs.replace(/setTimeout\(\s*function\s*\(\)\s*\{[^}]*connectGradWS[^}]*\},\s*15000\)/g, function(m) {
    return m.replace('15000', '60000');
  });
  fs.writeFileSync(gsPath, gs);
  patchCount++;
  console.log('[patch] graduation-scanner.js: reconnect 15s → 60s');
} else {
  console.log('[patch] graduation-scanner.js: reconnect already OK');
}

console.log('[patch] autobuy: ' + patchCount + ' patch(es) applied — starting service...');
