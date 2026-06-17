import type { SlippageRisk } from './types';
export declare function analyzeSlippage(mint: string, liquidityUsd: number, priceUsd: number): Promise<SlippageRisk>;
