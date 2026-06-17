/**
 * GAD Market Intelligence Core
 *
 * Master aggregator combining all 14 analytics libs + new modules into
 * a single analyzeToken() call returning a complete TokenIntelligence object.
 */

import type { TokenIntelligence, HolderVelocity, WalletQuality, ClusterResult } from './types';
import { calculateHolderVelocity, recordHolderCount } from './holder-velocity';
import { analyzeDevBehavior } from './dev-intelligence';
import { analyzeSlippage } from './slippage';
import { getNarrativeFlow, recordNarrativeVolume } from './narrative-flow';
import { detectClusters } from './cluster';

import { calculateAiScore } from '@lib/scoring';
import { calculateRugProbability } from '@lib/rug';
import { calculateGadScore } from '@lib/gad-score';
import { detectNarrative, DEFAULT_NARRATIVE_STRENGTH } from '@lib/narrative';
import { calculateHypeScore } from '@lib/social';
import { detectLifecycle } from '@lib/lifecycle';
import { calculateSurvivalScore } from '@lib/survival';
import { calculateOpportunityScore } from '@lib/opportunity';
import { calculateAlphaSimilarity, buildTokenSnapshot } from '@lib/memory';
import type { MarketRegime } from '@lib/regime';

export type { TokenIntelligence } from './types';
export { recordHolderCount } from './holder-velocity';
export { recordNarrativeVolume, getTopNarrative } from './narrative-flow';

// ─── Input ────────────────────────────────────────────────────────────────────

export interface IntelligenceInput {
  mint:       string;
  symbol:     string;
  name:       string;
  devWallet?: string;

  priceUsd:       number;
  marketCapUsd:   number;
  liquidityUsd:   number;
  volume5m:       number;
  volume15m:      number;
  volume1h:       number;
  volume24h:      number;
  holders:        number;
  ageMins:        number;
  buys5m:         number;
  sells5m:        number;
  buys1h:         number;
  sells1h:        number;
  priceChange5m:  number;
  priceChange1h:  number;
  priceChange24h: number;
  top10HolderPct: number;
  txCount1h:      number;

  lpLocked?:               boolean;
  mintAuthorityRevoked?:   boolean;
  freezeAuthorityRevoked?: boolean;
  sniperCount?:            number;
  whaleNetFlow?:           number;
  socialMentions1h?:       number;
  socialMentions24h?:      number;
  telegramMentions?:       number;
  pumpFunComments?:        number;
  engagementRate?:         number;
  sentimentScore?:         number;

  // Override regime if caller has market-level data
  marketRegime?:     MarketRegime;
  regimeMultiplier?: number;

  heliusApiKey?:  string;
  birdeyeApiKey?: string;
  solPriceUsd?:   number;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export async function analyzeToken(input: IntelligenceInput): Promise<TokenIntelligence> {
  const now = Date.now();
  const ageHours = input.ageMins / 60;
  const buySellRatio = input.sells1h > 0 ? input.buys1h / input.sells1h : input.buys1h > 0 ? 3 : 1;
  const solPriceUsd = input.solPriceUsd ?? 150;
  const marketRegime: MarketRegime = input.marketRegime ?? 'SIDEWAYS';
  const regimeMultiplier = input.regimeMultiplier ?? 1.0;

  // ── 1. Core scoring ─────────────────────────────────────────────────────────
  const aiScore = calculateAiScore({
    growth:    Math.min(100, 50 + input.priceChange1h),
    liquidity: Math.min(100, (input.liquidityUsd / 50000) * 100),
    volume:    Math.min(100, input.volume1h > 0 && input.liquidityUsd > 0
      ? (input.volume1h / input.liquidityUsd) * 100 : 0),
    holders:   Math.min(100, (input.holders / 1000) * 100),
    momentum:  Math.min(100, 50 + input.priceChange5m * 3),
    risk:      Math.max(0, 50 - input.priceChange24h / 2),
  });

  // ── 2. Rug probability ────────────────────────────────────────────────────
  const rugResult = calculateRugProbability({
    mintAddress:            input.mint,
    top10HolderPct:         input.top10HolderPct,
    liquidityUsd:           input.liquidityUsd,
    lpLocked:               input.lpLocked,
    mintAuthorityRevoked:   input.mintAuthorityRevoked,
    freezeAuthorityRevoked: input.freezeAuthorityRevoked,
    bundledWallets:         0,
    sniperCount:            input.sniperCount,
    tokenAgeHours:          ageHours,
  });

  // ── 3. Narrative ──────────────────────────────────────────────────────────
  const narrativeTag = detectNarrative(input.symbol, input.name);
  const narrativeMomentum = DEFAULT_NARRATIVE_STRENGTH[narrativeTag] ?? 0;

  if (input.volume24h > 0) recordNarrativeVolume(narrativeTag, input.volume24h);

  // ── 4. Hype / Social ───────────────────────────────────────────────────────
  const hypeResult = calculateHypeScore({
    mentionCount1h:    input.socialMentions1h  ?? 0,
    mentionCount24h:   input.socialMentions24h ?? 0,
    engagementRate:    input.engagementRate    ?? 0,
    sentimentScore:    input.sentimentScore    ?? 0.5,
    followerGrowthPct: 0,
    telegramMentions:  input.telegramMentions  ?? 0,
    pumpFunComments:   input.pumpFunComments   ?? 0,
  });
  const socialVelocity = hypeResult.hypeScore;

  // ── 5. Lifecycle ──────────────────────────────────────────────────────────
  const lifecycleResult = detectLifecycle({
    ageHours,
    volumeAcceleration: input.volume1h > 0 && input.volume24h > 0
      ? (input.volume1h / (input.volume24h / 24)) : 1,
    holderGrowthRate:   0,
    priceChange1h:      input.priceChange1h,
    priceChange24h:     input.priceChange24h,
    whaleNetFlow:       input.whaleNetFlow ?? 0,
    socialAcceleration: socialVelocity / 100,
    liquidityUsd:       input.liquidityUsd,
    sellBuyRatio:       buySellRatio > 0 ? 1 / buySellRatio : 2,
    rugProbability:     rugResult.rugProbability,
    holderCount:        input.holders,
  });

  // ── 6. Survival ───────────────────────────────────────────────────────────
  const survivalResult = calculateSurvivalScore({
    ageHours,
    liquidityUsd:    input.liquidityUsd,
    volume24hUsd:    input.volume24h,
    holderCount:     input.holders,
    top10HolderPct:  input.top10HolderPct,
    rugProbability:  rugResult.rugProbability,
    aiScore,
    priceChange1h:   input.priceChange1h,
    txCount1h:       input.txCount1h,
  });

  // ── 7. Whale / Smart Money ────────────────────────────────────────────────
  const whaleAccumulation = Math.min(100, Math.max(0,
    (input.whaleNetFlow ?? 0) > 0
      ? Math.round(((input.whaleNetFlow ?? 0) / (input.liquidityUsd / solPriceUsd + 1)) * 100 * 5)
      : Math.round(buySellRatio > 1.5 ? (buySellRatio - 1) * 25 : 0)
  ));
  const smartMoneyScore = Math.min(100, whaleAccumulation * 0.7 + (input.top10HolderPct < 50 ? 30 : 0));

  const convictionScore = Math.min(100, Math.round(
    (Math.min(ageHours, 24) / 24) * 40 +
    Math.min(buySellRatio - 1, 2) * 20 +
    (whaleAccumulation > 50 ? 20 : 0) +
    (input.top10HolderPct < 40 ? 20 : 0)
  ));

  // ── 8. Alpha Memory ───────────────────────────────────────────────────────
  const snapshot = buildTokenSnapshot({
    aiScore,
    riskScore:      100 - rugResult.rugProbability,
    rugProbability: rugResult.rugProbability,
    narrativeTag,
    hypeScore:      hypeResult.hypeScore,
    whaleScore:     whaleAccumulation,
    holderCount:    input.holders,
    liquidityUsd:   input.liquidityUsd,
    volume24hUsd:   input.volume24h,
    ageHours,
    lifecycleStage: lifecycleResult.stage,
  });
  // Empty history — callers can pass enriched historical records via DB
  const memoryResult = calculateAlphaSimilarity(snapshot, []);

  // ── 9. Opportunity Score ──────────────────────────────────────────────────
  const volBreakoutScore = input.volume5m > 0 && input.volume1h > 0
    ? Math.min(100, (input.volume5m / (input.volume1h / 12)) * 50) : 50;

  const opportunityResult = calculateOpportunityScore({
    narrativeMomentum,
    whaleAccumulation,
    volumeBreakoutScore: volBreakoutScore,
    socialVelocity,
    alphaSimilarity:     memoryResult.similarityScore,
    lifecycleStage:      lifecycleResult.stage,
    riskScore:           100 - rugResult.rugProbability,
    rugProbability:      rugResult.rugProbability,
    aiScore,
    survivalScore:       survivalResult.overall,
    regimeMultiplier,
    priceAlreadyUp24h:   Math.max(0, input.priceChange24h),
    marketCapUsd:        input.marketCapUsd,
  });

  // ── 10. GAD Score ─────────────────────────────────────────────────────────
  const gadResult = calculateGadScore({
    aiScore,
    narrativeScore: narrativeMomentum,
    hypeScore:      hypeResult.hypeScore,
    whaleScore:     whaleAccumulation,
    riskScore:      rugResult.rugProbability,
    survivalScore:  survivalResult.overall,
    rugProbability: rugResult.rugProbability,
  });

  // ── 11. Holder Velocity ───────────────────────────────────────────────────
  if (input.holders > 0) recordHolderCount(input.mint, input.holders);
  const holderVelocity: HolderVelocity = calculateHolderVelocity(input.mint, input.holders);

  // ── 12. Wallet Quality (heuristic) ────────────────────────────────────────
  const walletQuality: WalletQuality = {
    qualityScore: Math.min(100, Math.round(
      (input.top10HolderPct < 50 ? 40 : 10) +
      (buySellRatio > 1.2 && buySellRatio < 4 ? 30 : 0) +
      (input.holders > 200 ? 30 : (input.holders / 200) * 30)
    )),
    diversityScore:   Math.max(0, 100 - input.top10HolderPct),
    avgWalletAgeDays: ageHours / 24,
    smartMoneyCount:  Math.floor(smartMoneyScore / 20),
    newWalletPct:     Math.max(0, 100 - Math.min(100, input.holders / 5)),
    topBuyerDnaTags:  [],
    topBuyerRepTags:  [],
  };

  // ── 13. Slippage & Exit Liquidity ─────────────────────────────────────────
  const slippageRisk = await analyzeSlippage(input.mint, input.liquidityUsd, input.priceUsd);
  const exitLiquidityScore = Math.min(100, Math.round(
    (input.liquidityUsd / 10000) * 30 +
    (1 - slippageRisk.usd1000 / 100) * 40 +
    (buySellRatio > 0.5 ? 30 : 0)
  ));

  // ── 14. Narrative Capital Flow ────────────────────────────────────────────
  const narrativeFlow = getNarrativeFlow(narrativeTag, input.volume24h);

  // ── 15. Cluster Detection (async, best-effort for new tokens) ────────────
  let clusterDetection: ClusterResult = { bundledWallets: 0, clusterRisk: 'NONE', coordinatedBuyPct: 0, patterns: [] };
  if (input.heliusApiKey && ageHours < 2) {
    clusterDetection = await detectClusters(input.mint, input.heliusApiKey).catch(() => clusterDetection);
  }

  // ── 16. Developer Intelligence ────────────────────────────────────────────
  const devIntelligence = input.devWallet && input.heliusApiKey
    ? await analyzeDevBehavior(input.mint, input.devWallet, input.heliusApiKey).catch(() => ({
        devWallet: input.devWallet!, devHolding: true, devSoldPct: 0,
        devInitialBuySol: 0, devTransferCount: 0, devConviction: 'UNKNOWN' as const, riskFlag: false,
      }))
    : { devWallet: '', devHolding: true, devSoldPct: 0, devInitialBuySol: 0, devTransferCount: 0, devConviction: 'UNKNOWN' as const, riskFlag: false };

  // ── 17. Confidence ────────────────────────────────────────────────────────
  const dataPoints = [
    input.liquidityUsd > 0, input.holders > 0, input.volume24h > 0,
    !!input.socialMentions1h, !!input.devWallet, !!input.heliusApiKey,
  ].filter(Boolean).length;
  const confidenceScore = Math.round((dataPoints / 6) * 100);
  const confidenceLevel: TokenIntelligence['confidenceLevel'] =
    confidenceScore >= 70 ? 'HIGH' : confidenceScore >= 40 ? 'MEDIUM' : 'LOW';

  // ── 18. Signals & Red Flags ───────────────────────────────────────────────
  const signals: string[] = [];
  const redFlags: string[] = [];

  if (whaleAccumulation > 60)
    signals.push(`Whale accumulation score ${whaleAccumulation}`);
  if (holderVelocity.per5m > 10)
    signals.push(`Holder velocity +${holderVelocity.per5m} in last 5m`);
  if (narrativeFlow.capitalFlowing)
    signals.push(`Capital flowing into ${narrativeTag} narrative`);
  if (memoryResult.similarityScore > 70)
    signals.push(`${memoryResult.similarityScore}% similar to past winners (${memoryResult.avgWinnerGainX.toFixed(1)}x avg)`);
  if (gadResult.gadScore >= 75)
    signals.push(`GAD Score ${gadResult.gadScore} (${gadResult.rating})`);
  if (lifecycleResult.stage === 'ACCUMULATION')
    signals.push('Token in ACCUMULATION phase');
  if (lifecycleResult.stage === 'BREAKOUT')
    signals.push('BREAKOUT phase detected');
  if (devIntelligence.devConviction === 'HOLDING')
    signals.push('Dev still holding');

  if (rugResult.rugProbability > 60)
    redFlags.push(`Rug probability ${rugResult.rugProbability}%`);
  if (devIntelligence.devSoldPct > 50)
    redFlags.push(`Dev sold ${devIntelligence.devSoldPct}% of holdings`);
  if (clusterDetection.clusterRisk === 'HIGH')
    redFlags.push('Bundled wallets detected (coordinated launch)');
  if (input.top10HolderPct > 80)
    redFlags.push(`Top 10 hold ${input.top10HolderPct}% — concentration risk`);
  if (exitLiquidityScore < 30)
    redFlags.push('Low exit liquidity — hard to sell at size');
  if (slippageRisk.usd1000 > 10)
    redFlags.push(`High slippage at $1k: ${slippageRisk.usd1000}%`);
  if (lifecycleResult.stage === 'DISTRIBUTION')
    redFlags.push('DISTRIBUTION phase — insiders likely selling');

  return {
    mint: input.mint, symbol: input.symbol, name: input.name,

    priceUsd: input.priceUsd, marketCapUsd: input.marketCapUsd,
    liquidityUsd: input.liquidityUsd, volume5m: input.volume5m,
    volume15m: input.volume15m, volume1h: input.volume1h,
    volume24h: input.volume24h, holders: input.holders,
    ageMins: input.ageMins, buySellRatio, txCount1h: input.txCount1h,

    holderVelocity, walletQuality, whaleAccumulation,
    smartMoneyScore, convictionScore, clusterDetection,

    devIntelligence,

    rugProbability: rugResult.rugProbability, slippageRisk, exitLiquidityScore,

    narrativeTag, narrativeFlow, socialVelocity,
    hypeScore: hypeResult.hypeScore,
    lifecycleStage: lifecycleResult.stage,
    marketRegime,

    aiScore, gadScore: gadResult.gadScore, gadScoreLabel: gadResult.rating,
    opportunityScore: opportunityResult.opportunityScore,
    alphaSimilarity: {
      score: memoryResult.similarityScore,
      bestMatch: memoryResult.topMatchOutcome,
      expectedReturn: memoryResult.avgWinnerGainX > 0
        ? `${memoryResult.avgWinnerGainX.toFixed(0)}x avg`
        : 'unknown',
    },
    survivalScores: {
      h1:  survivalResult.survival1h,
      h6:  survivalResult.survival6h,
      h24: survivalResult.survival24h,
      d7:  survivalResult.survival7d,
    },

    confidenceScore, confidenceLevel, signals, redFlags,

    analyzedAt: now,
    dataQuality: confidenceScore >= 70 ? 'FULL' : 'PARTIAL',
  };
}
