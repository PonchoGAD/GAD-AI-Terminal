"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buyToken = buyToken;
exports.sellToken = sellToken;
exports.getTokenBalance = getTokenBalance;
exports.getEthBalance = getEthBalance;
const ethers_1 = require("ethers");
const provider_1 = require("./provider");
const contracts_1 = require("./contracts");
const quotes_1 = require("./quotes");
const MAX_SLIPPAGE_PCT = Number(process.env.BASE_MAX_SLIPPAGE_PCT || '3');
const GAS_LIMIT_BUY = BigInt(process.env.BASE_GAS_LIMIT_BUY || '350000');
const GAS_LIMIT_SELL = BigInt(process.env.BASE_GAS_LIMIT_SELL || '300000');
// Buy token with ETH
async function buyToken(tokenAddress, ethAmountEth, slippagePct = MAX_SLIPPAGE_PCT) {
    const wallet = (0, provider_1.getWallet)();
    const ethAmountWei = ethers_1.ethers.parseEther(ethAmountEth.toString());
    let quote;
    try {
        quote = await (0, quotes_1.getBestBuyQuote)(tokenAddress, ethAmountWei, slippagePct);
    }
    catch (e) {
        return { ok: false, amount_in: ethAmountEth.toString(), amount_out: '0', dex: 'none', error: e.message };
    }
    try {
        let tx;
        const deadline = BigInt(Math.floor(Date.now() / 1000) + 120);
        if (quote.dex === 'uniswap_v3') {
            const router = new ethers_1.ethers.Contract(contracts_1.ADDRESSES.UNISWAP_V3_ROUTER, contracts_1.UNISWAP_V3_ROUTER_ABI, wallet);
            tx = await router.exactInputSingle({
                tokenIn: contracts_1.ADDRESSES.WETH,
                tokenOut: tokenAddress,
                fee: quote.fee,
                recipient: wallet.address,
                amountIn: ethAmountWei,
                amountOutMinimum: quote.amountOutMin,
                sqrtPriceLimitX96: 0n,
            }, { value: ethAmountWei, gasLimit: GAS_LIMIT_BUY });
        }
        else {
            const router = new ethers_1.ethers.Contract(contracts_1.ADDRESSES.AERODROME_ROUTER, contracts_1.AERODROME_ROUTER_ABI, wallet);
            tx = await router.swapExactETHForTokens(quote.amountOutMin, [{ from: contracts_1.ADDRESSES.WETH, to: tokenAddress, stable: false, factory: contracts_1.ADDRESSES.AERODROME_FACTORY }], wallet.address, deadline, { value: ethAmountWei, gasLimit: GAS_LIMIT_BUY });
        }
        const receipt = await tx.wait(1);
        return {
            ok: true,
            tx_hash: tx.hash,
            amount_in: ethAmountEth.toString(),
            amount_out: quote.amountOut.toString(),
            dex: quote.dex,
        };
    }
    catch (e) {
        return { ok: false, amount_in: ethAmountEth.toString(), amount_out: '0', dex: quote.dex, error: e.message };
    }
}
// Sell token for ETH
async function sellToken(tokenAddress, tokenAmountWei, dex, feeTier = 3000, slippagePct = MAX_SLIPPAGE_PCT) {
    const wallet = (0, provider_1.getWallet)();
    const provider = (0, provider_1.getProvider)();
    // Ensure allowance
    await ensureAllowance(tokenAddress, dex === 'uniswap_v3' ? contracts_1.ADDRESSES.UNISWAP_V3_ROUTER : contracts_1.ADDRESSES.AERODROME_ROUTER, tokenAmountWei);
    try {
        let tx;
        const deadline = BigInt(Math.floor(Date.now() / 1000) + 120);
        const amountOutMin = 0n; // Accept any ETH out (stop-loss sell)
        if (dex === 'uniswap_v3') {
            const router = new ethers_1.ethers.Contract(contracts_1.ADDRESSES.UNISWAP_V3_ROUTER, contracts_1.UNISWAP_V3_ROUTER_ABI, wallet);
            tx = await router.exactInputSingle({
                tokenIn: tokenAddress,
                tokenOut: contracts_1.ADDRESSES.WETH,
                fee: feeTier,
                recipient: wallet.address,
                amountIn: tokenAmountWei,
                amountOutMinimum: amountOutMin,
                sqrtPriceLimitX96: 0n,
            }, { gasLimit: GAS_LIMIT_SELL });
        }
        else {
            const router = new ethers_1.ethers.Contract(contracts_1.ADDRESSES.AERODROME_ROUTER, contracts_1.AERODROME_ROUTER_ABI, wallet);
            tx = await router.swapExactTokensForETH(tokenAmountWei, amountOutMin, [{ from: tokenAddress, to: contracts_1.ADDRESSES.WETH, stable: false, factory: contracts_1.ADDRESSES.AERODROME_FACTORY }], wallet.address, deadline, { gasLimit: GAS_LIMIT_SELL });
        }
        const receipt = await tx.wait(1);
        // Parse ETH received from Transfer events or parse logs
        const ethReceived = await getEthFromReceipt(receipt, wallet.address);
        return {
            ok: true,
            tx_hash: tx.hash,
            amount_in: tokenAmountWei.toString(),
            amount_out: ethers_1.ethers.formatEther(ethReceived),
            dex,
        };
    }
    catch (e) {
        return { ok: false, amount_in: tokenAmountWei.toString(), amount_out: '0', dex, error: e.message };
    }
}
async function ensureAllowance(tokenAddress, spender, amount) {
    const wallet = (0, provider_1.getWallet)();
    const token = new ethers_1.ethers.Contract(tokenAddress, contracts_1.ERC20_ABI, wallet);
    const current = await token.allowance(wallet.address, spender);
    if (current < amount) {
        const tx = await token.approve(spender, ethers_1.ethers.MaxUint256);
        await tx.wait(1);
    }
}
async function getEthFromReceipt(receipt, walletAddress) {
    if (!receipt)
        return 0n;
    // WETH Withdrawal event: 0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c from weth = 0x4200...0006
    const WETH_WITHDRAWAL = '0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7fcf532c';
    // Approximate: estimate from tx value change or just return 0 and let caller recheck balance
    // For simplicity, re-check balance delta
    return 0n; // Caller should check wallet balance delta
}
// Get token balance of wallet
async function getTokenBalance(tokenAddress) {
    const wallet = (0, provider_1.getWallet)();
    const provider = (0, provider_1.getProvider)();
    const token = new ethers_1.ethers.Contract(tokenAddress, contracts_1.ERC20_ABI, provider);
    return await token.balanceOf(wallet.address);
}
// Get ETH balance of wallet
async function getEthBalance() {
    const wallet = (0, provider_1.getWallet)();
    const provider = (0, provider_1.getProvider)();
    const bal = await provider.getBalance(wallet.address);
    return Number(ethers_1.ethers.formatEther(bal));
}
