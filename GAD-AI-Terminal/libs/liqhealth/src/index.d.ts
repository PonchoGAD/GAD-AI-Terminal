/**
 * LiquidityHealth — evaluates exit safety and rug risk from DexScreener pair data.
 * Prevents getting stuck in illiquid positions with high slippage.
 */
export interface LiqHealthResult {
    liquidity_score: number;
    rug_risk: number;
    safe_exit_sol: number;
    warning: string | null;
    auto_exit: boolean;
}
export interface LiqPairData {
    liquidity?: {
        usd?: number;
        base?: number;
        quote?: number;
    };
    volume?: {
        m5?: number;
        h1?: number;
        h24?: number;
    };
    priceChange?: {
        m5?: number;
        h1?: number;
    };
    pairCreatedAt?: number;
    fdv?: number;
    marketCap?: number;
    txns?: {
        m5?: {
            buys?: number;
            sells?: number;
        };
    };
}
export declare function assessLiquidity(pair: LiqPairData, solPriceUsd?: number, positionSol?: number): LiqHealthResult;
