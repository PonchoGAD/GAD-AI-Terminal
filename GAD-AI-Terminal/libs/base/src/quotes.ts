import { ethers } from 'ethers';
import axios from 'axios';
import { getProvider } from './provider';
import { ADDRESSES, UNISWAP_V3_QUOTER_ABI, AERODROME_ROUTER_ABI, FEE_TIERS } from './contracts';

export interface QuoteResult {
  dex:         'uniswap_v3' | 'aerodrome';
  amountOut:   bigint;
  amountOutMin:bigint; // after slippage
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
    getUniswapV3Quote(tokenAddress, ethAmountWei, 'buy'),
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

// Get sell quote: token → ETH (with slippage protection for TP sells)
// Returns minEthWei = 0n if no quote found (caller should treat as "accept any")
export async function getBestSellQuote(
  tokenAddress: string,
  tokenAmountWei: bigint,
  slippagePct = 3
): Promise<{ minEthWei: bigint; expectedEthWei: bigint }> {
  const provider = getProvider();
  const quoter = new ethers.Contract(ADDRESSES.UNISWAP_V3_QUOTER, UNISWAP_V3_QUOTER_ABI, provider);
  const slippageFactor = BigInt(Math.floor((100 - slippagePct) * 100));

  // Try Uniswap V3 (token → WETH) — same fee tier order as buy
  for (const fee of [FEE_TIERS.ULTRA, FEE_TIERS.HIGH, FEE_TIERS.MEDIUM, FEE_TIERS.LOW]) {
    try {
      const result = await quoter.quoteExactInputSingle.staticCall({
        tokenIn:           tokenAddress,
        tokenOut:          ADDRESSES.WETH,
        amountIn:          tokenAmountWei,
        fee,
        sqrtPriceLimitX96: 0n,
      });
      const expectedEthWei = result[0] as bigint;
      return { minEthWei: (expectedEthWei * slippageFactor) / 10000n, expectedEthWei };
    } catch { continue; }
  }

  // Fallback: Aerodrome sell quote
  try {
    const router = new ethers.Contract(ADDRESSES.AERODROME_ROUTER, AERODROME_ROUTER_ABI, provider);
    const routes = [{ from: tokenAddress, to: ADDRESSES.WETH, stable: false, factory: ADDRESSES.AERODROME_FACTORY }];
    const amounts: bigint[] = await router.getAmountsOut(tokenAmountWei, routes);
    if (amounts && amounts.length >= 2) {
      const expectedEthWei = amounts[amounts.length - 1];
      return { minEthWei: (expectedEthWei * slippageFactor) / 10000n, expectedEthWei };
    }
  } catch { }

  return { minEthWei: 0n, expectedEthWei: 0n };
}

// Uniswap V3 quote via Quoter V2
// direction: 'buy' = ETH→token, 'sell' = token→ETH
async function getUniswapV3Quote(
  tokenAddress: string,
  amountInWei: bigint,
  direction: 'buy' | 'sell' = 'buy'
): Promise<QuoteResult> {
  const provider = getProvider();
  const quoter = new ethers.Contract(ADDRESSES.UNISWAP_V3_QUOTER, UNISWAP_V3_QUOTER_ABI, provider);
  const tokenIn  = direction === 'buy' ? ADDRESSES.WETH : tokenAddress;
  const tokenOut = direction === 'buy' ? tokenAddress  : ADDRESSES.WETH;

  // Try ULTRA first — most new meme tokens on Base use 1% pools
  for (const fee of [FEE_TIERS.ULTRA, FEE_TIERS.HIGH, FEE_TIERS.MEDIUM, FEE_TIERS.LOW]) {
    try {
      const result = await quoter.quoteExactInputSingle.staticCall({
        tokenIn,
        tokenOut,
        amountIn:          amountInWei,
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
