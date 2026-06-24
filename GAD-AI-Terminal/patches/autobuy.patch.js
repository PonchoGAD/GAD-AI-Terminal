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
  var dryRunSkip = [
    '        if (process.env.BONDING_SMART_DRY_RUN === "true") {',
    "            console.info('[bonding-smart] 🔲 DRY_RUN: would-buy ' + state.symbol + ' — skipping real buy');",
    '            return;',
    '        }',
  ].join('\n');
  bs = bs.replace(DOBUY_CALL, shadowBlock + '\n' + dryRunSkip + '\n        ' + DOBUY_CALL);
  patchCount++;
  console.log('[patch] autobuy bonding-smart.js: shadow INSERT + DRY_RUN skip added');
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

// Fix FEAR liq floor → 12000 (matches RAYDIUM_MIN_LIQUIDITY_USD=12000 on VPS; 46.2% win rate)
const FEAR_FLOOR_TARGET = 12000;
if (as.includes('liq < ' + FEAR_FLOOR_TARGET)) {
  console.log('[patch] auto-signal.js: FEAR floor already ' + FEAR_FLOOR_TARGET);
} else {
  let _asTmp = as;
  _asTmp = _asTmp.replace(/liq < 35000/g, 'liq < ' + FEAR_FLOOR_TARGET);
  _asTmp = _asTmp.replace(/liq < 25000/g, 'liq < ' + FEAR_FLOOR_TARGET);
  _asTmp = _asTmp.replace(/liq < 15000/g, 'liq < ' + FEAR_FLOOR_TARGET);
  _asTmp = _asTmp.replace(/< \$35k floor in FEAR/g, '< $12k floor in FEAR');
  _asTmp = _asTmp.replace(/< \$25k floor in FEAR/g, '< $12k floor in FEAR');
  _asTmp = _asTmp.replace(/< \$15k floor in FEAR/g, '< $12k floor in FEAR');
  if (_asTmp !== as) {
    as = _asTmp;
    patchCount++;
    console.log('[patch] auto-signal.js: FEAR liq floor → 12k');
  } else {
    console.log('[patch] auto-signal.js: FEAR floor pattern not found — check dist');
  }
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
// Old dist has hardcoded `if (!state.hasTwitter && !state.hasTelegram) return skip(...)`
// This patch makes it env-controlled. Dist message: 'no socials: no Twitter/Telegram in metadata'
const SOCIAL_CONDITION = 'if (!state.hasTwitter && !state.hasTelegram)';
if (bs.includes(SOCIAL_CONDITION) && !bs.includes('BONDING_SMART_REQUIRE_SOCIAL')) {
  bs = bs.replace(
    'if (!state.hasTwitter && !state.hasTelegram)',
    'if ((process.env.BONDING_SMART_REQUIRE_SOCIAL === "true") && !state.hasTwitter && !state.hasTelegram)'
  );
  fs.writeFileSync(bsPath, bs);
  patchCount++;
  console.log('[patch] bonding-smart.js: social filter now env-controlled (BONDING_SMART_REQUIRE_SOCIAL)');
} else if (bs.includes('BONDING_SMART_REQUIRE_SOCIAL')) {
  console.log('[patch] bonding-smart.js: social filter already env-controlled');
} else {
  console.log('[patch] bonding-smart.js: social filter condition not found — check dist');
}

// ── PATCH 5: auto-signal.js — add GeckoTerminal new_pools via proxy ─────────
// Source 6 in compiled dist was removed (PumpSwap Token-2022 issue).
// Re-inject as a DIFFERENT source that only fetches Raydium pools (not PumpSwap).
// Uses RESIDENTIAL_PROXY_URL to bypass VPS IP rate-limit (429 without proxy).
const GECKO_INJECT_MARKER = '// Source 6 (REMOVED)';
const GECKO_ALREADY_MARKER = 'GeckoTerminal_proxy_injected';
if (as.includes(GECKO_INJECT_MARKER) && !as.includes(GECKO_ALREADY_MARKER)) {
  var geckoBlock = [
    '// GeckoTerminal_proxy_injected',
    '// Source 6: GeckoTerminal new Raydium pools via residential proxy',
    'try {',
    '  const _proxyUrl = process.env.RESIDENTIAL_PROXY_URL;',
    '  var _geckoAxiosCfg = { headers: { "Accept": "application/json;version=20230302" }, timeout: 8000 };',
    '  if (_proxyUrl) {',
    '    try {',
    '      const { HttpsProxyAgent } = require("https-proxy-agent");',
    '      _geckoAxiosCfg.httpsAgent = new HttpsProxyAgent(_proxyUrl);',
    '      _geckoAxiosCfg.proxy = false; // use httpsAgent, not axios proxy',
    '    } catch(_pe) { /* https-proxy-agent not available */ }',
    '  }',
    '  for (let _gPage = 1; _gPage <= 3; _gPage++) {',
    '    const _gR = await axios_1.default.get(',
    '      `${GECKO_BASE}/networks/solana/new_pools?page=${_gPage}`,',
    '      _geckoAxiosCfg',
    '    );',
    '    const _gPools = _gR.data?.data ?? [];',
    '    if (!_gPools.length) break;',
    '    let _gAdded = 0;',
    '    for (const _gPool of _gPools) {',
    '      const _gPair = geckoPoolToPair(_gPool);',
    '      if (!_gPair) continue;',
    '      const _gMint = _gPair.baseToken?.address;',
    '      if (!_gMint || seen.has(_gMint)) continue;',
    '      seen.add(_gMint);',
    '      results.push(_gPair);',
    '      _gAdded++;',
    '    }',
    '    if (_gAdded > 0) console.debug(`[raydium-scan] GeckoTerminal proxy new_pools p${_gPage}: ${_gAdded} fresh`);',
    '    await new Promise(_r => setTimeout(_r, 400));',
    '  }',
    '} catch (_gErr) {',
    '  console.debug(`[raydium-scan] GeckoTerminal proxy err: ${_gErr.message?.slice(0,40)}`);',
    '}',
  ].join('\n');
  as = as.replace(GECKO_INJECT_MARKER, geckoBlock + '\n    ' + GECKO_INJECT_MARKER);
  fs.writeFileSync(asPath, as);
  patchCount++;
  console.log('[patch] auto-signal.js: GeckoTerminal proxy Source 6 injected');
} else if (as.includes(GECKO_ALREADY_MARKER)) {
  console.log('[patch] auto-signal.js: GeckoTerminal proxy already injected');
} else {
  console.log('[patch] auto-signal.js: Source 6 marker not found — check dist');
}

// ── PATCH 7: bonding-smart.js — inject HTTP proxy into WebSocket connections ─
// The compiled dist creates ws without proxy. VPS Hetzner IP gets 403 from PumpPortal.
// RESIDENTIAL_PROXY_URL=http://... enables HTTPS CONNECT tunnel (HttpsProxyAgent).
const BS_WS_MARKER = 'ws = new ws_1.default(PUMPPORTAL_WS)';
const BS_WS_PATCHED = 'ws = new ws_1.default(PUMPPORTAL_WS, _bsWsOpts)';
let bsWsPatched = false;
if (bs.includes(BS_WS_MARKER) && !bs.includes(BS_WS_PATCHED) && !bs.includes('_bsWsOpts')) {
  // Inject proxy agent setup before the first connectWS function
  var wsAgentSetup = [
    '// Proxy agent for bonding-smart WebSocket (patched)',
    'var _bsProxyUrl = process.env.RESIDENTIAL_PROXY_URL;',
    'var _bsWsOpts = {};',
    'if (_bsProxyUrl) {',
    '  try {',
    '    const { HttpsProxyAgent } = require("https-proxy-agent");',
    '    _bsWsOpts = { agent: new HttpsProxyAgent(_bsProxyUrl) };',
    '    console.info("[bonding-smart] WebSocket proxy: " + _bsProxyUrl.replace(/:[^@]+@/, ":***@"));',
    '  } catch(_bpe) { console.warn("[bonding-smart] proxy-agent build failed: " + _bpe.message); }',
    '}',
  ].join('\n');
  // Find a stable injection point: after PUMPPORTAL_WS const declaration
  var WS_CONST = "const PUMPPORTAL_WS = 'wss://pumpportal.fun/api/data';";
  if (bs.includes(WS_CONST)) {
    bs = bs.replace(WS_CONST, WS_CONST + '\n' + wsAgentSetup);
    bs = bs.replace(/ws = new ws_1\.default\(PUMPPORTAL_WS\)/g, 'ws = new ws_1.default(PUMPPORTAL_WS, _bsWsOpts)');
    bsWsPatched = true;
  }
  if (bsWsPatched) {
    fs.writeFileSync(bsPath, bs);
    patchCount++;
    console.log('[patch] bonding-smart.js: WebSocket proxy agent injected (HTTP CONNECT tunnel)');
  } else {
    console.log('[patch] bonding-smart.js: WS proxy — PUMPPORTAL_WS const not found');
  }
} else if (bs.includes('_bsWsOpts')) {
  console.log('[patch] bonding-smart.js: WS proxy already patched');
} else {
  console.log('[patch] bonding-smart.js: WS proxy — ws marker not found in dist');
}

// ── PATCH 8: bonding-smart.js — per-token subscribeTokenTrade in handleCreate ─
// ROOT CAUSE of zero shadow trades: ws.send({method:'subscribeTokenTrade', keys:[]})
// at WebSocket open delivers trade events for NO tokens (empty array = no subscriptions).
// New tokens tracked in tokenStates never receive buy/sell events → evaluate() never
// fires → decision.buy never true → zero shadow trades, zero real buys.
// FIX: subscribe to each new token's trades right after tokenStates.set(mint, state).
const PTRADE_MARKER = 'subscribeTokenTrade_per_token_patched';
const PTRADE_ANCHOR = 'tokenStates.set(mint, state);';
if (!bs.includes(PTRADE_MARKER) && bs.includes(PTRADE_ANCHOR)) {
  var perTokenSub = [
    '    // PATCH 8: per-token trade subscribe',
    '    // subscribeTokenTrade: [] delivers no events — must subscribe per-mint',
    '    // ' + PTRADE_MARKER,
    '    if (ws && ws.readyState === 1) {',
    "        ws.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: [mint] }));",
    '    }',
  ].join('\n');
  bs = bs.replace(PTRADE_ANCHOR, PTRADE_ANCHOR + '\n' + perTokenSub);
  fs.writeFileSync(bsPath, bs);
  patchCount++;
  console.log('[patch] bonding-smart.js: PATCH 8 — per-token subscribeTokenTrade in handleCreate (root cause of zero shadow trades FIXED)');
} else if (bs.includes(PTRADE_MARKER)) {
  console.log('[patch] bonding-smart.js: per-token subscribe already patched');
} else {
  console.log('[patch] bonding-smart.js: ANCHOR not found in compiled dist — check bonding-smart.js');
}

// ── PATCH 9: bonding-smart.js — skip reason debug log in handleTrade ─────────
// Logs why each token was rejected, so we can tune thresholds from real data
const SKIP_LOG_MARKER = 'bonding_smart_skip_debug_patched';
const SKIP_LOG_ANCHOR = 'const decision = await shouldBuy(state);';
if (!bs.includes(SKIP_LOG_MARKER) && bs.includes(SKIP_LOG_ANCHOR)) {
  var skipLogInject = [
    '    // PATCH 9: log skip reason for tuning',
    '    // ' + SKIP_LOG_MARKER,
    "    if (!decision.buy) console.debug('[bonding-smart] ❌ ' + state.symbol + ' skip: ' + decision.reason);",
  ].join('\n');
  bs = bs.replace(SKIP_LOG_ANCHOR, SKIP_LOG_ANCHOR + '\n' + skipLogInject);
  fs.writeFileSync(bsPath, bs);
  patchCount++;
  console.log('[patch] bonding-smart.js: PATCH 9 — skip reason debug log added');
} else if (bs.includes(SKIP_LOG_MARKER)) {
  console.log('[patch] bonding-smart.js: skip reason log already present');
} else {
  console.log('[patch] bonding-smart.js: shouldBuy anchor not found — check compiled dist');
}

// ── PATCH 10: bonding-smart.js — WS event counter (30s window, debug) ────────
// Confirms whether buy/sell events are arriving at all from PumpPortal WS
// FIX: counter code injected AFTER const ev declaration to avoid ReferenceError
const WS_CTR_MARKER = 'bonding_smart_ws_counter_patched';
// Use the routing line as anchor (AFTER ev is declared)
const WS_CTR_ANCHOR2 = "if (ev.txType === 'create') {";
if (!bs.includes(WS_CTR_MARKER) && bs.includes(WS_CTR_ANCHOR2)) {
  var wsCounter = [
    '            // PATCH 10: ' + WS_CTR_MARKER,
    '            // Counter injected AFTER ev declaration to avoid ReferenceError',
    '            if (!global._bsWsCtr) {',
    '                global._bsWsCtr = { create: 0, buy: 0, sell: 0, other: 0 };',
    '                setInterval(function() {',
    "                    console.info('[bonding-smart] WS 30s: create=' + global._bsWsCtr.create + ' buy=' + global._bsWsCtr.buy + ' sell=' + global._bsWsCtr.sell);",
    '                    global._bsWsCtr = { create: 0, buy: 0, sell: 0, other: 0 };',
    '                }, 30000);',
    '            }',
    "            if (ev.txType === 'create') global._bsWsCtr.create++;",
    "            else if (ev.txType === 'buy') global._bsWsCtr.buy++;",
    "            else if (ev.txType === 'sell') global._bsWsCtr.sell++;",
  ].join('\n');
  bs = bs.replace(WS_CTR_ANCHOR2, wsCounter + '\n            ' + WS_CTR_ANCHOR2);
  fs.writeFileSync(bsPath, bs);
  patchCount++;
  console.log('[patch] bonding-smart.js: PATCH 10 — WS event counter added (30s interval, after ev decl)');
} else if (bs.includes(WS_CTR_MARKER)) {
  console.log('[patch] bonding-smart.js: WS counter already patched');
} else {
  console.log('[patch] bonding-smart.js: WS counter anchor not found — check compiled dist');
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
