import { ethers } from 'ethers';

// provider
export declare function getProvider(): ethers.JsonRpcProvider;
export declare function getWallet(): ethers.Wallet;
export declare function getBaseStatus(): Promise<{ connected: boolean; eth_balance: number; network: string; block: number }>;
export declare function withFallback<T>(fn: (p: ethers.JsonRpcProvider) => Promise<T>): Promise<T>;

// contracts
export declare const ADDRESSES: {
  WETH:               string;
  USDC:               string;
  UNISWAP_V3_ROUTER:  string;
  UNISWAP_V3_QUOTER:  string;
  AERODROME_ROUTER:   string;
  AERODROME_FACTORY:  string;
};
export declare const FEE_TIERS: { LOW: number; MEDIUM: number; HIGH: number; ULTRA: number };
export declare const UNISWAP_V3_ROUTER_ABI:  readonly string[];
export declare const UNISWAP_V3_QUOTER_ABI:  readonly string[];
export declare const AERODROME_ROUTER_ABI:   readonly string[];
export declare const ERC20_ABI:              readonly string[];

// quotes
export interface QuoteResult {
  amountOut:    bigint;
  amountOutMin: bigint;
  dex:          'uniswap_v3' | 'aerodrome';
  fee:          number;
}
export declare function getBestBuyQuote(tokenAddress: string, ethAmountWei: bigint, slippagePct?: number): Promise<QuoteResult>;
export declare function getTokenPriceEth(tokenAddress: string): Promise<{ priceEth: number; liquidityUsd: number; mcapUsd: number }>;

// trader
export interface TradeResult {
  ok:        boolean;
  tx_hash?:  string;
  amount_in: string;
  amount_out:string;
  dex:       string;
  error?:    string;
}
export declare function buyToken(tokenAddress: string, ethAmountEth: number, slippagePct?: number): Promise<TradeResult>;
export declare function sellToken(tokenAddress: string, tokenAmountWei: bigint, dex: 'uniswap_v3' | 'aerodrome', feeTier?: number, slippagePct?: number): Promise<TradeResult>;
export declare function getTokenBalance(tokenAddress: string): Promise<bigint>;
export declare function getEthBalance(): Promise<number>;

// safety
export interface TokenSafetyResult {
  is_verified:   boolean;
  owner_renounced: boolean;
  lp_locked:     boolean;
  top10_pct:     number;
  safe_score:    number;
  flags:         string[];
}
export declare function checkTokenSafety(address: string): Promise<TokenSafetyResult>;
