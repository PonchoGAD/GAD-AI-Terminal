import { ethers } from 'ethers';
import { getWallet, getProvider } from './provider';
import { ADDRESSES, UNISWAP_V3_ROUTER_ABI, UNISWAP_V2_ROUTER_ABI, AERODROME_ROUTER_ABI, ERC20_ABI } from './contracts';
import { getBestBuyQuote, getBestSellQuote, QuoteResult } from './quotes';

const MAX_SLIPPAGE_PCT   = Number(process.env.BASE_MAX_SLIPPAGE_PCT    || '3');
const GAS_LIMIT_BUY      = BigInt(process.env.BASE_GAS_LIMIT_BUY       || '350000');
const GAS_LIMIT_SELL     = BigInt(process.env.BASE_GAS_LIMIT_SELL      || '300000');
// Multiplier on top of network maxPriorityFeePerGas to ensure faster inclusion
const GAS_PRIORITY_MULT  = Number(process.env.BASE_GAS_PRIORITY_MULT   || '1.3');

// Fetch current EIP-1559 fee data and apply a priority multiplier.
// Base L2 base fee is nearly 0 but priority fee matters for quick inclusion.
async function getEip1559Overrides(gasLimit: bigint): Promise<Record<string, bigint>> {
  try {
    const provider = getProvider();
    const feeData  = await provider.getFeeData();

    const basePriority = feeData.maxPriorityFeePerGas ?? ethers.parseUnits('0.001', 'gwei');
    const maxPriority  = BigInt(Math.ceil(Number(basePriority) * GAS_PRIORITY_MULT));
    // maxFeePerGas = maxBaseFee + maxPriorityFee; use provider value with same multiplier
    const maxFee = feeData.maxFeePerGas
      ? BigInt(Math.ceil(Number(feeData.maxFeePerGas) * GAS_PRIORITY_MULT))
      : maxPriority * 2n;

    console.debug(`[base-trader] gas: maxFee=${ethers.formatUnits(maxFee, 'gwei')}gwei priority=${ethers.formatUnits(maxPriority, 'gwei')}gwei`);
    return { maxFeePerGas: maxFee, maxPriorityFeePerGas: maxPriority, gasLimit };
  } catch (e: any) {
    console.warn(`[base-trader] getFeeData failed (${e.message?.slice(0, 50)}) — falling back to gasLimit only`);
    return { gasLimit };
  }
}

// keccak256("Withdrawal(address,uint256)") — WETH unwrap event emitted during token→ETH swaps
const WETH_WITHDRAWAL_TOPIC = ethers.id('Withdrawal(address,uint256)');

export interface TradeResult {
  ok:           boolean;
  tx_hash?:     string;
  amount_in:    string;  // ETH in (buy) or tokens in (sell)
  amount_out:   string;  // tokens out (buy) or ETH out (sell)
  dex:          string;
  fee_tier?:    number;  // Uniswap V3 fee tier used (0 for Aerodrome)
  error?:       string;
}

// Buy token with ETH
export async function buyToken(
  tokenAddress: string,
  ethAmountEth: number,
  slippagePct = MAX_SLIPPAGE_PCT
): Promise<TradeResult> {
  const wallet      = getWallet();
  const ethAmountWei = ethers.parseEther(ethAmountEth.toString());

  let quote: QuoteResult;
  try {
    quote = await getBestBuyQuote(tokenAddress, ethAmountWei, slippagePct);
  } catch (e: any) {
    return { ok: false, amount_in: ethAmountEth.toString(), amount_out: '0', dex: 'none', error: e.message };
  }

  try {
    let tx: ethers.TransactionResponse;
    const deadline  = BigInt(Math.floor(Date.now() / 1000) + 120);
    const gasOverrides = await getEip1559Overrides(GAS_LIMIT_BUY);

    if (quote.dex === 'uniswap_v3') {
      const router = new ethers.Contract(ADDRESSES.UNISWAP_V3_ROUTER, UNISWAP_V3_ROUTER_ABI, wallet);
      const params = {
        tokenIn:           ADDRESSES.WETH,
        tokenOut:          tokenAddress,
        fee:               quote.fee,
        recipient:         wallet.address,
        amountIn:          ethAmountWei,
        amountOutMinimum:  quote.amountOutMin,
        sqrtPriceLimitX96: 0n,
      };
      await router.exactInputSingle.staticCall(params, { value: ethAmountWei });
      tx = await router.exactInputSingle(params, { ...gasOverrides, value: ethAmountWei });
    } else if (quote.dex === 'uniswap_v2') {
      const router   = new ethers.Contract(ADDRESSES.UNISWAP_V2_ROUTER, UNISWAP_V2_ROUTER_ABI, wallet);
      const path     = [ADDRESSES.WETH, tokenAddress];
      await router.swapExactETHForTokens.staticCall(quote.amountOutMin, path, wallet.address, deadline, { value: ethAmountWei });
      tx = await router.swapExactETHForTokens(
        quote.amountOutMin,
        path,
        wallet.address,
        deadline,
        { ...gasOverrides, value: ethAmountWei }
      );
    } else {
      const router = new ethers.Contract(ADDRESSES.AERODROME_ROUTER, AERODROME_ROUTER_ABI, wallet);
      const routes = [{ from: ADDRESSES.WETH, to: tokenAddress, stable: false, factory: ADDRESSES.AERODROME_FACTORY }];
      await router.swapExactETHForTokens.staticCall(quote.amountOutMin, routes, wallet.address, deadline, { value: ethAmountWei });
      tx = await router.swapExactETHForTokens(
        quote.amountOutMin,
        routes,
        wallet.address,
        deadline,
        { ...gasOverrides, value: ethAmountWei }
      );
    }

    await tx.wait(1);
    return {
      ok:         true,
      tx_hash:    tx.hash,
      amount_in:  ethAmountEth.toString(),
      amount_out: quote.amountOut.toString(),
      dex:        quote.dex,
      fee_tier:   quote.fee,
    };
  } catch (e: any) {
    // Decode revert reason if available
    const reason = e.reason ?? e.shortMessage ?? e.message?.slice(0, 120) ?? 'unknown';
    return { ok: false, amount_in: ethAmountEth.toString(), amount_out: '0', dex: quote.dex, error: reason };
  }
}

// Sell token for ETH
// slippagePct=0 → amountOutMin=0n (use for stop-loss/time-limit: must exit at any price)
// slippagePct>0 → get sell quote and enforce min ETH out (use for TP sells: MEV protection)
export async function sellToken(
  tokenAddress: string,
  tokenAmountWei: bigint,
  dex: 'uniswap_v3' | 'uniswap_v2' | 'aerodrome',
  feeTier = 3000,
  slippagePct = 0
): Promise<TradeResult> {
  const wallet = getWallet();

  const spender = dex === 'uniswap_v3' ? ADDRESSES.UNISWAP_V3_ROUTER
                : dex === 'uniswap_v2' ? ADDRESSES.UNISWAP_V2_ROUTER
                : ADDRESSES.AERODROME_ROUTER;
  await ensureAllowance(tokenAddress, spender, tokenAmountWei);

  // Compute amountOutMin for slippage protection on TP sells
  let amountOutMin = 0n;
  if (slippagePct > 0) {
    const sellQuote = await getBestSellQuote(tokenAddress, tokenAmountWei, slippagePct).catch(() => ({ minEthWei: 0n, expectedEthWei: 0n }));
    amountOutMin = sellQuote.minEthWei;
  }

  try {
    let tx: ethers.TransactionResponse;
    const deadline     = BigInt(Math.floor(Date.now() / 1000) + 120);
    const gasOverrides = await getEip1559Overrides(GAS_LIMIT_SELL);

    if (dex === 'uniswap_v3') {
      const router = new ethers.Contract(ADDRESSES.UNISWAP_V3_ROUTER, UNISWAP_V3_ROUTER_ABI, wallet);
      tx = await router.exactInputSingle(
        {
          tokenIn:           tokenAddress,
          tokenOut:          ADDRESSES.WETH,
          fee:               feeTier,
          recipient:         wallet.address,
          amountIn:          tokenAmountWei,
          amountOutMinimum:  amountOutMin,
          sqrtPriceLimitX96: 0n,
        },
        gasOverrides
      );
    } else if (dex === 'uniswap_v2') {
      const router = new ethers.Contract(ADDRESSES.UNISWAP_V2_ROUTER, UNISWAP_V2_ROUTER_ABI, wallet);
      tx = await router.swapExactTokensForETH(
        tokenAmountWei,
        amountOutMin,
        [tokenAddress, ADDRESSES.WETH],
        wallet.address,
        deadline,
        gasOverrides
      );
    } else {
      const router = new ethers.Contract(ADDRESSES.AERODROME_ROUTER, AERODROME_ROUTER_ABI, wallet);
      tx = await router.swapExactTokensForETH(
        tokenAmountWei,
        amountOutMin,
        [{ from: tokenAddress, to: ADDRESSES.WETH, stable: false, factory: ADDRESSES.AERODROME_FACTORY }],
        wallet.address,
        deadline,
        gasOverrides
      );
    }

    const receipt = await tx.wait(1);
    // Parse ETH received from WETH Withdrawal event in receipt
    const ethReceived = getEthFromReceipt(receipt);

    return {
      ok:         true,
      tx_hash:    tx.hash,
      amount_in:  tokenAmountWei.toString(),
      amount_out: ethers.formatEther(ethReceived),
      dex,
      fee_tier:   feeTier,
    };
  } catch (e: any) {
    return { ok: false, amount_in: tokenAmountWei.toString(), amount_out: '0', dex, error: e.message };
  }
}

async function ensureAllowance(tokenAddress: string, spender: string, amount: bigint): Promise<void> {
  const wallet  = getWallet();
  const token   = new ethers.Contract(tokenAddress, ERC20_ABI, wallet);
  const current = await token.allowance(wallet.address, spender);
  if (current < amount) {
    const tx = await token.approve(spender, ethers.MaxUint256);
    await tx.wait(1);
  }
}

// Parse ETH received from WETH Withdrawal(address indexed src, uint256 wad) events.
// Uniswap V3 router unwraps WETH → ETH and emits Withdrawal from the WETH contract.
// monitor.ts also uses balance delta as primary source; this is used for logging in TradeResult.
function getEthFromReceipt(receipt: ethers.TransactionReceipt | null): bigint {
  if (!receipt) return 0n;
  let total = 0n;
  for (const log of receipt.logs) {
    if (
      log.address.toLowerCase() === ADDRESSES.WETH.toLowerCase() &&
      log.topics[0] === WETH_WITHDRAWAL_TOPIC
    ) {
      // data = wad (uint256 ETH amount in wei)
      try { total += BigInt(log.data); } catch { }
    }
  }
  return total;
}

// Get token balance of wallet
export async function getTokenBalance(tokenAddress: string): Promise<bigint> {
  const wallet   = getWallet();
  const provider = getProvider();
  const token    = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
  return await token.balanceOf(wallet.address);
}

// Get ETH balance of wallet
export async function getEthBalance(): Promise<number> {
  const wallet   = getWallet();
  const provider = getProvider();
  const bal      = await provider.getBalance(wallet.address);
  return Number(ethers.formatEther(bal));
}
