"""
Patch v9 (corrected for actual VPS JS state):

State of VPS bonding-smart.js after v8:
- SM column: ALREADY CORRECT (wallet_address AS address) ✅
- logsNotification: STILL uses old 'Program log: dbg:' regex (which never matches!)
- doSell: priorityFee: 0.0005 as literal (not PRIORITY_FEE const)
- monitorPositions: no breakeven stop yet

Changes:
1. Replace dbg: regex with Anchor TradeEvent decoder in logsNotification
2. Add breakeven stop between stop-loss and time-exit in monitorPositions
3. Add dynamic Jito in doSell (0.0012 for emergency, 0.0005 for normal)
"""

with open('/opt/gad-patches/autobuy-dist/bonding-smart.js', 'r') as f:
    content = f.read()

errors = []
applied = []

# ── 1. Add Anchor TradeEvent decoder function ─────────────────────────────────
ANCHOR_FN = r"""
// ── Anchor TradeEvent decoder ────────────────────────────────────────────────
// Decodes pump.fun Anchor events from 'Program data: <base64>' log lines.
// TradeEvent struct: discriminator(8)+mint(32)+solAmount(u64)+tokenAmount(u64)+
//                   isBuy(bool)+user(32)+timestamp(i64)+vSolReserves(u64)+vTokenReserves(u64)
// Min size: 113 bytes. Zero RPC calls — real-time buyer address detection.
function parsePumpAnchorEvent(logLine) {
    try {
        if (!logLine || !logLine.startsWith('Program data: ')) return null;
        const buf = Buffer.from(logLine.slice('Program data: '.length).trim(), 'base64');
        if (buf.length < 113) return null;
        let o = 8; // skip 8-byte Anchor discriminator
        const mintB = buf.slice(o, o + 32); o += 32;
        const solAmount = Number(buf.readBigUInt64LE(o)) / 1e9; o += 8;
        o += 8; // skip tokenAmount
        const isBuy = buf[o] === 1; o += 1;
        const userB = buf.slice(o, o + 32); o += 32;
        o += 8; // skip timestamp
        const vSolReserves = Number(buf.readBigUInt64LE(o)) / 1e9;
        if (mintB.every(b => b === 0) || userB.every(b => b === 0)) return null;
        if (solAmount <= 0 || solAmount > 1000) return null;
        const { PublicKey: _AncPK } = require('@solana/web3.js');
        return {
            mint: new _AncPK(mintB).toBase58(),
            solAmount,
            isBuy,
            buyer: new _AncPK(userB).toBase58(),
            vSolReserves,
        };
    } catch { return null; }
}

"""

if 'function getHeliusWsUrl()' in content:
    content = content.replace('function getHeliusWsUrl()', ANCHOR_FN + 'function getHeliusWsUrl()', 1)
    applied.append('add-anchor-decoder')
else:
    errors.append('getHeliusWsUrl anchor not found')

# ── 2. Replace dbg: regex loop with Anchor decoder in logsNotification ────────
# Current (broken): tries to match "Program log: dbg:" which doesn't exist in pump.fun
# New: parsePumpAnchorEvent on each "Program data: " log line + fallback to signature parse

OLD_DBG_BLOCK = r"""                for (const log of logs) {
                    // Pump.fun debug log: "Program log: dbg: buy/sell, WALLET, SOL_LAMPORTS, ..."
                    const m = log.match(/Program log: dbg:\s+(buy|sell),\s*([1-9A-HJ-NP-Za-km-z]{32,44}),\s*(\d+)/);
                    if (!m) continue;
                    const txType = m[1];
                    const buyer = m[2];
                    const solAmount = Number(m[3]) / 1e9;
                    if (!solAmount || solAmount <= 0 || solAmount > 100) continue;
                    const isBuy = txType === 'buy';
                    const isSmart = smartMoneySet.has(buyer);
                    state.events.push({ ts: Date.now(), solAmount, buyer, isBuy, isSmart });
                    const cutoff = Date.now() - 5 * 60000;
                    state.events = state.events.filter(e => e.ts >= cutoff);
                    if (isSmart) {
                        state.smConfirmations = (state.smConfirmations || 0) + 1;
                        console.info('[bonding-smart] 🔥 Smart Money: ' + buyer.slice(0,8) + ' ' + (isBuy ? 'BUY' : 'SELL') + ' ' + solAmount.toFixed(3) + ' SOL → ' + state.symbol);
                    } else {
                        console.debug('[bonding-smart] 👁️ ' + state.symbol + ' ' + (isBuy ? 'B' : 'S') + ' ' + solAmount.toFixed(3) + ' SOL ' + buyer.slice(0,6));
                    }
                }
                break;"""

NEW_ANCHOR_BLOCK = r"""                // Anchor TradeEvent decoder — decodes 'Program data: <base64>' logs (v9)
                // Gives real buyer address + SOL amount with 0 RPC calls (100% coverage)
                let _anchorParsed = false;
                const _hasPump = logs.some(l => l.includes('6EF8rrecth7ZC6HSZNSVD5nc7KxECunY9gPH37X43gQp'));
                if (_hasPump) {
                    for (const _log of logs) {
                        const _ev = parsePumpAnchorEvent(_log);
                        if (!_ev || _ev.mint !== mint) continue;
                        const _isSmart = smartMoneySet.has(_ev.buyer);
                        state.events.push({ ts: Date.now(), solAmount: _ev.solAmount, buyer: _ev.buyer, isBuy: _ev.isBuy, isSmart: _isSmart });
                        state.events = state.events.filter(e => e.ts >= Date.now() - 5 * 60000);
                        if (_ev.isBuy && _isSmart) {
                            state.smConfirmations = (state.smConfirmations || 0) + 1;
                            console.info('[bonding-smart] 🔥 SM BUY: ' + _ev.buyer.slice(0, 8) + ' ' + _ev.solAmount.toFixed(3) + ' SOL → ' + state.symbol);
                        } else {
                            console.debug('[bonding-smart] 👁️ Trade: ' + state.symbol + ' ' + (_ev.isBuy ? 'BUY' : 'SELL') + ' ' + _ev.solAmount.toFixed(3) + ' SOL | ' + _ev.buyer.slice(0, 6));
                        }
                        if (_ev.vSolReserves > 0) state.vSol = _ev.vSolReserves;
                        _anchorParsed = true;
                        break;
                    }
                }
                // Fallback: use signature to get transaction if Anchor decode failed
                const _sig = value.signature || '';
                if (!_anchorParsed && _sig) {
                    const _isBuy = logs.some(l => l.includes('Instruction: Buy'));
                    const _isSell = logs.some(l => l.includes('Instruction: Sell'));
                    if (_isBuy || _isSell) parseTransactionDebounced(_sig, mint, _isBuy).catch(() => { });
                }
                break;"""

if OLD_DBG_BLOCK in content:
    content = content.replace(OLD_DBG_BLOCK, NEW_ANCHOR_BLOCK, 1)
    applied.append('replace-dbg-regex-with-anchor-decoder')
else:
    errors.append('dbg: regex block not found — check logsNotification handler')

# ── 3. Add Breakeven Stop before time-exit in monitorPositions ────────────────
# If price rose +10% from entry then returned to entry → exit flat (skip -8% SL wait)

STOP_LOSS_ENDING = """        if (!pos.stage1Done && currentPrice < pos.entryPrice * (1 - STOP_PCT)) {
            await doSell(mint, pos.symbol, 100, `stop_loss: -${(100 - mult * 100).toFixed(0)}%`, DUMP_SLIPPAGE_BPS);
            activePositions.delete(mint);
            continue;
        }
        // Time-based exit: volume too low 120s after buy
        if (holdSec > VOLUME_WATCH_SEC) {"""

STOP_LOSS_WITH_BREAKEVEN = """        if (!pos.stage1Done && currentPrice < pos.entryPrice * (1 - STOP_PCT)) {
            await doSell(mint, pos.symbol, 100, `stop_loss: -${(100 - mult * 100).toFixed(0)}%`, DUMP_SLIPPAGE_BPS);
            activePositions.delete(mint);
            continue;
        }
        // Breakeven stop: price rose ≥+10% then returned to entry → exit flat (v9)
        // Avoids holding through -8% stop on "pump and return" pattern
        if (!pos.stage1Done && pos.peakPrice >= pos.entryPrice * 1.10 && currentPrice < pos.entryPrice * 1.01) {
            await doSell(mint, pos.symbol, 100, 'breakeven: peak=' + (pos.peakPrice / pos.entryPrice).toFixed(2) + 'x fell to ' + mult.toFixed(2) + 'x', DUMP_SLIPPAGE_BPS);
            activePositions.delete(mint);
            continue;
        }
        // Time-based exit: volume too low 120s after buy
        if (holdSec > VOLUME_WATCH_SEC) {"""

if STOP_LOSS_ENDING in content:
    content = content.replace(STOP_LOSS_ENDING, STOP_LOSS_WITH_BREAKEVEN, 1)
    applied.append('add-breakeven-stop')
else:
    errors.append('stop-loss+time-exit block not found — check monitorPositions')

# ── 4. Dynamic Jito tip in doSell ─────────────────────────────────────────────
# Sell params block has 'action: sell' + 'priorityFee: 0.0005' as literals
# Add dynamic fee: 0.0012 for emergencies (dump/stop_loss/pre_grad/breakeven)

OLD_SELL_PARAMS = """        const params = {
            publicKey: kp.publicKey.toBase58(),
            action: 'sell',
            mint,
            denominatedInSol: 'false',
            amount: pct === 100 ? '100%' : `${pct}%`,
            slippage: slippage / 100,
            priorityFee: 0.0005,
            pool: 'pump',
        };"""

NEW_SELL_PARAMS = """        // Dynamic Jito: higher fee for emergency exits to beat competing bots (v9)
        const _sellFee = (reason.includes('dump') || reason.includes('stop_loss') ||
            reason.includes('pre_grad') || reason.includes('breakeven')) ? 0.0012 : 0.0005;
        const params = {
            publicKey: kp.publicKey.toBase58(),
            action: 'sell',
            mint,
            denominatedInSol: 'false',
            amount: pct === 100 ? '100%' : `${pct}%`,
            slippage: slippage / 100,
            priorityFee: _sellFee,
            pool: 'pump',
        };"""

if OLD_SELL_PARAMS in content:
    content = content.replace(OLD_SELL_PARAMS, NEW_SELL_PARAMS, 1)
    applied.append('add-dynamic-jito-tip')
else:
    errors.append('doSell params block not found')

# ── Summary ───────────────────────────────────────────────────────────────────
print('✅ Applied:', applied)
if errors:
    print('❌ Errors:', errors)
else:
    print('All patches applied successfully!')

print(f'File size: {len(content)} bytes')

critical = [e for e in errors if 'anchor-decoder' in e or 'dbg: regex' in e]
if critical:
    print('CRITICAL patch failed — NOT saving')
else:
    with open('/opt/gad-patches/autobuy-dist/bonding-smart.js', 'w') as f:
        f.write(content)
    print('✅ File saved!')
