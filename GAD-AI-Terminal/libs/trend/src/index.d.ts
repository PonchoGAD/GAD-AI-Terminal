export type TrendSignal = 'BUY' | 'WAIT' | 'SELL';
export type TrendConfidence = 'LOW' | 'MEDIUM' | 'HIGH';
export type TrendStage = 'EARLY' | 'GROWING' | 'PEAK' | 'FADING' | 'DEAD';
export interface TrendResult {
    trend_score: number;
    signal: TrendSignal;
    confidence: TrendConfidence;
    stage: TrendStage;
    reason: string;
}
export interface PairData {
    priceChange?: {
        m5?: number;
        h1?: number;
        h6?: number;
        h24?: number;
    };
    volume?: {
        m5?: number;
        h1?: number;
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
    };
}
export declare function analyzeTrend(pair: PairData): TrendResult;
