/**
 * BotShield — protects trades from sandwich/front-run bots.
 * Uses randomized slippage, random delays, and wash-trade detection.
 */
export interface BotShieldResult {
    threat_level: 'NONE' | 'LOW' | 'HIGH';
    bot_type: string;
    recommended_delay: number;
    safe_to_trade: boolean;
    slippage_bps: number;
}
export interface TxData {
    txns?: {
        m5?: {
            buys?: number;
            sells?: number;
        };
    };
    volume?: {
        m5?: number;
    };
    priceChange?: {
        m5?: number;
    };
}
/** Detect suspicious trading patterns that indicate bot activity */
export declare function detectBotActivity(pair: TxData): BotShieldResult;
/** Returns randomized slippage to prevent front-running on predictable values */
export declare function getRandomizedSlippage(threat?: 'NONE' | 'LOW' | 'HIGH'): number;
/** Random delay before executing a trade (defeats time-based front-run) */
export declare function randomTradeDelay(minMs?: number, maxMs?: number): Promise<void>;
