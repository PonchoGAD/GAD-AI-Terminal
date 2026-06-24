/**
 * base-scanner startup patch (v4 — simplified)
 * Patches:
 * 1. Shadow INSERT when AUTO_BUY=false (collect 10 trades to evaluate filters)
 * 2. pendingBuys check (simple Set, no try/finally needed — scanner.ts recentScanned handles the rest)
 * 3. Monitor poll interval 10s → 3s
 */

const fs = require('fs');
let patchCount = 0;

// ── PATCH 1: index.js — shadow mode + basic duplicate guard ─────────────────
const indexPath = '/usr/src/app/services/base-scanner/dist/index.js';
let idx = fs.readFileSync(indexPath, 'utf8');

if (!idx.includes('pendingBuys')) {
  // Add Set after the existing const declarations
  idx = idx.replace(
    'const BUY_FAIL_COOLDOWN_MS = 2 * 60 * 60 * 1000;',
    'const BUY_FAIL_COOLDOWN_MS = 2 * 60 * 60 * 1000;\nconst pendingBuys = new Set(); // duplicate-buy guard'
  );

  // Replace the AUTO_BUY early-return block
  // Original: if (!AUTO_BUY)\n        return;
  // NOTE: Use replacement FUNCTION so $ in replacement strings is literal (not regex special)
  idx = idx.replace(
    /if \(!AUTO_BUY\)\s*return;/,
    function() {
      var lines = [
        'if (!AUTO_BUY) {',
        '        // SHADOW MODE: collect trade signals without executing',
        '        try {',
        "            const _db = require('@lib/db');",
        "            _db.query(",
        "                'INSERT INTO shadow_trades (chain,strategy,symbol,contract_address,entry_price,entry_mcap_usd,filter_params,tp1_target,stop_pct) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING',",
        "                ['base','base_scan',token.symbol,token.contract_address,",
        '                 token.price_eth||0, (token.liquidity_usd||0)*2,',
        "                 JSON.stringify({liq:Math.round(token.liquidity_usd||0),pc1h:token.price_change_1h||0,score:token.safe_score||0}),",
        '                 (token.price_eth||0)*1.25, 8]',
        '            ).catch(function(){});',
        "            console.info('[base-scan] SHADOW would-buy: ' + token.symbol + ' liq:' + Math.round(token.liquidity_usd||0) + ' score:' + (token.safe_score||0));",
        '        } catch(_se) {}',
        '        return;',
        '    }',
        '    // Prevent double-buy when scan cycles overlap',
        '    if (pendingBuys.has(token.contract_address)) { return; }',
        '    pendingBuys.add(token.contract_address);',
        '    setTimeout(function(){ pendingBuys.delete(token.contract_address); }, 120000); // auto-clear 2min',
      ];
      return lines.join('\n');
    }
  );

  fs.writeFileSync(indexPath, idx);
  patchCount++;
  console.log('[patch] base-scanner index.js: shadow mode + pendingBuys applied');
} else {
  console.log('[patch] base-scanner index.js: already patched');
}

// ── PATCH 2: monitor.js — poll interval 10s → 3s ────────────────────────────
const monitorPath = '/usr/src/app/services/base-scanner/dist/monitor.js';
let mon = fs.readFileSync(monitorPath, 'utf8');
if (mon.includes("|| '10000'")) {
  mon = mon.replace("|| '10000'", "|| '3000'");
  fs.writeFileSync(monitorPath, mon);
  patchCount++;
  console.log('[patch] base-scanner monitor.js: poll 10s -> 3s');
} else {
  console.log('[patch] base-scanner monitor.js: already 3s');
}

// NOTE: Impersonator guard (cbXRP/cbADA etc) is now compiled into source — no patch needed.

console.log('[patch] done — ' + patchCount + ' change(s) applied');
