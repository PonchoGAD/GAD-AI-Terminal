import { ethers } from 'ethers';
import { getWallet, getProvider } from './provider';
import { ADDRESSES, PANCAKE_ROUTER_ABI, ERC20_ABI } from './contracts';

const GAS_LIMIT_BUY   = BigInt(process.env.BSC_GAS_LIMIT_BUY   || '350000');
const GAS_LIMIT_SELL  = BigInt(process.env.BSC_GAS_LIMIT_SELL  || '300000');
// Extra Gwei added on top of network median to skip the sandwich bot queue.
// Sandwich bots read the mempool and front-run at exactly networkGas+0.1 Gwei.
// Adding 1.5 Gwei places our TX ahead of the typical sandwich window.
const SANDWICH_BUMP_GWEI = Number(process.env.BSC_SANDWICH_BUMP_GWEI || '1.5');
const GAS_FALLBACK_GWEI  = Number(process.env.BSC_GAS_FALLBACK_GWEI  || '4.5');

// Fetch live network gas price and add SANDWICH_BUMP_GWEI to defeat front-runners.
// Falls back to GAS_FALLBACK_GWEI if RPC is unavailable.
export async function getBscSecureGasPrice(): Promise<bigint> {
  try {
    const feeData    = await getProvider().getFeeData();
    const networkGas = feeData.gasPrice ?? ethers.parseUnits(String(GAS_FALLBACK_GWEI - SANDWICH_BUMP_GWEI), 'gwei');
    const secureGas  = networkGas + ethers.parseUnits(String(SANDWICH_BUMP_GWEI), 'gwei');
    console.debug(`[bsc-gas] network:${ethers.formatUnits(networkGas, 'gwei')}gwei + bump:${SANDWICH_BUMP_GWEI}gwei = ${ethers.formatUnits(secureGas, 'gwei')}gwei`);
    return secureGas;
  } catch {
    return ethers.parseUnits(String(GAS_FALLBACK_GWEI), 'gwei');
  }
}

export interface BscTradeResult {
  ok:         boolean;
  tx_hash?:   string;
  amount_in:  string;
  amount_out: string;  // tokens (buy) | BNB (sell)
  dex:        string;
  error?:     string;
}

// Get expected token output for a given BNB input (PancakeSwap V2 constant product)
export async function getBnbToTokenQuote(
  tokenAddress: string,
  bnbAmountWei: bigint
): Promise<{ amountOut: bigint; amountOutMin: bigint }> {
  const provider = getProvider();
  const router   = new ethers.Contract(ADDRESSES.PANCAKESWAP_ROUTER_V2, PANCAKE_ROUTER_ABI, provider);
  const amounts: bigint[] = await router.getAmountsOut(bnbAmountWei, [ADDRESSES.WBNB, tokenAddress]);
  const amountOut = amounts[1];
  const amountOutMin = amountOut * 95n / 100n; // 5% slippage default
  return { amountOut, amountOutMin };
}

// Buy token with BNB via PancakeSwap V2
// Uses SupportingFeeOnTransferTokens — mandatory for BSC tokens with transfer taxes
export async function buyBscToken(
  tokenAddress: string,
  bnbAmountBnb: number,
  slippagePct = 5,
  fastGas = false
): Promise<BscTradeResult> {
  const wallet       = getWallet();
  const bnbAmountWei = ethers.parseEther(bnbAmountBnb.toString());
  const router       = new ethers.Contract(ADDRESSES.PANCAKESWAP_ROUTER_V2, PANCAKE_ROUTER_ABI, wallet);
  const deadline     = BigInt(Math.floor(Date.now() / 1000) + 1200); // 20 min
  const gasPrice     = await getBscSecureGasPrice();

  let amountOutMin: bigint;
  try {
    const quote = await getBnbToTokenQuote(tokenAddress, bnbAmountWei);
    // Apply slippage — for tokens with buy tax, account for tax in slippage
    const slippageFactor = BigInt(Math.floor((100 - slippagePct) * 100));
    amountOutMin = (quote.amountOut * slippageFactor) / 10000n;
  } catch (e: any) {
    return { ok: false, amount_in: bnbAmountBnb.toString(), amount_out: '0', dex: 'pancakeswap_v2', error: `Quote failed: ${e.message}` };
  }

  try {
    const bnbBefore = await getProvider().getBalance(wallet.address);

    const tx = await router.swapExactETHForTokensSupportingFeeOnTransferTokens(
      amountOutMin,
      [ADDRESSES.WBNB, tokenAddress],
      wallet.address,
      deadline,
      { value: bnbAmountWei, gasLimit: GAS_LIMIT_BUY, gasPrice }
    );
    const receipt = await tx.wait(1);

    // Get actual token balance received (fee tokens reduce received amount)
    const token   = new ethers.Contract(tokenAddress, ERC20_ABI, getProvider());
    const balance = await token.balanceOf(wallet.address);

    console.info(`[bsc-trade] ✅ BUY ${tokenAddress.slice(0,8)} ${bnbAmountBnb} BNB → ${ethers.formatUnits(balance, 18)} tokens tx:${tx.hash.slice(0,12)}`);
    return {
      ok:         true,
      tx_hash:    tx.hash,
      amount_in:  bnbAmountBnb.toString(),
      amount_out: balance.toString(),
      dex:        'pancakeswap_v2',
    };
  } catch (e: any) {
    const reason = e.reason ?? e.shortMessage ?? e.message?.slice(0, 120) ?? 'unknown';
    console.error(`[bsc-trade] ❌ BUY FAILED ${tokenAddress.slice(0,8)}: ${reason}`);
    return { ok: false, amount_in: bnbAmountBnb.toString(), amount_out: '0', dex: 'pancakeswap_v2', error: reason };
  }
}

// Sell token for BNB via PancakeSwap V2
// Uses SupportingFeeOnTransferTokens — handles sell tax tokens without reverting
// amountOutMin=0n for forced exits (stop-loss/time-limit) — accept any price
export async function sellBscToken(
  tokenAddress: string,
  tokenAmountWei: bigint,
  slippagePct = 0,
  fastGas = true
): Promise<BscTradeResult> {
  const wallet   = getWallet();
  const provider = getProvider();
  const router   = new ethers.Contract(ADDRESSES.PANCAKESWAP_ROUTER_V2, PANCAKE_ROUTER_ABI, wallet);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 1200);
  const gasPrice = await getBscSecureGasPrice();

  // Ensure router is approved to spend tokens
  await ensureAllowance(tokenAddress, ADDRESSES.PANCAKESWAP_ROUTER_V2, tokenAmountWei);

  // Calculate min BNB out (0 for forced exits)
  let amountOutMin = 0n;
  if (slippagePct > 0) {
    try {
      const r = new ethers.Contract(ADDRESSES.PANCAKESWAP_ROUTER_V2, PANCAKE_ROUTER_ABI, provider);
      const amounts: bigint[] = await r.getAmountsOut(tokenAmountWei, [tokenAddress, ADDRESSES.WBNB]);
      const slippageFactor = BigInt(Math.floor((100 - slippagePct) * 100));
      amountOutMin = (amounts[1] * slippageFactor) / 10000n;
    } catch { /* use 0 if quote fails */ }
  }

  try {
    const bnbBefore = await provider.getBalance(wallet.address);

    const tx = await router.swapExactTokensForETHSupportingFeeOnTransferTokens(
      tokenAmountWei,
      amountOutMin,
      [tokenAddress, ADDRESSES.WBNB],
      wallet.address,
      deadline,
      { gasLimit: GAS_LIMIT_SELL, gasPrice }
    );
    await tx.wait(1);

    const bnbAfter  = await provider.getBalance(wallet.address);
    const bnbReceived = bnbAfter > bnbBefore ? bnbAfter - bnbBefore : 0n;

    console.info(`[bsc-trade] ✅ SELL ${tokenAddress.slice(0,8)} → ${ethers.formatEther(bnbReceived)} BNB tx:${tx.hash.slice(0,12)}`);
    return {
      ok:         true,
      tx_hash:    tx.hash,
      amount_in:  tokenAmountWei.toString(),
      amount_out: ethers.formatEther(bnbReceived),
      dex:        'pancakeswap_v2',
    };
  } catch (e: any) {
    const reason = e.reason ?? e.shortMessage ?? e.message?.slice(0, 120) ?? 'unknown';
    console.error(`[bsc-trade] ❌ SELL FAILED ${tokenAddress.slice(0,8)}: ${reason}`);
    return { ok: false, amount_in: tokenAmountWei.toString(), amount_out: '0', dex: 'pancakeswap_v2', error: reason };
  }
}

async function ensureAllowance(tokenAddress: string, spender: string, amount: bigint): Promise<void> {
  const wallet  = getWallet();
  const token   = new ethers.Contract(tokenAddress, ERC20_ABI, wallet);
  const current = await token.allowance(wallet.address, spender);
  if (current < amount) {
    const tx = await token.approve(spender, ethers.MaxUint256);
    await tx.wait(1);
    console.debug(`[bsc-trade] Approved ${tokenAddress.slice(0, 8)} for PancakeSwap`);
  }
}

export async function getBnbBalance(): Promise<number> {
  const wallet   = getWallet();
  const provider = getProvider();
  const bal      = await provider.getBalance(wallet.address);
  return Number(ethers.formatEther(bal));
}

export async function getBscTokenBalance(tokenAddress: string): Promise<bigint> {
  const wallet   = getWallet();
  const provider = getProvider();
  const token    = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
  return await token.balanceOf(wallet.address);
}
