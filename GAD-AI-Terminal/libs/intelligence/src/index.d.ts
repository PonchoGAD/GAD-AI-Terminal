/**
 * GAD Market Intelligence Core
 *
 * Master aggregator combining all 14 analytics libs + new modules into
 * a single analyzeToken() call returning a complete TokenIntelligence object.
 */
import type { TokenIntelligence } from './types';
import type { MarketRegime } from '@lib/regime';
export type { TokenIntelligence } from './types';
export { recordHolderCount } from './holder-velocity';
export { recordNarrativeVolume, getTopNarrative } from './narrative-flow';
export interface IntelligenceInput {
    mint: string;
    symbol: string;
    name: string;
    devWallet?: string;
    priceUsd: number;
    marketCapUsd: number;
    liquidityUsd: number;
    volume5m: number;
    volume15m: number;
    volume1h: number;
    volume24h: number;
    holders: number;
    ageMins: number;
    buys5m: number;
    sells5m: number;
    buys1h: number;
    sells1h: number;
    priceChange5m: number;
    priceChange1h: number;
    priceChange24h: number;
    top10HolderPct: number;
    txCount1h: number;
    lpLocked?: boolean;
    mintAuthorityRevoked?: boolean;
    freezeAuthorityRevoked?: boolean;
    sniperCount?: number;
    whaleNetFlow?: number;
    socialMentions1h?: number;
    socialMentions24h?: number;
    telegramMentions?: number;
    pumpFunComments?: number;
    engagementRate?: number;
    sentimentScore?: number;
    marketRegime?: MarketRegime;
    regimeMultiplier?: number;
    heliusApiKey?: string;
    birdeyeApiKey?: string;
    solPriceUsd?: number;
}
export declare function analyzeToken(input: IntelligenceInput): Promise<TokenIntelligence>;
