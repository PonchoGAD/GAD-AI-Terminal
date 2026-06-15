export interface BscTradeResult {
    ok: boolean;
    tx_hash?: string;
    amount_in: string;
    amount_out: string;
    dex: string;
    error?: string;
}
export declare function getBnbToTokenQuote(tokenAddress: string, bnbAmountWei: bigint): Promise<{
    amountOut: bigint;
    amountOutMin: bigint;
}>;
export declare function buyBscToken(tokenAddress: string, bnbAmountBnb: number, slippagePct?: number, fastGas?: boolean): Promise<BscTradeResult>;
export declare function sellBscToken(tokenAddress: string, tokenAmountWei: bigint, slippagePct?: number, fastGas?: boolean): Promise<BscTradeResult>;
export declare function getBnbBalance(): Promise<number>;
export declare function getBscTokenBalance(tokenAddress: string): Promise<bigint>;
