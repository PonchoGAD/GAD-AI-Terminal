/**
 * EVM Virtual Swap Simulator
 *
 * Simulates buy→sell round-trip via V2-style router using getAmountsOut
 * (pure view call — no gas, no on-chain state change).
 *
 * Why this beats static API checks:
 *   GoPlus/honeypot.is may have stale data. getAmountsOut replicates what
 *   the actual router contract would return at the current block, exposing:
 *   - Zero liquidity pools (ZERO_BUY_SIMULATION)
 *   - Buy-and-lock honeypots (getAmountsOut succeeds for buy but fails for sell)
 *   - High-tax tokens: round-trip loss >15% = REVERT_DETECTED or HIGH_TAX_ATTACK
 *
 * Supports:
 *   Base: Uniswap V2 router (0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24)
 *   BSC:  PancakeSwap V2   (0x10ED43C718714eb63d5aA57B78B54704E256024E)
 *
 * Max total round-trip tax allowed: MAX_TOTAL_TAX_PCT (default 15%)
 */
import { ethers } from 'ethers';
export declare const CHAIN_CONFIG: Record<number, {
    routerAddress: string;
    wethAddress: string;
}>;
export interface SwapSimResult {
    canSwap: boolean;
    buyTaxPct: number;
    sellTaxPct: number;
    totalLossPct: number;
    reason?: string;
}
export declare function simulateEvmSwap(provider: ethers.JsonRpcProvider, targetTokenAddress: string, chainId?: number, amountInWei?: bigint): Promise<SwapSimResult>;
