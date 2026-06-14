import { ethers } from 'ethers';
import axios from 'axios';
import { getProvider } from './provider';
import { ADDRESSES, UNISWAP_V3_QUOTER_ABI, AERODROME_ROUTER_ABI, FEE_TIERS } from './contracts';

export interface QuoteResult {
  dex:         'uniswap_v3' | 'aerodrome';
  amountOut:   bigint;
  amountOutMin:bigint; // after 3% slippage
  fee:         number;
  priceImpact: number;
}

// Get best buy quote: ETH → token
export async function getBestBuyQuote(
  tokenAddress: string,
  ethAmountWei: bigint,
  slippagePct = 3
): Promise<QuoteResult> {
  const [uniQuote, aeroQuote] = await Promise.allSettled([
    getUniswapV3Quote(tokenAddress, ethAmountWei),
    getAerodromeQuote(tokenAddress, ethAmountWei),
  ]);

  const quotes: QuoteResult[] = [];
  if (uniQuote.status === 'fulfilled') quotes.push(uniQuote.value);
  if (aeroQuote.status === 'fulfilled') quotes.push(aeroQuote.value);

  if (!quotes.length) throw new Error('No DEX quotes available for ' + tokenAddress);

  // Pick best (highest amountOut)
  const best = quotes.sort((a, b) => (b.amountOut > a.amountOut ? 1 : -1))[0];
  const slippageFactor = BigInt(Math.floor((100 - slippagePct) * 100));
  best.amountOutMin = (best.amountOut * slippageFactor) / 10000n;
  return best;
}

// Uniswap V3 quote via Quoter V2
async function getUniswapV3Quote(tokenAddress: string, ethAmountWei: bigint): Promise<QuoteResult> {
  const provider = getProvider();
  const quoter = new ethers.Contract(ADDRESSES.UNISWAP_V3_QUOTER, UNISWAP_V3_QUOTER_ABI, provider);

  // Try common fee tiers in order of likelihood for new tokens
  for (const fee of [FEE_TIERS.HIGH, FEE_TIERS.MEDIUM, FEE_TIERS.LOW]) {
    try {
      const result = await quoter.quoteExactInputSingle.staticCall({
        tokenIn:           ADDRESSES.WETH,
        tokenOut:          tokenAddress,
        amountIn:          ethAmountWei,
        fee,
        sqrtPriceLimitX96: 0n,
      });
      return {
        dex:          'uniswap_v3',
        amountOut:    result[0],
        amountOutMin: 0n,
        fee,
        priceImpact:  0,
      };
    } catch { continue; }
  }
  throw new Error('No Uniswap V3 pool found');
}

// Aerodrome quote
async function getAerodromeQuote(tokenAddress: string, ethAmountWei: bigint): Promise<QuoteResult> {
  const provider = getProvider();
  const router = new ethers.Contract(ADDRESSES.AERODROME_ROUTER, AERODROME_ROUTER_ABI, provider);
  const routes = [{ from: ADDRESSES.WETH, to: tokenAddress, stable: false, factory: ADDRESSES.AERODROME_FACTORY }];
  const amounts: bigint[] = await router.getAmountsOut(ethAmountWei, routes);
  if (!amounts || amounts.length < 2) throw new Error('Aerodrome: no route');
  return {
    dex:          'aerodrome',
    amountOut:    amounts[amounts.length - 1],
    amountOutMin: 0n,
    fee:          0,
    priceImpact:  0,
  };
}

// Get current token price in ETH via DexScreener (fast, free)
export async function getTokenPriceEth(tokenAddress: string): Promise<{ priceEth: number; liquidityUsd: number; mcapUsd: number }> {
  const r = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`, { timeout: 5000 });
  const pairs: any[] = r.data?.pairs ?? [];
  const base = pairs.find((p: any) => p.chainId === 'base' && p.baseToken?.address?.toLowerCase() === tokenAddress.toLowerCase());
  if (!base) return { priceEth: 0, liquidityUsd: 0, mcapUsd: 0 };
  return {
    priceEth:     Number(base.priceNative  ?? 0),
    liquidityUsd: Number(base.liquidity?.usd ?? 0),
    mcapUsd:      Number(base.marketCap   ?? 0),
  };
}
