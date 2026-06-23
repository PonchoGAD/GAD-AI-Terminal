/**
 * base-scanner startup patch (v3)
 * Applied on every container start via docker-compose.override.yml (volume mount).
 * Uses replacement FUNCTION to avoid $ special meaning in String.replace().
 */

const fs = require('fs');
let patchCount = 0;

// ── PATCH 1: pendingBuys mutex + shadow INSERT ────────────────────────────────
const indexPath = '/usr/src/app/services/base-scanner/dist/index.js';
let idx = fs.readFileSync(indexPath, 'utf8');

if (!idx.includes('pendingBuys')) {
  // Add pendingBuys Set declaration
  idx = idx.replace(
    'const BUY_FAIL_COOLDOWN_MS = 2 * 60 * 60 * 1000;',
    'const BUY_FAIL_COOLDOWN_MS = 2 * 60 * 60 * 1000;\nconst pendingBuys = new Set();'
  );

  // Replace the AUTO_BUY early-return with shadow INSERT + pendingBuys check
  // NOTE: Use replacement FUNCTION to prevent $ being interpreted as special pattern
  idx = idx.replace(/if \(!AUTO_BUY\)\s*return;/, function() {
    return [
      'if (!AUTO_BUY) {',
      '        try {',
      "            const _db = require('@lib/db');",
      "            await _db.query(",
      "                'INSERT INTO shadow_trades (chain,strategy,symbol,contract_address,entry_price,entry_mcap_usd,filter_params,tp1_target,stop_pct) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING',",
      "                ['base','base_scan',token.symbol,token.contract_address,token.price_eth||0,",
      '                 (token.liquidity_usd||0)*2,',
      "                 JSON.stringify({liq:Math.round(token.liquidity_usd||0),pc1h:token.price_change_1h||0,score:token.safe_score||0,dex:token.dex_id}),",
      '                 (token.price_eth||0)*1.25, 8]',
      '            );',
      "            console.info('[base-scanner] SHADOW: would buy ' + token.symbol + ' liq:' + Math.round(token.liquidity_usd||0) + ' score:' + (token.safe_score||0));",
      '        } catch(_se) {}',
      '        return;',
      '    }',
      '    if (pendingBuys.has(token.contract_address)) {',
      "        console.debug('[base-scanner] buy in progress — skip duplicate: ' + token.symbol);",
      '        return;',
      '    }',
    ].join('\n');
  });

  // Wrap buy call in try/finally for pendingBuys cleanup
  const BUY_START = "console.info(`[base-scanner] \\uD83D\\uDED2 Buying";
  if (!idx.includes(BUY_START)) {
    // Try with explicit emoji text
    const alternatives = [
      "console.info(`[base-scanner]",
      "buyToken(token.contract_address",
    ];
    for (const alt of alternatives) {
      if (idx.includes(alt)) {
        idx = idx.replace(alt, 'pendingBuys.add(token.contract_address);\n    try {\n    ' + alt);
        break;
      }
    }
  } else {
    idx = idx.replace(BUY_START, 'pendingBuys.add(token.contract_address);\n    try {\n    ' + BUY_START);
  }

  // Add finally block before the Startup comment
  const STARTUP_COMMENT = '// ─── Startup';
  const insertIdx = idx.indexOf(STARTUP_COMMENT);
  if (insertIdx > 0 && !idx.includes('pendingBuys.delete')) {
    let pos = insertIdx - 1;
    while (pos > 0 && (idx[pos] === '\n' || idx[pos] === '\r' || idx[pos] === ' ')) pos--;
    idx = idx.slice(0, pos + 1) +
          '\n    } finally {\n        pendingBuys.delete(token.contract_address);\n    }' +
          idx.slice(pos + 1);
  }

  fs.writeFileSync(indexPath, idx);
  patchCount++;
  console.log('[patch] base-scanner index.js: pendingBuys + shadow INSERT applied');
} else {
  console.log('[patch] base-scanner index.js: already patched');
}

// ── PATCH 2: monitor poll interval 10s → 3s ──────────────────────────────────
const monitorPath = '/usr/src/app/services/base-scanner/dist/monitor.js';
let mon = fs.readFileSync(monitorPath, 'utf8');
if (mon.includes("|| '10000'")) {
  mon = mon.replace("|| '10000'", "|| '3000'");
  fs.writeFileSync(monitorPath, mon);
  patchCount++;
  console.log('[patch] base-scanner monitor.js: poll 10s -> 3s');
} else {
  console.log('[patch] base-scanner monitor.js: already patched');
}

console.log('[patch] base-scanner: ' + patchCount + ' patch(es) — done');
