import { ethers } from 'ethers';
import { getWallet, getProvider } from './provider';
import { ADDRESSES, UNISWAP_V3_ROUTER_ABI, AERODROME_ROUTER_ABI, ERC20_ABI } from './contracts';
import { getBestBuyQuote, QuoteResult } from './quotes';

const MAX_SLIPPAGE_PCT = Number(process.env.BASE_MAX_SLIPPAGE_PCT || '3');
const GAS_LIMIT_BUY    = BigInt(process.env.BASE_GAS_LIMIT_BUY  || '350000');
const GAS_LIMIT_SELL   = BigInt(process.env.BASE_GAS_LIMIT_SELL || '300000');

export interface TradeResult {
  ok:           boolean;
  tx_hash?:     string;
  amount_in:    string;  // ETH in
  amount_out:   string;  // tokens out (or ETH out for sell)
  dex:          string;
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
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 120);

    if (quote.dex === 'uniswap_v3') {
      const router = new ethers.Contract(ADDRESSES.UNISWAP_V3_ROUTER, UNISWAP_V3_ROUTER_ABI, wallet);
      tx = await router.exactInputSingle(
        {
          tokenIn:           ADDRESSES.WETH,
          tokenOut:          tokenAddress,
          fee:               quote.fee,
          recipient:         wallet.address,
          amountIn:          ethAmountWei,
          amountOutMinimum:  quote.amountOutMin,
          sqrtPriceLimitX96: 0n,
        },
        { value: ethAmountWei, gasLimit: GAS_LIMIT_BUY }
      );
    } else {
      const router = new ethers.Contract(ADDRESSES.AERODROME_ROUTER, AERODROME_ROUTER_ABI, wallet);
      tx = await router.swapExactETHForTokens(
        quote.amountOutMin,
        [{ from: ADDRESSES.WETH, to: tokenAddress, stable: false, factory: ADDRESSES.AERODROME_FACTORY }],
        wallet.address,
        deadline,
        { value: ethAmountWei, gasLimit: GAS_LIMIT_BUY }
      );
    }

    const receipt = await tx.wait(1);
    return {
      ok:         true,
      tx_hash:    tx.hash,
      amount_in:  ethAmountEth.toString(),
      amount_out: quote.amountOut.toString(),
      dex:        quote.dex,
    };
  } catch (e: any) {
    return { ok: false, amount_in: ethAmountEth.toString(), amount_out: '0', dex: quote.dex, error: e.message };
  }
}

// Sell token for ETH
export async function sellToken(
  tokenAddress: string,
  tokenAmountWei: bigint,
  dex: 'uniswap_v3' | 'aerodrome',
  feeTier = 3000,
  slippagePct = MAX_SLIPPAGE_PCT
): Promise<TradeResult> {
  const wallet   = getWallet();
  const provider = getProvider();

  // Ensure allowance
  await ensureAllowance(tokenAddress, dex === 'uniswap_v3' ? ADDRESSES.UNISWAP_V3_ROUTER : ADDRESSES.AERODROME_ROUTER, tokenAmountWei);

  try {
    let tx: ethers.TransactionResponse;
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 120);
    const amountOutMin = 0n; // Accept any ETH out (stop-loss sell)

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
        { gasLimit: GAS_LIMIT_SELL }
      );
    } else {
      const router = new ethers.Contract(ADDRESSES.AERODROME_ROUTER, AERODROME_ROUTER_ABI, wallet);
      tx = await router.swapExactTokensForETH(
        tokenAmountWei,
        amountOutMin,
        [{ from: tokenAddress, to: ADDRESSES.WETH, stable: false, factory: ADDRESSES.AERODROME_FACTORY }],
        wallet.address,
        deadline,
        { gasLimit: GAS_LIMIT_SELL }
      );
    }

    const receipt = await tx.wait(1);
    // Parse ETH received from Transfer events or parse logs
    const ethReceived = await getEthFromReceipt(receipt, wallet.address);

    return {
      ok:         true,
      tx_hash:    tx.hash,
      amount_in:  tokenAmountWei.toString(),
      amount_out: ethers.formatEther(ethReceived),
      dex,
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

async function getEthFromReceipt(receipt: ethers.TransactionReceipt | null, walletAddress: string): Promise<bigint> {
  if (!receipt) return 0n;
  // WETH Withdrawal event: 0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c from weth = 0x4200...0006
  const WETH_WITHDRAWAL = '0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7fcf532c';
  // Approximate: estimate from tx value change or just return 0 and let caller recheck balance
  // For simplicity, re-check balance delta
  return 0n; // Caller should check wallet balance delta
}

// Get token balance of wallet
export async function getTokenBalance(tokenAddress: string): Promise<bigint> {
  const wallet  = getWallet();
  const provider = getProvider();
  const token   = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
  return await token.balanceOf(wallet.address);
}

// Get ETH balance of wallet
export async function getEthBalance(): Promise<number> {
  const wallet   = getWallet();
  const provider = getProvider();
  const bal      = await provider.getBalance(wallet.address);
  return Number(ethers.formatEther(bal));
}
