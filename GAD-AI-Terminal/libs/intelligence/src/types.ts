import type { LifecycleStage } from '@lib/lifecycle';
import type { MarketRegime } from '@lib/regime';
import type { NarrativeTag } from '@lib/narrative';
import type { DnaType } from '@lib/dna';
import type { ReputationTier } from '@lib/reputation';

// ─── Holder Velocity ──────────────────────────────────────────────────────────
export interface HolderVelocity {
  per5m:  number;   // new holders in last 5 min
  per15m: number;   // new holders in last 15 min
  per1h:  number;   // new holders in last hour
  velocityScore: number;  // 0-100 (100 = explosive growth)
}

// ─── Developer Intelligence ───────────────────────────────────────────────────
export interface DevIntelligence {
  devWallet:         string;
  devHolding:        boolean;     // still holds any tokens
  devSoldPct:        number;      // 0-100 % of initial dev holding sold
  devInitialBuySol:  number;
  devTransferCount:  number;      // suspicious transfers out
  devConviction:     'HOLDING' | 'PARTIAL_SELL' | 'DUMPED' | 'UNKNOWN';
  riskFlag:          boolean;     // true if dev dumped > 50%
}

// ─── Slippage Risk ────────────────────────────────────────────────────────────
export interface SlippageRisk {
  usd100:   number;   // % slippage simulated at $100
  usd500:   number;   // % slippage simulated at $500
  usd1000:  number;   // % slippage simulated at $1000
  usd5000:  number;   // % slippage simulated at $5000
  exitScore: number;  // 0-100 (100 = no slippage, easy exit)
}

// ─── Wallet Quality ───────────────────────────────────────────────────────────
export interface WalletQuality {
  qualityScore:     number;   // 0-100 (avg quality of recent buyers)
  diversityScore:   number;   // 0-100 (Herfindahl inverted: 100 = max diverse)
  avgWalletAgeDays: number;
  smartMoneyCount:  number;   // # known profitable wallets in recent buyers
  newWalletPct:     number;   // % wallets < 7 days old
  topBuyerDnaTags:  DnaType[];
  topBuyerRepTags:  ReputationTier[];
}

// ─── Narrative Capital Flow ───────────────────────────────────────────────────
export interface NarrativeFlow {
  tag:              NarrativeTag;
  tagVolume24h:     number;    // total USD volume in this narrative last 24h
  tagVolumeChange:  number;    // % change vs previous 24h
  capitalFlowing:   boolean;   // is money actively moving INTO this narrative?
  narrativeRank:    number;    // 1 = top narrative, higher = weaker
}

// ─── Cluster Detection ────────────────────────────────────────────────────────
export interface ClusterResult {
  bundledWallets:    number;   // # suspected coordinated wallets
  clusterRisk:       'NONE' | 'LOW' | 'MEDIUM' | 'HIGH';
  coordinatedBuyPct: number;   // % of buys from suspected clusters
  patterns:          string[]; // detected patterns: 'SAME_FUNDER', 'SAME_TIMING', 'SAME_DEST'
}

// ─── Master Intelligence Result ───────────────────────────────────────────────
export interface TokenIntelligence {
  // ── Identity ──────────────────────────────────────────────────────────────
  mint:    string;
  symbol:  string;
  name:    string;

  // ── Market basics ─────────────────────────────────────────────────────────
  priceUsd:      number;
  marketCapUsd:  number;
  liquidityUsd:  number;
  volume5m:      number;
  volume15m:     number;
  volume1h:      number;
  volume24h:     number;
  holders:       number;
  ageMins:       number;
  buySellRatio:  number;
  txCount1h:     number;

  // ── Behavior metrics ──────────────────────────────────────────────────────
  holderVelocity:      HolderVelocity;
  walletQuality:       WalletQuality;
  whaleAccumulation:   number;       // 0-100
  smartMoneyScore:     number;       // 0-100
  convictionScore:     number;       // 0-100
  clusterDetection:    ClusterResult;

  // ── Developer ─────────────────────────────────────────────────────────────
  devIntelligence: DevIntelligence;

  // ── Risk ──────────────────────────────────────────────────────────────────
  rugProbability:     number;   // 0-100
  slippageRisk:       SlippageRisk;
  exitLiquidityScore: number;   // 0-100 (100 = easy to exit)

  // ── Context ───────────────────────────────────────────────────────────────
  narrativeTag:       NarrativeTag;
  narrativeFlow:      NarrativeFlow;
  socialVelocity:     number;   // 0-100
  hypeScore:          number;   // 0-100
  lifecycleStage:     LifecycleStage;
  marketRegime:       MarketRegime;

  // ── Alpha scores ──────────────────────────────────────────────────────────
  aiScore:          number;
  gadScore:         number;
  gadScoreLabel:    string;
  opportunityScore: number;
  alphaSimilarity:  { score: number; bestMatch: string | null; expectedReturn: string };
  survivalScores:   { h1: number; h6: number; h24: number; d7: number };

  // ── Intelligence verdict ──────────────────────────────────────────────────
  confidenceScore: number;       // 0-100
  confidenceLevel: 'LOW' | 'MEDIUM' | 'HIGH';
  signals:         string[];     // human-readable key signals
  redFlags:        string[];     // human-readable risk flags

  // ── Meta ──────────────────────────────────────────────────────────────────
  analyzedAt:  number;    // Unix ms
  dataQuality: 'PARTIAL' | 'FULL';
}
