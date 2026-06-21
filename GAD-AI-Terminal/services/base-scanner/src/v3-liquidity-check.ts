// VULN 1: Uniswap V3 Tick Liquidity Starvation guard.
// V3 uses concentrated liquidity (ticks). If price falls below the LP range lower bound,
// active liquidity → 0. Router reverts with STF — token becomes unsellable.
// This check must run BEFORE any V3 sell to enable fallback routing.

import { ethers } from 'ethers';

// Uniswap V3 Factory on Base (CREATE2 deterministic pool deployment)
const UNISWAP_V3_FACTORY    = '0x33128a8fC17869897dcE68Ed026d694621f6FDfD';
// keccak256 of UniswapV3Pool bytecode — used in CREATE2 salt
const UNISWAP_V3_INIT_CODE  = '0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54';
const WETH_BASE              = '0x4200000000000000000000000000000000000006';

const POOL_ABI = [
  'function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationQueueNext, uint16 observationQueueStart, bool unlocked)',
  'function liquidity() external view returns (uint128)',
];

// Compute the deterministic Uniswap V3 pool address from token + fee tier.
// Tokens must be sorted (lower address first) before hashing the salt.
export function getV3PoolAddress(tokenAddress: string, feeTier: number): string {
  const tokenA = tokenAddress.toLowerCase();
  const tokenB = WETH_BASE.toLowerCase();
  const [t0, t1] = tokenA < tokenB ? [tokenA, tokenB] : [tokenB, tokenA];
  const salt = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(['address', 'address', 'uint24'], [t0, t1, feeTier])
  );
  return ethers.getCreate2Address(UNISWAP_V3_FACTORY, salt, UNISWAP_V3_INIT_CODE);
}

export async function checkV3PoolLiquidity(
  provider: ethers.JsonRpcProvider,
  poolAddress: string
): Promise<{ isActiveLiquidityEmpty: boolean; currentLiquidity: bigint }> {
  try {
    const pool = new ethers.Contract(poolAddress, POOL_ABI, provider);
    const currentLiquidity: bigint = await pool.liquidity();
    if (currentLiquidity === 0n) {
      console.warn(`[v3-guard] ⚠️ Pool ${poolAddress.slice(0, 10)} active_liquidity=0 — V3 sell will STF-revert`);
      return { isActiveLiquidityEmpty: true, currentLiquidity: 0n };
    }
    return { isActiveLiquidityEmpty: false, currentLiquidity };
  } catch (e: any) {
    // Fail-safe: treat check failure as empty liquidity to trigger fallback route
    console.warn(`[v3-guard] liquidity() call failed (${e.message?.slice(0, 60)}) — assuming empty, using fallback`);
    return { isActiveLiquidityEmpty: true, currentLiquidity: 0n };
  }
}

// Convenience wrapper: compute pool address then check liquidity.
export async function checkTokenV3Liquidity(
  provider: ethers.JsonRpcProvider,
  tokenAddress: string,
  feeTier: number
): Promise<{ isActiveLiquidityEmpty: boolean; currentLiquidity: bigint; poolAddress: string }> {
  const poolAddress = getV3PoolAddress(tokenAddress, feeTier);
  const result = await checkV3PoolLiquidity(provider, poolAddress);
  return { ...result, poolAddress };
}
