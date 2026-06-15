export interface QuoteResult {
    dex: 'uniswap_v3' | 'aerodrome';
    amountOut: bigint;
    amountOutMin: bigint;
    fee: number;
    priceImpact: number;
}
export declare function getBestBuyQuote(tokenAddress: string, ethAmountWei: bigint, slippagePct?: number): Promise<QuoteResult>;
export declare function getBestSellQuote(tokenAddress: string, tokenAmountWei: bigint, slippagePct?: number): Promise<{
    minEthWei: bigint;
    expectedEthWei: bigint;
}>;
export declare function getTokenPriceEth(tokenAddress: string): Promise<{
    priceEth: number;
    liquidityUsd: number;
    mcapUsd: number;
}>;
