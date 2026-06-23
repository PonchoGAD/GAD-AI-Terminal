/**
 * base-scanner startup patch
 * Applied on every container start via docker-compose.override.yml
 * Changes survive docker restart AND docker compose up -d (volume mount).
 *
 * Patches applied:
 * 1. pendingBuys mutex — prevent double-buy when scan cycles overlap
 * 2. Monitor poll interval 10s → 3s — catch stop-loss price moves faster
 * 3. Shadow trades INSERT — when AUTO_BUY=false, record WOULD-BUY decisions
 */

const fs = require('fs');

let patchCount = 0;

// ── PATCH 1: pendingBuys mutex ───────────────────────────────────────────────
const indexPath = '/usr/src/app/services/base-scanner/dist/index.js';
let idx = fs.readFileSync(indexPath, 'utf8');

if (!idx.includes('pendingBuys')) {
  // Add Set declaration
  idx = idx.replace(
    'const BUY_FAIL_COOLDOWN_MS = 2 * 60 * 60 * 1000;',
    'const BUY_FAIL_COOLDOWN_MS = 2 * 60 * 60 * 1000;\nconst pendingBuys = new Set();'
  );

  // Add mutex check inside handleNewToken after AUTO_BUY check
  const AUTO_BUY_CHECK = /if \(!AUTO_BUY\)\s*return;/;
  idx = idx.replace(AUTO_BUY_CHECK,
    `if (!AUTO_BUY) {
        // Shadow mode: record WOULD-BUY for analysis (collect 10 trades then evaluate)
        try {
            await require('/usr/src/app/node_modules/@lib/db/dist').query(
                'INSERT INTO shadow_trades (chain,strategy,symbol,contract_address,entry_price,entry_mcap_usd,filter_params,tp1_target,stop_pct) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING',
                ['base','base_scan',token.symbol,token.contract_address,token.price_eth ?? 0,
                 (token.liquidity_usd ?? 0) * 2,
                 JSON.stringify({liq:Math.round(token.liquidity_usd ?? 0),pc1h:token.price_change_1h ?? 0,pc5m:token.price_change_5m ?? 0,score:token.safe_score ?? 0,dex:token.dex_id}),
                 (token.price_eth ?? 0) * 1.25, 8]
            );
            console.info('[base-scanner] 👻 SHADOW: would buy ' + token.symbol + ' | liq:$' + Math.round(token.liquidity_usd ?? 0) + ' score:' + (token.safe_score ?? 0));
        } catch(_se) { console.debug('[base-scanner] shadow err:', _se.message); }
        return;
    }
    if (pendingBuys.has(token.contract_address)) {
        console.debug('[base-scanner] ⏳ ' + token.symbol + ' buy in progress — skip duplicate');
        return;
    }`
  );

  // Find the buy call and wrap in try/finally
  const BUY_START = "console.info(`[base-scanner] 🛒 Buying";
  const FUNC_END  = '// ─── Startup';
  if (idx.includes(BUY_START) && !idx.includes('pendingBuys.add(')) {
    idx = idx.replace(BUY_START, 'pendingBuys.add(token.contract_address);\n    try {\n    ' + BUY_START);
    const insertIdx = idx.indexOf(FUNC_END);
    if (insertIdx > 0) {
      let pos = insertIdx - 1;
      while (pos > 0 && (idx[pos] === '\n' || idx[pos] === '\r' || idx[pos] === ' ')) pos--;
      idx = idx.slice(0, pos + 1) + '\n    } finally {\n        pendingBuys.delete(token.contract_address);\n    }' + idx.slice(pos + 1);
    }
  }

  fs.writeFileSync(indexPath, idx);
  patchCount++;
  console.log('[patch] base-scanner index.js: pendingBuys mutex + shadow mode added');
} else {
  console.log('[patch] base-scanner index.js: already patched');
}

// ── PATCH 2: monitor poll interval 10s → 3s ─────────────────────────────────
const monitorPath = '/usr/src/app/services/base-scanner/dist/monitor.js';
let mon = fs.readFileSync(monitorPath, 'utf8');

if (mon.includes("|| '10000'")) {
  mon = mon.replace("|| '10000'", "|| '3000'");
  fs.writeFileSync(monitorPath, mon);
  patchCount++;
  console.log('[patch] base-scanner monitor.js: poll interval 10s → 3s');
} else {
  console.log('[patch] base-scanner monitor.js: already patched (3s)');
}

console.log('[patch] base-scanner: ' + patchCount + ' patch(es) applied — starting service...');
