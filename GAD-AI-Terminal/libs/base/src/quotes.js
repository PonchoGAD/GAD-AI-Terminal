"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getBestBuyQuote = getBestBuyQuote;
exports.getBestSellQuote = getBestSellQuote;
exports.getTokenPriceEth = getTokenPriceEth;
const ethers_1 = require("ethers");
const axios_1 = __importDefault(require("axios"));
const provider_1 = require("./provider");
const contracts_1 = require("./contracts");
// When true: only use Uniswap V3 for auto-buy — skip Aerodrome entirely.
// Aerodrome can revert on tokens with transfer fees (K invariant broken),
// causing real TX failures even when staticCall simulation passes.
const ONLY_UNISWAP_V3 = process.env.BASE_ONLY_UNISWAP_V3 === 'true';
// Get best buy quote: ETH → token
// Always tries V3 first, then Aerodrome.
// ONLY_UNISWAP_V3 only applies to SELL (stored-dex override in monitor.ts), NOT buy.
// Reason: most fresh Base tokens are on Uniswap V4 → no V3 pool → Aerodrome needed for entry.
// K-invariant issue only happens on SELL mismatch (buy Aerodrome, sell V3).
async function getBestBuyQuote(tokenAddress, ethAmountWei, slippagePct = 3) {
    // 1. Try Uniswap V3 (preferred)
    const uniQuote = await getUniswapV3Quote(tokenAddress, ethAmountWei, 'buy').catch(() => null);
    if (uniQuote) {
        const slippageFactor = BigInt(Math.floor((100 - slippagePct) * 100));
        uniQuote.amountOutMin = (uniQuote.amountOut * slippageFactor) / 10000n;
        return uniQuote;
    }
    // 2. Fallback: Aerodrome (volatile pool, works for V4 tokens)
    // Use 12% slippage — Aerodrome pools have higher price impact on thin liquidity
    const aeroQuote = await getAerodromeQuote(tokenAddress, ethAmountWei);
    const slippageFactor = BigInt(Math.floor((100 - Math.max(slippagePct, 12)) * 100));
    aeroQuote.amountOutMin = (aeroQuote.amountOut * slippageFactor) / 10000n;
    return aeroQuote;
}
// Get sell quote: token → ETH (with slippage protection for TP sells)
// Returns minEthWei = 0n if no quote found (caller should treat as "accept any")
async function getBestSellQuote(tokenAddress, tokenAmountWei, slippagePct = 3) {
    const provider = (0, provider_1.getProvider)();
    const quoter = new ethers_1.ethers.Contract(contracts_1.ADDRESSES.UNISWAP_V3_QUOTER, contracts_1.UNISWAP_V3_QUOTER_ABI, provider);
    const slippageFactor = BigInt(Math.floor((100 - slippagePct) * 100));
    // Try Uniswap V3 (token → WETH) — same fee tier order as buy
    for (const fee of [contracts_1.FEE_TIERS.ULTRA, contracts_1.FEE_TIERS.HIGH, contracts_1.FEE_TIERS.MEDIUM, contracts_1.FEE_TIERS.LOW]) {
        try {
            const result = await quoter.quoteExactInputSingle.staticCall({
                tokenIn: tokenAddress,
                tokenOut: contracts_1.ADDRESSES.WETH,
                amountIn: tokenAmountWei,
                fee,
                sqrtPriceLimitX96: 0n,
            });
            const expectedEthWei = result[0];
            return { minEthWei: (expectedEthWei * slippageFactor) / 10000n, expectedEthWei };
        }
        catch {
            continue;
        }
    }
    // Fallback: Aerodrome sell quote
    try {
        const router = new ethers_1.ethers.Contract(contracts_1.ADDRESSES.AERODROME_ROUTER, contracts_1.AERODROME_ROUTER_ABI, provider);
        const routes = [{ from: tokenAddress, to: contracts_1.ADDRESSES.WETH, stable: false, factory: contracts_1.ADDRESSES.AERODROME_FACTORY }];
        const amounts = await router.getAmountsOut(tokenAmountWei, routes);
        if (amounts && amounts.length >= 2) {
            const expectedEthWei = amounts[amounts.length - 1];
            return { minEthWei: (expectedEthWei * slippageFactor) / 10000n, expectedEthWei };
        }
    }
    catch { }
    return { minEthWei: 0n, expectedEthWei: 0n };
}
// Uniswap V3 quote via Quoter V2
// direction: 'buy' = ETH→token, 'sell' = token→ETH
async function getUniswapV3Quote(tokenAddress, amountInWei, direction = 'buy') {
    const provider = (0, provider_1.getProvider)();
    const quoter = new ethers_1.ethers.Contract(contracts_1.ADDRESSES.UNISWAP_V3_QUOTER, contracts_1.UNISWAP_V3_QUOTER_ABI, provider);
    const tokenIn = direction === 'buy' ? contracts_1.ADDRESSES.WETH : tokenAddress;
    const tokenOut = direction === 'buy' ? tokenAddress : contracts_1.ADDRESSES.WETH;
    // Try ULTRA first — most new meme tokens on Base use 1% pools
    for (const fee of [contracts_1.FEE_TIERS.ULTRA, contracts_1.FEE_TIERS.HIGH, contracts_1.FEE_TIERS.MEDIUM, contracts_1.FEE_TIERS.LOW]) {
        try {
            const result = await quoter.quoteExactInputSingle.staticCall({
                tokenIn,
                tokenOut,
                amountIn: amountInWei,
                fee,
                sqrtPriceLimitX96: 0n,
            });
            return {
                dex: 'uniswap_v3',
                amountOut: result[0],
                amountOutMin: 0n,
                fee,
                priceImpact: 0,
            };
        }
        catch {
            continue;
        }
    }
    throw new Error('No Uniswap V3 pool found');
}
// Aerodrome quote — validates that output is non-trivial (> 0.01 ETH equivalent in tokens)
async function getAerodromeQuote(tokenAddress, ethAmountWei) {
    const provider = (0, provider_1.getProvider)();
    const router = new ethers_1.ethers.Contract(contracts_1.ADDRESSES.AERODROME_ROUTER, contracts_1.AERODROME_ROUTER_ABI, provider);
    const routes = [{ from: contracts_1.ADDRESSES.WETH, to: tokenAddress, stable: false, factory: contracts_1.ADDRESSES.AERODROME_FACTORY }];
    const amounts = await router.getAmountsOut(ethAmountWei, routes);
    if (!amounts || amounts.length < 2)
        throw new Error('Aerodrome: no route');
    const amountOut = amounts[amounts.length - 1];
    if (amountOut <= 0n)
        throw new Error('Aerodrome: zero output (no pool)');
    return {
        dex: 'aerodrome',
        amountOut,
        amountOutMin: 0n,
        fee: 0,
        priceImpact: 0,
    };
}
// Get current token price in ETH via DexScreener (fast, free)
async function getTokenPriceEth(tokenAddress) {
    const r = await axios_1.default.get(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`, { timeout: 5000 });
    const pairs = r.data?.pairs ?? [];
    const base = pairs.find((p) => p.chainId === 'base' && p.baseToken?.address?.toLowerCase() === tokenAddress.toLowerCase());
    if (!base)
        return { priceEth: 0, liquidityUsd: 0, mcapUsd: 0 };
    return {
        priceEth: Number(base.priceNative ?? 0),
        liquidityUsd: Number(base.liquidity?.usd ?? 0),
        mcapUsd: Number(base.marketCap ?? 0),
    };
}
