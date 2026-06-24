/**
 * ton-scanner startup patch
 * 1. Shadow INSERT into shadow_trades when TON_AUTO_BUY=false
 * 2. Seen-set TTL — clear seen Set every 6h so same tokens can re-appear
 */

const fs = require('fs');
let patchCount = 0;

const scannerPath = '/usr/src/app/services/ton-scanner/dist/scanner.js';
let sc = fs.readFileSync(scannerPath, 'utf8');

// Patch 1: shadow INSERT in dry-run path
const DRY_RUN_LOG = "console.info(`${label} 📡 ${t.symbol} liq:$${t.liquidity_usd.toFixed(0)} pc1h:${t.price_change_1h.toFixed(1)}% (dry-run — TON_AUTO_BUY=false)`);";
const SHADOW_ALREADY = 'INSERT INTO shadow_trades';

if (!sc.includes(SHADOW_ALREADY) && sc.includes(DRY_RUN_LOG)) {
  var shadowBlock = [
    '        try {',
    "            require('@lib/db').query(",
    "                'INSERT INTO shadow_trades (chain,strategy,symbol,contract_address,entry_price,entry_mcap_usd,filter_params,tp1_target,stop_pct) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING',",
    "                ['ton','ton_scan',t.symbol,addr,",
    '                 t.price_ton||0, t.mcap_usd||0,',
    "                 JSON.stringify({liq:Math.round(t.liquidity_usd||0),pc1h:+(t.price_change_1h||0).toFixed(1),safe:0}),",
    '                 (t.price_ton||0)*1.5, 8]',
    '            ).catch(function(){});',
    '        } catch(_se) {}',
  ].join('\n');
  sc = sc.replace(DRY_RUN_LOG, DRY_RUN_LOG + '\n' + shadowBlock);
  patchCount++;
  console.log('[patch] ton-scanner scanner.js: shadow INSERT added to dry-run path');
} else if (sc.includes(SHADOW_ALREADY)) {
  console.log('[patch] ton-scanner scanner.js: shadow INSERT already present');
} else {
  console.log('[patch] ton-scanner scanner.js: dry-run log pattern not found — check dist');
}

// Patch 2: seen-set TTL — clear every 6h to allow re-evaluation of tokens
const SEEN_DECL = 'const seen = new Set();';
const SEEN_ALREADY = 'setInterval(function(){ seen.clear();';

if (sc.includes(SEEN_DECL) && !sc.includes(SEEN_ALREADY)) {
  sc = sc.replace(SEEN_DECL, SEEN_DECL + '\n// Clear seen Set every 6h so tokens get re-evaluated\nsetInterval(function(){ seen.clear(); console.debug("[ton-scan] seen-set cleared (6h TTL)"); }, 6*60*60*1000);');
  patchCount++;
  console.log('[patch] ton-scanner scanner.js: seen-set 6h TTL added');
} else if (sc.includes(SEEN_ALREADY)) {
  console.log('[patch] ton-scanner scanner.js: seen-set TTL already present');
} else {
  console.log('[patch] ton-scanner scanner.js: seen-set pattern not found');
}

fs.writeFileSync(scannerPath, sc);
console.log('[patch] ton-scanner: ' + patchCount + ' patch(es) applied');
