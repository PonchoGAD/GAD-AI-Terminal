"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CHAIN_CONFIG = void 0;
exports.simulateEvmSwap = simulateEvmSwap;
/**
 * EVM Virtual Swap Simulator
 *
 * Simulates buy→sell round-trip via V2-style router using getAmountsOut
 * (pure view call — no gas, no on-chain state change).
 *
 * Why this beats static API checks:
 *   GoPlus/honeypot.is may have stale data. getAmountsOut replicates what
 *   the actual router contract would return at the current block, exposing:
 *   - Zero liquidity pools (ZERO_BUY_SIMULATION)
 *   - Buy-and-lock honeypots (getAmountsOut succeeds for buy but fails for sell)
 *   - High-tax tokens: round-trip loss >15% = REVERT_DETECTED or HIGH_TAX_ATTACK
 *
 * Supports:
 *   Base: Uniswap V2 router (0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24)
 *   BSC:  PancakeSwap V2   (0x10ED43C718714eb63d5aA57B78B54704E256024E)
 *
 * Max total round-trip tax allowed: MAX_TOTAL_TAX_PCT (default 10%)
 */
const ethers_1 = require("ethers");
const V2_ROUTER_ABI = [
    'function getAmountsOut(uint amountIn, address[] path) public view returns (uint[] memory amounts)',
];
const MAX_TOTAL_TAX_PCT = 10.0; // 15→10: catches hidden 10-15% taxes before GoPlus indexes them
// Network presets — set routerAddress + wethAddress for each chain
exports.CHAIN_CONFIG = {
    // Base mainnet
    8453: {
        routerAddress: '0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24', // Uniswap V2 on Base
        wethAddress: '0x4200000000000000000000000000000000000006', // WETH on Base
    },
    // BSC mainnet
    56: {
        routerAddress: '0x10ED43C718714eb63d5aA57B78B54704E256024E', // PancakeSwap V2
        wethAddress: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', // WBNB
    },
};
// 5-min cache per address+chainId
const _cache = new Map();
const CACHE_TTL = 5 * 60 * 1000;
async function simulateEvmSwap(provider, targetTokenAddress, chainId = 8453, amountInWei = ethers_1.ethers.parseEther('0.001')) {
    const cacheKey = `${chainId}:${targetTokenAddress.toLowerCase()}`;
    const cached = _cache.get(cacheKey);
    if (cached && Date.now() - cached.ts < CACHE_TTL)
        return cached.result;
    const result = await _simulate(provider, targetTokenAddress, chainId, amountInWei);
    _cache.set(cacheKey, { result, ts: Date.now() });
    return result;
}
async function _simulate(provider, targetTokenAddress, chainId, amountInWei) {
    const cfg = exports.CHAIN_CONFIG[chainId];
    if (!cfg) {
        return { canSwap: true, buyTaxPct: 0, sellTaxPct: 0, totalLossPct: 0, reason: 'CHAIN_NOT_CONFIGURED' };
    }
    const router = new ethers_1.ethers.Contract(cfg.routerAddress, V2_ROUTER_ABI, provider);
    const pathBuy = [cfg.wethAddress, targetTokenAddress];
    const pathSell = [targetTokenAddress, cfg.wethAddress];
    try {
        // Step 1: simulate buy
        const buyAmounts = await router.getAmountsOut(amountInWei, pathBuy);
        const tokensReceived = buyAmounts[1];
        if (tokensReceived === 0n) {
            return { canSwap: false, buyTaxPct: 0, sellTaxPct: 0, totalLossPct: 100,
                reason: 'ZERO_BUY_SIMULATION' };
        }
        // Step 2: simulate sell of received tokens
        let ethReturned;
        try {
            const sellAmounts = await router.getAmountsOut(tokensReceived, pathSell);
            ethReturned = sellAmounts[1];
        }
        catch (sellErr) {
            // Sell simulation reverts — classic honeypot (can buy, can't sell)
            return { canSwap: false, buyTaxPct: 0, sellTaxPct: 100, totalLossPct: 100,
                reason: `SELL_REVERT_DETECTED: ${sellErr?.message?.slice(0, 60)}` };
        }
        // Step 3: calculate round-trip loss
        const totalLossPct = (1 - Number(ethReturned) / Number(amountInWei)) * 100;
        const halfLoss = totalLossPct / 2; // approximate buy/sell split
        if (totalLossPct > MAX_TOTAL_TAX_PCT) {
            return { canSwap: false, buyTaxPct: halfLoss, sellTaxPct: halfLoss,
                totalLossPct,
                reason: `HIGH_TAX_DETECTED (${totalLossPct.toFixed(1)}% total)` };
        }
        return { canSwap: true, buyTaxPct: halfLoss, sellTaxPct: halfLoss, totalLossPct };
    }
    catch (err) {
        return { canSwap: false, buyTaxPct: 0, sellTaxPct: 0, totalLossPct: 0,
            reason: `SIMULATION_ERROR: ${err?.message?.slice(0, 80)}` };
    }
}
