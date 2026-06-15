export interface TradeResult {
    ok: boolean;
    tx_hash?: string;
    amount_in: string;
    amount_out: string;
    dex: string;
    fee_tier?: number;
    error?: string;
}
export declare function buyToken(tokenAddress: string, ethAmountEth: number, slippagePct?: number): Promise<TradeResult>;
export declare function sellToken(tokenAddress: string, tokenAmountWei: bigint, dex: 'uniswap_v3' | 'aerodrome', feeTier?: number, slippagePct?: number): Promise<TradeResult>;
export declare function getTokenBalance(tokenAddress: string): Promise<bigint>;
export declare function getEthBalance(): Promise<number>;
