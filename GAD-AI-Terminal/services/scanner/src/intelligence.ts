/**
 * GAD Intelligence Layer — Sprint 13 (full Alpha Engine)
 * Pipeline: Narrative → Hype → Rug → Survival → GAD →
 *           Lifecycle → Opportunity → Memory → Signal History
 */
import { query } from '@lib/db';
import { calculateNarrativeScore, detectNarrative } from '@lib/narrative';
import { calculateHypeScore, buildSocialDataFromMetrics } from '@lib/social';
import { calculateRugProbability, fetchOnChainRugData, fetchTopHolderConcentration } from '@lib/rug';
import { calculateSurvivalScore } from '@lib/survival';
import { calculateGadScore } from '@lib/gad-score';
import { detectLifecycle, lifecycleBonus } from '@lib/lifecycle';
import { calculateOpportunityScore, calculateVolumeBreakout, calculateNarrativeMomentum } from '@lib/opportunity';
import { calculateAlphaSimilarity, buildTokenSnapshot, labelOutcome } from '@lib/memory';
import { regimeFromDb } from '@lib/regime';
import { getConnection } from '@lib/solana';

const HELIUS_KEY = process.env.HELIUS_API_KEY ?? '';

interface TokenRow {
  id: string;
  mint_address: string;
  symbol: string | null;
  name: string | null;
  market_cap: number | null;
  holder_count: number | null;
  liquidity: number | null;
  token_age_hours: number | null;
}

/** Full intelligence pipeline for a single token */
export async function runIntelligenceEngines(
  tokenId: string,
  metrics: {
    volume_5m: number; volume_1h: number; volume_24h: number;
    tx_count_5m: number; tx_count_1h: number;
    liquidity_change: number; price_change_1h: number; price_change_24h: number;
  }
): Promise<void> {
  // ─── Load token ─────────────────────────────────────────────────────────
  const tokenQ = await query<TokenRow>('SELECT * FROM tokens WHERE id = $1', [tokenId]);
  if (!tokenQ.rows.length) return;
  const tok = tokenQ.rows[0];

  const [scoreQ, regimeQ, trendQ] = await Promise.all([
    query<{ ai_score: number; risk_score: number; whale_score: number }>(
      `SELECT s.ai_score, s.risk_score, COALESCE(ws.whale_score, 50) AS whale_score
       FROM score_history s
       LEFT JOIN whale_scores ws ON ws.wallet_id IS NOT NULL
       WHERE s.token_id = $1 ORDER BY s.created_at DESC LIMIT 1`,
      [tokenId]
    ),
    query('SELECT regime, confidence FROM market_regime ORDER BY computed_at DESC LIMIT 1'),
    query<{ narrative_tag: string; avg_gad_score: number; current_rank: number; momentum: string }>(
      'SELECT narrative_tag, avg_gad_score, current_rank, momentum FROM narrative_rotation', []
    )
  ]);

  const aiScore    = Number(scoreQ.rows[0]?.ai_score  ?? 50);
  const riskScore  = Number(scoreQ.rows[0]?.risk_score ?? 50);
  const whaleScore = Number(scoreQ.rows[0]?.whale_score ?? 50);
  const ageHours   = Number(tok.token_age_hours ?? 999);

  // Market regime multiplier
  const { multiplier: regimeMultiplier } = regimeQ.rows[0]
    ? regimeFromDb(regimeQ.rows[0])
    : { multiplier: 1.0 };

  // Narrative trend index
  const narrativeRotation = trendQ.rows.reduce<Record<string, { strength: number; rank: number; momentum: string }>>((acc, r) => {
    acc[r.narrative_tag] = { strength: r.avg_gad_score, rank: r.current_rank, momentum: r.momentum };
    return acc;
  }, {});

  // ═══════════════════════════════════════════════════════════════════════════
  // 1. NARRATIVE SCORE
  // ═══════════════════════════════════════════════════════════════════════════
  const narrativeTag = detectNarrative(tok.symbol ?? '', tok.name ?? '');
  const tagTrend = narrativeRotation[narrativeTag];

  const narrativeResult = calculateNarrativeScore({
    symbol: tok.symbol ?? '',
    name:   tok.name   ?? '',
    narrativeStrength: tagTrend?.strength
  });

  await query(
    `INSERT INTO narrative_scores (token_id, narrative_tag, narrative_score, raw_score, trend_boost, explanation)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (token_id) DO UPDATE
       SET narrative_tag = $2, narrative_score = $3, raw_score = $4,
           trend_boost = $5, explanation = $6, created_at = now()`,
    [tokenId, narrativeResult.tag, narrativeResult.narrativeScore,
     narrativeResult.rawScore, narrativeResult.trendBoost, narrativeResult.explanation]
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // 2. HYPE / SOCIAL SCORE
  // ═══════════════════════════════════════════════════════════════════════════
  const socialData = buildSocialDataFromMetrics({
    volume5m:  metrics.volume_5m,
    volume1h:  metrics.volume_1h,
    txCount5m: metrics.tx_count_5m,
    txCount1h: metrics.tx_count_1h,
    isNewToken: ageHours < 1
  });
  const hypeResult = calculateHypeScore(socialData);

  await query(
    `INSERT INTO social_metrics
       (token_id, hype_score, mention_count, mention_velocity, engagement_rate, sentiment, sources)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (token_id) DO UPDATE
       SET hype_score = $2, mention_count = $3, mention_velocity = $4,
           engagement_rate = $5, sentiment = $6, sources = $7, snapshot_at = now()`,
    [tokenId, hypeResult.hypeScore, socialData.mentionCount1h,
     hypeResult.velocityScore / 10, socialData.engagementRate,
     socialData.sentimentScore, JSON.stringify({ telegram: socialData.telegramMentions, pumpfun: socialData.pumpFunComments })]
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // 3. RUG CHECK
  // ═══════════════════════════════════════════════════════════════════════════
  let mintRevoked: boolean | undefined;
  let freezeRevoked: boolean | undefined;
  let top10Pct = 0;

  try {
    const onChain = await fetchOnChainRugData(tok.mint_address, getConnection());
    mintRevoked   = onChain.mintAuthorityRevoked;
    freezeRevoked = onChain.freezeAuthorityRevoked;
    if (HELIUS_KEY) top10Pct = await fetchTopHolderConcentration(tok.mint_address, HELIUS_KEY);
  } catch { /* non-fatal */ }

  // Count snipers from our own wallet_trades (early buyers)
  const sniperQ = await query<{ cnt: string }>(
    `SELECT COUNT(*) AS cnt FROM wallet_trades wt
     WHERE wt.token_id = $1
       AND wt.executed_at < (SELECT first_seen + interval '5 minutes' FROM tokens WHERE id = $1)
       AND wt.side = 'buy'`,
    [tokenId]
  );
  const sniperCount = Number(sniperQ.rows[0]?.cnt ?? 0);

  const rugResult = calculateRugProbability({
    mintAddress:           tok.mint_address,
    top10HolderPct:        top10Pct,
    liquidityUsd:          Number(tok.liquidity ?? 0),
    mintAuthorityRevoked:  mintRevoked,
    freezeAuthorityRevoked: freezeRevoked,
    tokenAgeHours:         ageHours,
    sniperCount
  });

  await query(
    `INSERT INTO rug_scores
       (token_id, rug_probability, mint_authority_revoked, freeze_authority_revoked,
        top10_holder_pct, flags, checked_at)
     VALUES ($1,$2,$3,$4,$5,$6,now())
     ON CONFLICT (token_id) DO UPDATE
       SET rug_probability = $2, mint_authority_revoked = $3,
           freeze_authority_revoked = $4, top10_holder_pct = $5, flags = $6, checked_at = now()`,
    [tokenId, rugResult.rugProbability, mintRevoked ?? false, freezeRevoked ?? false,
     top10Pct, JSON.stringify(rugResult.flags)]
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // 4. SURVIVAL SCORE
  // ═══════════════════════════════════════════════════════════════════════════
  const survivalResult = calculateSurvivalScore({
    ageHours,
    liquidityUsd:   Number(tok.liquidity ?? 0),
    volume24hUsd:   metrics.volume_24h,
    holderCount:    Number(tok.holder_count ?? 0),
    top10HolderPct: top10Pct,
    rugProbability: rugResult.rugProbability,
    aiScore,
    priceChange1h:  metrics.price_change_1h,
    txCount1h:      metrics.tx_count_1h
  });

  await query(
    `INSERT INTO survival_scores (token_id, survival_1h, survival_6h, survival_24h, survival_7d, overall, explanation)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (token_id) DO UPDATE
       SET survival_1h = $2, survival_6h = $3, survival_24h = $4, survival_7d = $5,
           overall = $6, explanation = $7, computed_at = now()`,
    [tokenId, survivalResult.survival1h, survivalResult.survival6h,
     survivalResult.survival24h, survivalResult.survival7d,
     survivalResult.overall, survivalResult.explanation]
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // 5. GAD SCORE
  // ═══════════════════════════════════════════════════════════════════════════
  const gadResult = calculateGadScore({
    aiScore,
    narrativeScore: narrativeResult.narrativeScore,
    hypeScore:      hypeResult.hypeScore,
    whaleScore,
    riskScore,
    survivalScore:  survivalResult.overall,
    rugProbability: rugResult.rugProbability
  });

  await query(
    `INSERT INTO gad_scores
       (token_id, gad_score, ai_score, narrative_score, hype_score,
        whale_score, risk_score, survival_score, rug_probability, explanation)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (token_id) DO UPDATE
       SET gad_score = $2, ai_score = $3, narrative_score = $4, hype_score = $5,
           whale_score = $6, risk_score = $7, survival_score = $8,
           rug_probability = $9, explanation = $10, computed_at = now()`,
    [tokenId, gadResult.gadScore, aiScore, narrativeResult.narrativeScore, hypeResult.hypeScore,
     whaleScore, riskScore, survivalResult.overall, rugResult.rugProbability, gadResult.explanation]
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // 6. LIFECYCLE DETECTION
  // ═══════════════════════════════════════════════════════════════════════════
  const volumeAcceleration = metrics.volume_1h > 0 && metrics.volume_24h > 0
    ? (metrics.volume_1h / (metrics.volume_24h / 24)) - 1
    : 0;

  const lifecycleResult = detectLifecycle({
    ageHours,
    volumeAcceleration,
    holderGrowthRate:    Math.max(0, Number(tok.holder_count ?? 0) / Math.max(1, ageHours)),
    priceChange1h:       metrics.price_change_1h,
    priceChange24h:      metrics.price_change_24h,
    whaleNetFlow:        whaleScore,
    socialAcceleration:  hypeResult.hypeScore,
    liquidityUsd:        Number(tok.liquidity ?? 0),
    sellBuyRatio:        1.0,           // TODO: compute from wallet_trades
    rugProbability:      rugResult.rugProbability,
    holderCount:         Number(tok.holder_count ?? 0)
  });

  // Detect stage transition
  const prevLifecycleQ = await query<{ stage: string }>(
    'SELECT stage FROM token_lifecycle WHERE token_id = $1', [tokenId]
  );
  const prevStage = prevLifecycleQ.rows[0]?.stage;
  const newStage  = lifecycleResult.stage;

  await query(
    `INSERT INTO token_lifecycle
       (token_id, stage, stage_score, volume_acceleration, holder_growth_rate,
        price_momentum, whale_accumulation, social_acceleration, liquidity_depth,
        sell_pressure, explanation, computed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now())
     ON CONFLICT (token_id) DO UPDATE
       SET stage = $2, stage_score = $3, volume_acceleration = $4,
           holder_growth_rate = $5, price_momentum = $6, whale_accumulation = $7,
           social_acceleration = $8, liquidity_depth = $9, sell_pressure = $10,
           explanation = $11, computed_at = now()`,
    [tokenId, newStage, lifecycleResult.stageScore,
     lifecycleResult.factors.volumeAcceleration, lifecycleResult.factors.holderGrowth,
     lifecycleResult.factors.priceMomentum, lifecycleResult.factors.whaleAccumulation,
     lifecycleResult.factors.socialAcceleration, lifecycleResult.factors.liquidityDepth,
     lifecycleResult.factors.sellPressure, lifecycleResult.explanation]
  );

  // Record transition if stage changed
  if (prevStage && prevStage !== newStage) {
    await query(
      `INSERT INTO lifecycle_transitions (token_id, from_stage, to_stage)
       VALUES ($1,$2,$3)`,
      [tokenId, prevStage, newStage]
    );
    console.info(`[lifecycle] ${tok.mint_address}: ${prevStage} → ${newStage}`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 7. ALPHA SIMILARITY (Memory Engine)
  // ═══════════════════════════════════════════════════════════════════════════
  const historicalWinners = await query<any>(
    `SELECT
       snapshot_ai_score AS "aiScore",
       snapshot_risk_score AS "riskScore",
       snapshot_rug_probability AS "rugProbability",
       snapshot_narrative_tag AS "narrativeTag",
       snapshot_hype_score AS "hypeScore",
       snapshot_whale_score AS "whaleScore",
       snapshot_holder_count AS "holderCount",
       snapshot_liquidity_usd AS "liquidityUsd",
       snapshot_volume_24h AS "volume24hUsd",
       snapshot_age_hours AS "ageHours",
       snapshot_lifecycle_stage AS "lifecycleStage",
       outcome, peak_gain_x AS "peakGainX"
     FROM token_memory
     WHERE outcome IS NOT NULL AND outcome != 'NEUTRAL'
     ORDER BY recorded_at DESC LIMIT 200`
  );

  const currentSnap = buildTokenSnapshot({
    aiScore,
    riskScore,
    rugProbability: rugResult.rugProbability,
    narrativeTag:   narrativeResult.tag,
    hypeScore:      hypeResult.hypeScore,
    whaleScore,
    holderCount:    Number(tok.holder_count ?? 0),
    liquidityUsd:   Number(tok.liquidity ?? 0),
    volume24hUsd:   metrics.volume_24h,
    ageHours,
    lifecycleStage: newStage
  });

  const simResult = calculateAlphaSimilarity(currentSnap, historicalWinners.rows);

  await query(
    `INSERT INTO alpha_similarity_cache
       (token_id, similarity_score, matched_winners, avg_winner_gain_x, top_match_outcome, explanation)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (token_id) DO UPDATE
       SET similarity_score = $2, matched_winners = $3, avg_winner_gain_x = $4,
           top_match_outcome = $5, explanation = $6, computed_at = now()`,
    [tokenId, simResult.similarityScore, simResult.matchedWinners,
     simResult.avgWinnerGainX, simResult.topMatchOutcome, simResult.explanation]
  );

  // Save snapshot to memory (for future comparison)
  await query(
    `INSERT INTO token_memory
       (token_id, snapshot_ai_score, snapshot_risk_score, snapshot_gad_score,
        snapshot_rug_probability, snapshot_narrative_tag, snapshot_hype_score,
        snapshot_whale_score, snapshot_holder_count, snapshot_liquidity_usd,
        snapshot_volume_24h, snapshot_age_hours, snapshot_lifecycle_stage)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT DO NOTHING`,
    [tokenId, aiScore, riskScore, gadResult.gadScore, rugResult.rugProbability,
     narrativeResult.tag, hypeResult.hypeScore, whaleScore, Number(tok.holder_count ?? 0),
     Number(tok.liquidity ?? 0), metrics.volume_24h, ageHours, newStage]
  ).catch(() => {}); // non-fatal if already recorded

  // ═══════════════════════════════════════════════════════════════════════════
  // 8. OPPORTUNITY SCORE
  // ═══════════════════════════════════════════════════════════════════════════
  const narrativeMomentum = calculateNarrativeMomentum({
    narrativeTag:         narrativeResult.tag,
    narrativeStrength:    tagTrend?.strength ?? narrativeResult.narrativeScore,
    narrativeRotationRank: tagTrend ? Math.min(14, tagTrend.rank) : 7,
    narrativeMomentumDir: (tagTrend?.momentum ?? 'STABLE') as any
  });

  const volumeBreakout = calculateVolumeBreakout({
    volume5m:      metrics.volume_5m,
    volume1h:      metrics.volume_1h,
    volume24h:     metrics.volume_24h,
    priceChange1h: metrics.price_change_1h
  });

  const oppResult = calculateOpportunityScore({
    narrativeMomentum,
    whaleAccumulation:    whaleScore,
    volumeBreakoutScore:  volumeBreakout,
    socialVelocity:       hypeResult.velocityScore,
    alphaSimilarity:      simResult.similarityScore,
    lifecycleStage:       newStage,
    riskScore,
    rugProbability:       rugResult.rugProbability,
    aiScore,
    survivalScore:        survivalResult.overall,
    regimeMultiplier,
    priceAlreadyUp24h:    Math.max(0, metrics.price_change_24h),
    marketCapUsd:         Number(tok.market_cap ?? 999_999_999)
  });

  // Opportunity expires in 4 hours
  const expiresAt = new Date(Date.now() + 4 * 3_600_000);

  await query(
    `INSERT INTO opportunities
       (token_id, opportunity_score, confidence, narrative_momentum, whale_accumulation,
        volume_breakout, social_velocity, alpha_similarity, lifecycle_stage_bonus,
        risk_penalty, reason, regime_adjusted, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (token_id) DO UPDATE
       SET opportunity_score = $2, confidence = $3, narrative_momentum = $4,
           whale_accumulation = $5, volume_breakout = $6, social_velocity = $7,
           alpha_similarity = $8, lifecycle_stage_bonus = $9, risk_penalty = $10,
           reason = $11, regime_adjusted = $12, expires_at = $13, created_at = now()`,
    [tokenId, oppResult.opportunityScore, oppResult.confidence,
     oppResult.components.narrativeMomentum, oppResult.components.whaleAccumulation,
     oppResult.components.volumeBreakout, oppResult.components.socialVelocity,
     oppResult.components.alphaSimilarity, oppResult.components.lifecycleBonus,
     oppResult.components.riskPenalty, oppResult.reason,
     oppResult.regimeAdjusted, expiresAt]
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // 9. SIGNAL HISTORY (for Replay Engine)
  // ═══════════════════════════════════════════════════════════════════════════
  if (gadResult.gadScore >= 70 || oppResult.opportunityScore >= 60) {
    const signalType = oppResult.opportunityScore >= 60 ? 'OPPORTUNITY' : 'GAD_HIGH';
    await query(
      `INSERT INTO signal_history
         (token_id, signal_type, signal_score, gad_score, opportunity_score,
          lifecycle_stage, recommendation, payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [tokenId, signalType,
       Math.max(gadResult.gadScore, oppResult.opportunityScore),
       gadResult.gadScore, oppResult.opportunityScore,
       newStage, oppResult.recommendation,
       JSON.stringify({
         narrative: narrativeResult.tag,
         rugProbability: rugResult.rugProbability,
         survival24h: survivalResult.survival24h
       })]
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 10. UPDATE NARRATIVE ROTATION
  // ═══════════════════════════════════════════════════════════════════════════
  await query(
    `INSERT INTO narrative_rotation (narrative_tag, token_count, avg_gad_score, avg_opportunity)
     VALUES ($1, 1, $2, $3)
     ON CONFLICT (narrative_tag) DO UPDATE
       SET token_count   = narrative_rotation.token_count + 1,
           avg_gad_score = (narrative_rotation.avg_gad_score * narrative_rotation.token_count + $2)
                           / (narrative_rotation.token_count + 1),
           avg_opportunity = (narrative_rotation.avg_opportunity * narrative_rotation.token_count + $3)
                              / (narrative_rotation.token_count + 1),
           updated_at = now()`,
    [narrativeResult.tag, gadResult.gadScore, oppResult.opportunityScore]
  ).catch(() => {});

  console.info(
    `[intelligence] ${tok.mint_address} | GAD:${gadResult.gadScore} | Opp:${oppResult.opportunityScore} | Stage:${newStage} | Sim:${simResult.similarityScore}%`
  );
}

/** Update outcome for past signals (runs after enough time has passed) */
export async function updateSignalOutcomes(): Promise<void> {
  // Find signals older than 1h but without outcome_1h_pct
  const pending1h = await query<{ id: string; token_id: string; created_at: Date }>(
    `SELECT id, token_id, created_at FROM signal_history
     WHERE outcome_1h_pct IS NULL AND created_at < now() - interval '1 hour'
     LIMIT 50`
  );

  for (const sig of pending1h.rows) {
    // Get price at signal time and now
    const priceQ = await query<{ price_change_1h: number }>(
      `SELECT price_change_1h FROM token_metrics
       WHERE token_id = $1 AND timestamp > $2
       ORDER BY timestamp ASC LIMIT 1`,
      [sig.token_id, sig.created_at.toISOString()]
    );
    if (priceQ.rows.length) {
      await query(
        `UPDATE signal_history SET outcome_1h_pct = $1 WHERE id = $2`,
        [priceQ.rows[0].price_change_1h, sig.id]
      );
    }
  }

  // Mark confirmed for 24h signals
  await query(
    `UPDATE signal_history
     SET outcome_confirmed = true
     WHERE outcome_1h_pct IS NOT NULL
       AND created_at < now() - interval '24 hours'
       AND outcome_confirmed = false`
  );

  // Update memory outcomes (tokens that pumped or rugged)
  await updateMemoryOutcomes();
}

async function updateMemoryOutcomes(): Promise<void> {
  // Find memory records without outcomes, token age > 24h
  const records = await query<{ id: string; token_id: string; snapshot_gad_score: number }>(
    `SELECT tm.id, tm.token_id, tm.snapshot_gad_score
     FROM token_memory tm
     WHERE tm.outcome IS NULL
       AND tm.recorded_at < now() - interval '24 hours'
     LIMIT 20`
  );

  for (const rec of records.rows) {
    // Estimate peak gain from score_history changes
    const peakQ = await query<{ max_price_change: number }>(
      `SELECT MAX(price_change_24h) AS max_price_change
       FROM token_metrics WHERE token_id = $1`,
      [rec.token_id]
    );
    const rugQ = await query<{ rug_probability: number }>(
      `SELECT rug_probability FROM rug_scores WHERE token_id = $1`, [rec.token_id]
    );

    const peakGainX  = Math.max(1, (Number(peakQ.rows[0]?.max_price_change ?? 0) / 100) + 1);
    const rugProb    = Number(rugQ.rows[0]?.rug_probability ?? 0);
    const outcome    = rugProb > 70 ? 'RUG' : labelOutcome(peakGainX);

    await query(
      `UPDATE token_memory SET outcome = $1, peak_gain_x = $2, outcome_confirmed_at = now()
       WHERE id = $3`,
      [outcome, peakGainX, rec.id]
    );
  }
}
