"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getBestBuyQuote = getBestBuyQuote;
exports.getTokenPriceEth = getTokenPriceEth;
const ethers_1 = require("ethers");
const axios_1 = __importDefault(require("axios"));
const provider_1 = require("./provider");
const contracts_1 = require("./contracts");
// Get best buy quote: ETH → token
async function getBestBuyQuote(tokenAddress, ethAmountWei, slippagePct = 3) {
    const [uniQuote, aeroQuote] = await Promise.allSettled([
        getUniswapV3Quote(tokenAddress, ethAmountWei),
        getAerodromeQuote(tokenAddress, ethAmountWei),
    ]);
    const quotes = [];
    if (uniQuote.status === 'fulfilled')
        quotes.push(uniQuote.value);
    if (aeroQuote.status === 'fulfilled')
        quotes.push(aeroQuote.value);
    if (!quotes.length)
        throw new Error('No DEX quotes available for ' + tokenAddress);
    // Pick best (highest amountOut)
    const best = quotes.sort((a, b) => (b.amountOut > a.amountOut ? 1 : -1))[0];
    const slippageFactor = BigInt(Math.floor((100 - slippagePct) * 100));
    best.amountOutMin = (best.amountOut * slippageFactor) / 10000n;
    return best;
}
// Uniswap V3 quote via Quoter V2
async function getUniswapV3Quote(tokenAddress, ethAmountWei) {
    const provider = (0, provider_1.getProvider)();
    const quoter = new ethers_1.ethers.Contract(contracts_1.ADDRESSES.UNISWAP_V3_QUOTER, contracts_1.UNISWAP_V3_QUOTER_ABI, provider);
    // Try common fee tiers in order of likelihood for new tokens
    for (const fee of [contracts_1.FEE_TIERS.HIGH, contracts_1.FEE_TIERS.MEDIUM, contracts_1.FEE_TIERS.LOW]) {
        try {
            const result = await quoter.quoteExactInputSingle.staticCall({
                tokenIn: contracts_1.ADDRESSES.WETH,
                tokenOut: tokenAddress,
                amountIn: ethAmountWei,
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
// Aerodrome quote
async function getAerodromeQuote(tokenAddress, ethAmountWei) {
    const provider = (0, provider_1.getProvider)();
    const router = new ethers_1.ethers.Contract(contracts_1.ADDRESSES.AERODROME_ROUTER, contracts_1.AERODROME_ROUTER_ABI, provider);
    const routes = [{ from: contracts_1.ADDRESSES.WETH, to: tokenAddress, stable: false, factory: contracts_1.ADDRESSES.AERODROME_FACTORY }];
    const amounts = await router.getAmountsOut(ethAmountWei, routes);
    if (!amounts || amounts.length < 2)
        throw new Error('Aerodrome: no route');
    return {
        dex: 'aerodrome',
        amountOut: amounts[amounts.length - 1],
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
