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
// keccak256("Withdrawal(address,uint256)") — WETH unwrap event emitted during token→ETH swaps
const WETH_WITHDRAWAL_TOPIC = ethers_1.ethers.id('Withdrawal(address,uint256)');
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
            const params = {
                tokenIn: contracts_1.ADDRESSES.WETH,
                tokenOut: tokenAddress,
                fee: quote.fee,
                recipient: wallet.address,
                amountIn: ethAmountWei,
                amountOutMinimum: quote.amountOutMin,
                sqrtPriceLimitX96: 0n,
            };
            // Simulate first — catches reverts before wasting gas
            await router.exactInputSingle.staticCall(params, { value: ethAmountWei });
            tx = await router.exactInputSingle(params, { value: ethAmountWei, gasLimit: GAS_LIMIT_BUY });
        }
        else {
            const router = new ethers_1.ethers.Contract(contracts_1.ADDRESSES.AERODROME_ROUTER, contracts_1.AERODROME_ROUTER_ABI, wallet);
            const routes = [{ from: contracts_1.ADDRESSES.WETH, to: tokenAddress, stable: false, factory: contracts_1.ADDRESSES.AERODROME_FACTORY }];
            // Simulate first — Aerodrome reverts often on thin pools
            await router.swapExactETHForTokens.staticCall(quote.amountOutMin, routes, wallet.address, deadline, { value: ethAmountWei });
            tx = await router.swapExactETHForTokens(quote.amountOutMin, routes, wallet.address, deadline, { value: ethAmountWei, gasLimit: GAS_LIMIT_BUY });
        }
        await tx.wait(1);
        return {
            ok: true,
            tx_hash: tx.hash,
            amount_in: ethAmountEth.toString(),
            amount_out: quote.amountOut.toString(),
            dex: quote.dex,
            fee_tier: quote.fee,
        };
    }
    catch (e) {
        // Decode revert reason if available
        const reason = e.reason ?? e.shortMessage ?? e.message?.slice(0, 120) ?? 'unknown';
        return { ok: false, amount_in: ethAmountEth.toString(), amount_out: '0', dex: quote.dex, error: reason };
    }
}
// Sell token for ETH
// slippagePct=0 → amountOutMin=0n (use for stop-loss/time-limit: must exit at any price)
// slippagePct>0 → get sell quote and enforce min ETH out (use for TP sells: MEV protection)
async function sellToken(tokenAddress, tokenAmountWei, dex, feeTier = 3000, slippagePct = 0) {
    const wallet = (0, provider_1.getWallet)();
    // Ensure allowance
    await ensureAllowance(tokenAddress, dex === 'uniswap_v3' ? contracts_1.ADDRESSES.UNISWAP_V3_ROUTER : contracts_1.ADDRESSES.AERODROME_ROUTER, tokenAmountWei);
    // Compute amountOutMin for slippage protection on TP sells
    let amountOutMin = 0n;
    if (slippagePct > 0) {
        const sellQuote = await (0, quotes_1.getBestSellQuote)(tokenAddress, tokenAmountWei, slippagePct).catch(() => ({ minEthWei: 0n, expectedEthWei: 0n }));
        amountOutMin = sellQuote.minEthWei;
    }
    try {
        let tx;
        const deadline = BigInt(Math.floor(Date.now() / 1000) + 120);
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
        // Parse ETH received from WETH Withdrawal event in receipt
        const ethReceived = getEthFromReceipt(receipt);
        return {
            ok: true,
            tx_hash: tx.hash,
            amount_in: tokenAmountWei.toString(),
            amount_out: ethers_1.ethers.formatEther(ethReceived),
            dex,
            fee_tier: feeTier,
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
// Parse ETH received from WETH Withdrawal(address indexed src, uint256 wad) events.
// Uniswap V3 router unwraps WETH → ETH and emits Withdrawal from the WETH contract.
// monitor.ts also uses balance delta as primary source; this is used for logging in TradeResult.
function getEthFromReceipt(receipt) {
    if (!receipt)
        return 0n;
    let total = 0n;
    for (const log of receipt.logs) {
        if (log.address.toLowerCase() === contracts_1.ADDRESSES.WETH.toLowerCase() &&
            log.topics[0] === WETH_WITHDRAWAL_TOPIC) {
            // data = wad (uint256 ETH amount in wei)
            try {
                total += BigInt(log.data);
            }
            catch { }
        }
    }
    return total;
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
