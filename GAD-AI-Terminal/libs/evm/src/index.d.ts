import { ethers } from 'ethers';

export declare const CHAIN_CONFIG: Record<number, { routerAddress: string; wethAddress: string }>;

export interface SwapSimResult {
  canSwap:      boolean;
  buyTaxPct:    number;
  sellTaxPct:   number;
  totalLossPct: number;
  reason?:      string;
}

export declare function simulateEvmSwap(
  provider: ethers.JsonRpcProvider,
  targetTokenAddress: string,
  chainId?: number,
  amountInWei?: bigint,
): Promise<SwapSimResult>;

export interface SecurityResult {
  isSafe:  boolean;
  reason?: string;
}

export declare function isTokenSafeToTrade(
  tokenAddress: string,
  chainId?: number,
  ageSec?: number,
): Promise<SecurityResult>;
