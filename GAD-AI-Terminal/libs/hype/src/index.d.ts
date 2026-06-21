/**
 * HypeRadar — detects hype stage using on-chain velocity signals.
 * Enter at hype_score 50-65 (before peak), exit when score > 80 or falling.
 * Uses only on-chain data (no Twitter/Telegram API needed).
 */
export type HypeStage = 'QUIET' | 'EARLY' | 'GROWING' | 'PEAK' | 'FADING';
export interface HypeResult {
    hype_score: number;
    hype_stage: HypeStage;
    recommended_action: string;
    estimated_peak_in: string | null;
    entry_window: boolean;
    exit_signal: boolean;
}
export interface HypePairData {
    priceChange?: {
        m5?: number;
        h1?: number;
        h6?: number;
    };
    volume?: {
        m5?: number;
        h1?: number;
        h6?: number;
        h24?: number;
    };
    txns?: {
        m5?: {
            buys?: number;
            sells?: number;
        };
        h1?: {
            buys?: number;
            sells?: number;
        };
        h6?: {
            buys?: number;
            sells?: number;
        };
    };
    pairCreatedAt?: number;
}
export declare function detectHype(pair: HypePairData): HypeResult;
