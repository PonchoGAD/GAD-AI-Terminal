import type { LifecycleStage } from '@lib/lifecycle';
import type { MarketRegime } from '@lib/regime';
import type { NarrativeTag } from '@lib/narrative';
import type { DnaType } from '@lib/dna';
import type { ReputationTier } from '@lib/reputation';
export interface HolderVelocity {
    per5m: number;
    per15m: number;
    per1h: number;
    velocityScore: number;
}
export interface DevIntelligence {
    devWallet: string;
    devHolding: boolean;
    devSoldPct: number;
    devInitialBuySol: number;
    devTransferCount: number;
    devConviction: 'HOLDING' | 'PARTIAL_SELL' | 'DUMPED' | 'UNKNOWN';
    riskFlag: boolean;
}
export interface SlippageRisk {
    usd100: number;
    usd500: number;
    usd1000: number;
    usd5000: number;
    exitScore: number;
}
export interface WalletQuality {
    qualityScore: number;
    diversityScore: number;
    avgWalletAgeDays: number;
    smartMoneyCount: number;
    newWalletPct: number;
    topBuyerDnaTags: DnaType[];
    topBuyerRepTags: ReputationTier[];
}
export interface NarrativeFlow {
    tag: NarrativeTag;
    tagVolume24h: number;
    tagVolumeChange: number;
    capitalFlowing: boolean;
    narrativeRank: number;
}
export interface ClusterResult {
    bundledWallets: number;
    clusterRisk: 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH';
    coordinatedBuyPct: number;
    patterns: string[];
}
export interface TokenIntelligence {
    mint: string;
    symbol: string;
    name: string;
    priceUsd: number;
    marketCapUsd: number;
    liquidityUsd: number;
    volume5m: number;
    volume15m: number;
    volume1h: number;
    volume24h: number;
    holders: number;
    ageMins: number;
    buySellRatio: number;
    txCount1h: number;
    holderVelocity: HolderVelocity;
    walletQuality: WalletQuality;
    whaleAccumulation: number;
    smartMoneyScore: number;
    convictionScore: number;
    clusterDetection: ClusterResult;
    devIntelligence: DevIntelligence;
    rugProbability: number;
    slippageRisk: SlippageRisk;
    exitLiquidityScore: number;
    narrativeTag: NarrativeTag;
    narrativeFlow: NarrativeFlow;
    socialVelocity: number;
    hypeScore: number;
    lifecycleStage: LifecycleStage;
    marketRegime: MarketRegime;
    aiScore: number;
    gadScore: number;
    gadScoreLabel: string;
    opportunityScore: number;
    alphaSimilarity: {
        score: number;
        bestMatch: string | null;
        expectedReturn: string;
    };
    survivalScores: {
        h1: number;
        h6: number;
        h24: number;
        d7: number;
    };
    confidenceScore: number;
    confidenceLevel: 'LOW' | 'MEDIUM' | 'HIGH';
    signals: string[];
    redFlags: string[];
    analyzedAt: number;
    dataQuality: 'PARTIAL' | 'FULL';
}
