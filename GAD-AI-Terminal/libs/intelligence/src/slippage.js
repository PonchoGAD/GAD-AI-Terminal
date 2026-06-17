"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.analyzeSlippage = analyzeSlippage;
const axios_1 = __importDefault(require("axios"));
const JUPITER_QUOTE = 'https://quote-api.jup.ag/v6/quote';
const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const slippageCache = new Map();
async function simulateJupiterSell(mint, amountUsd, priceUsd) {
    if (priceUsd <= 0)
        return 99;
    // Convert USD to token amount (assuming 6 decimals; will try both)
    const tokenAmount = Math.round((amountUsd / priceUsd) * 1e6);
    if (tokenAmount <= 0)
        return 0;
    try {
        const r = await axios_1.default.get(JUPITER_QUOTE, {
            params: {
                inputMint: mint,
                outputMint: WSOL_MINT,
                amount: tokenAmount,
                slippageBps: 500,
                onlyDirectRoutes: false,
            },
            timeout: 5000,
        });
        const data = r.data;
        if (!data?.outAmount || !data?.inAmount)
            return 50;
        // Price impact in percent
        const priceImpactPct = parseFloat(data.priceImpactPct ?? '0') * 100;
        return Math.round(priceImpactPct * 10) / 10;
    }
    catch {
        return 50; // assume 50% slippage on error = very illiquid
    }
}
async function analyzeSlippage(mint, liquidityUsd, priceUsd) {
    const cached = slippageCache.get(mint);
    if (cached && Date.now() < cached.expires)
        return cached.data;
    // Fast estimate from liquidity (fallback when Jupiter not available)
    const fastEstimate = (usdAmount) => {
        if (liquidityUsd <= 0)
            return 99;
        // Rough AMM impact: impact% ≈ (amount / liquidity) * 100 / 2
        return Math.min(99, Math.round((usdAmount / liquidityUsd) * 50));
    };
    let usd100 = fastEstimate(100);
    let usd500 = fastEstimate(500);
    let usd1000 = fastEstimate(1000);
    let usd5000 = fastEstimate(5000);
    // Try real Jupiter simulation for $1000 to calibrate
    if (priceUsd > 0 && liquidityUsd > 1000) {
        try {
            const real1000 = await simulateJupiterSell(mint, 1000, priceUsd);
            if (real1000 >= 0 && real1000 < 100) {
                // Scale other estimates proportionally
                const ratio = real1000 / (fastEstimate(1000) || 1);
                usd100 = Math.min(99, Math.round(fastEstimate(100) * ratio));
                usd500 = Math.min(99, Math.round(fastEstimate(500) * ratio));
                usd1000 = real1000;
                usd5000 = Math.min(99, Math.round(fastEstimate(5000) * ratio));
            }
        }
        catch { /* use fast estimates */ }
    }
    // Exit score: 100 = no slippage, 0 = extremely illiquid
    const exitScore = Math.max(0, Math.min(100, 100 - usd1000));
    const result = { usd100, usd500, usd1000, usd5000, exitScore };
    slippageCache.set(mint, { data: result, expires: Date.now() + 120000 });
    return result;
}
