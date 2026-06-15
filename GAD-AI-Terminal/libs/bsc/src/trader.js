"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getBnbToTokenQuote = getBnbToTokenQuote;
exports.buyBscToken = buyBscToken;
exports.sellBscToken = sellBscToken;
exports.getBnbBalance = getBnbBalance;
exports.getBscTokenBalance = getBscTokenBalance;
const ethers_1 = require("ethers");
const provider_1 = require("./provider");
const contracts_1 = require("./contracts");
const GAS_PRICE_GWEI = Number(process.env.BSC_GAS_PRICE_GWEI || '3');
const GAS_PRICE_FAST = Number(process.env.BSC_GAS_PRICE_FAST || '5');
const GAS_LIMIT_BUY = BigInt(process.env.BSC_GAS_LIMIT_BUY || '350000');
const GAS_LIMIT_SELL = BigInt(process.env.BSC_GAS_LIMIT_SELL || '300000');
// Get expected token output for a given BNB input (PancakeSwap V2 constant product)
async function getBnbToTokenQuote(tokenAddress, bnbAmountWei) {
    const provider = (0, provider_1.getProvider)();
    const router = new ethers_1.ethers.Contract(contracts_1.ADDRESSES.PANCAKESWAP_ROUTER_V2, contracts_1.PANCAKE_ROUTER_ABI, provider);
    const amounts = await router.getAmountsOut(bnbAmountWei, [contracts_1.ADDRESSES.WBNB, tokenAddress]);
    const amountOut = amounts[1];
    const amountOutMin = amountOut * 95n / 100n; // 5% slippage default
    return { amountOut, amountOutMin };
}
// Buy token with BNB via PancakeSwap V2
// Uses SupportingFeeOnTransferTokens — mandatory for BSC tokens with transfer taxes
async function buyBscToken(tokenAddress, bnbAmountBnb, slippagePct = 5, fastGas = false) {
    const wallet = (0, provider_1.getWallet)();
    const bnbAmountWei = ethers_1.ethers.parseEther(bnbAmountBnb.toString());
    const router = new ethers_1.ethers.Contract(contracts_1.ADDRESSES.PANCAKESWAP_ROUTER_V2, contracts_1.PANCAKE_ROUTER_ABI, wallet);
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 1200); // 20 min
    const gasPrice = ethers_1.ethers.parseUnits(String(fastGas ? GAS_PRICE_FAST : GAS_PRICE_GWEI), 'gwei');
    let amountOutMin;
    try {
        const quote = await getBnbToTokenQuote(tokenAddress, bnbAmountWei);
        // Apply slippage — for tokens with buy tax, account for tax in slippage
        const slippageFactor = BigInt(Math.floor((100 - slippagePct) * 100));
        amountOutMin = (quote.amountOut * slippageFactor) / 10000n;
    }
    catch (e) {
        return { ok: false, amount_in: bnbAmountBnb.toString(), amount_out: '0', dex: 'pancakeswap_v2', error: `Quote failed: ${e.message}` };
    }
    try {
        const bnbBefore = await (0, provider_1.getProvider)().getBalance(wallet.address);
        const tx = await router.swapExactETHForTokensSupportingFeeOnTransferTokens(amountOutMin, [contracts_1.ADDRESSES.WBNB, tokenAddress], wallet.address, deadline, { value: bnbAmountWei, gasLimit: GAS_LIMIT_BUY, gasPrice });
        const receipt = await tx.wait(1);
        // Get actual token balance received (fee tokens reduce received amount)
        const token = new ethers_1.ethers.Contract(tokenAddress, contracts_1.ERC20_ABI, (0, provider_1.getProvider)());
        const balance = await token.balanceOf(wallet.address);
        console.info(`[bsc-trade] ✅ BUY ${tokenAddress.slice(0, 8)} ${bnbAmountBnb} BNB → ${ethers_1.ethers.formatUnits(balance, 18)} tokens tx:${tx.hash.slice(0, 12)}`);
        return {
            ok: true,
            tx_hash: tx.hash,
            amount_in: bnbAmountBnb.toString(),
            amount_out: balance.toString(),
            dex: 'pancakeswap_v2',
        };
    }
    catch (e) {
        const reason = e.reason ?? e.shortMessage ?? e.message?.slice(0, 120) ?? 'unknown';
        console.error(`[bsc-trade] ❌ BUY FAILED ${tokenAddress.slice(0, 8)}: ${reason}`);
        return { ok: false, amount_in: bnbAmountBnb.toString(), amount_out: '0', dex: 'pancakeswap_v2', error: reason };
    }
}
// Sell token for BNB via PancakeSwap V2
// Uses SupportingFeeOnTransferTokens — handles sell tax tokens without reverting
// amountOutMin=0n for forced exits (stop-loss/time-limit) — accept any price
async function sellBscToken(tokenAddress, tokenAmountWei, slippagePct = 0, fastGas = true) {
    const wallet = (0, provider_1.getWallet)();
    const provider = (0, provider_1.getProvider)();
    const router = new ethers_1.ethers.Contract(contracts_1.ADDRESSES.PANCAKESWAP_ROUTER_V2, contracts_1.PANCAKE_ROUTER_ABI, wallet);
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 1200);
    const gasPrice = ethers_1.ethers.parseUnits(String(fastGas ? GAS_PRICE_FAST : GAS_PRICE_GWEI), 'gwei');
    // Ensure router is approved to spend tokens
    await ensureAllowance(tokenAddress, contracts_1.ADDRESSES.PANCAKESWAP_ROUTER_V2, tokenAmountWei);
    // Calculate min BNB out (0 for forced exits)
    let amountOutMin = 0n;
    if (slippagePct > 0) {
        try {
            const r = new ethers_1.ethers.Contract(contracts_1.ADDRESSES.PANCAKESWAP_ROUTER_V2, contracts_1.PANCAKE_ROUTER_ABI, provider);
            const amounts = await r.getAmountsOut(tokenAmountWei, [tokenAddress, contracts_1.ADDRESSES.WBNB]);
            const slippageFactor = BigInt(Math.floor((100 - slippagePct) * 100));
            amountOutMin = (amounts[1] * slippageFactor) / 10000n;
        }
        catch { /* use 0 if quote fails */ }
    }
    try {
        const bnbBefore = await provider.getBalance(wallet.address);
        const tx = await router.swapExactTokensForETHSupportingFeeOnTransferTokens(tokenAmountWei, amountOutMin, [tokenAddress, contracts_1.ADDRESSES.WBNB], wallet.address, deadline, { gasLimit: GAS_LIMIT_SELL, gasPrice });
        await tx.wait(1);
        const bnbAfter = await provider.getBalance(wallet.address);
        const bnbReceived = bnbAfter > bnbBefore ? bnbAfter - bnbBefore : 0n;
        console.info(`[bsc-trade] ✅ SELL ${tokenAddress.slice(0, 8)} → ${ethers_1.ethers.formatEther(bnbReceived)} BNB tx:${tx.hash.slice(0, 12)}`);
        return {
            ok: true,
            tx_hash: tx.hash,
            amount_in: tokenAmountWei.toString(),
            amount_out: ethers_1.ethers.formatEther(bnbReceived),
            dex: 'pancakeswap_v2',
        };
    }
    catch (e) {
        const reason = e.reason ?? e.shortMessage ?? e.message?.slice(0, 120) ?? 'unknown';
        console.error(`[bsc-trade] ❌ SELL FAILED ${tokenAddress.slice(0, 8)}: ${reason}`);
        return { ok: false, amount_in: tokenAmountWei.toString(), amount_out: '0', dex: 'pancakeswap_v2', error: reason };
    }
}
async function ensureAllowance(tokenAddress, spender, amount) {
    const wallet = (0, provider_1.getWallet)();
    const token = new ethers_1.ethers.Contract(tokenAddress, contracts_1.ERC20_ABI, wallet);
    const current = await token.allowance(wallet.address, spender);
    if (current < amount) {
        const tx = await token.approve(spender, ethers_1.ethers.MaxUint256);
        await tx.wait(1);
        console.debug(`[bsc-trade] Approved ${tokenAddress.slice(0, 8)} for PancakeSwap`);
    }
}
async function getBnbBalance() {
    const wallet = (0, provider_1.getWallet)();
    const provider = (0, provider_1.getProvider)();
    const bal = await provider.getBalance(wallet.address);
    return Number(ethers_1.ethers.formatEther(bal));
}
async function getBscTokenBalance(tokenAddress) {
    const wallet = (0, provider_1.getWallet)();
    const provider = (0, provider_1.getProvider)();
    const token = new ethers_1.ethers.Contract(tokenAddress, contracts_1.ERC20_ABI, provider);
    return await token.balanceOf(wallet.address);
}
