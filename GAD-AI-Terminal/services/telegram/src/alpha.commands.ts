/**
 * Sprint 13 — GAD Alpha Engine Telegram Commands
 * /opportunity /replay /lifecycle /regime /feed /reputation /memory /buy
 */
import TelegramBot from 'node-telegram-bot-api';
import axios from 'axios';
import { lifecycleEmoji } from '@lib/lifecycle';
import { regimeEmoji } from '@lib/regime';
import { reputationEmoji } from '@lib/reputation';

const API_BASE  = process.env.API_BASE_URL || 'http://localhost:4000';
const SITE_URL  = process.env.SITE_URL     || 'https://gadai.shop';
const PAGE_SIZE = 8;

async function apiGet<T = any>(path: string): Promise<T> {
  const res = await axios.get<T>(`${API_BASE}${path}`, { timeout: 10000 });
  return res.data;
}
async function apiPost<T = any>(path: string, body: unknown): Promise<T> {
  const res = await axios.post<T>(`${API_BASE}${path}`, body, { timeout: 10000 });
  return res.data;
}

async function send(bot: TelegramBot, chatId: number, text: string, extra: TelegramBot.SendMessageOptions = {}) {
  return bot.sendMessage(chatId, text, { parse_mode: 'Markdown', ...extra });
}

function fmtNum(n: number | null | undefined, dec = 0): string {
  if (n == null) return '?';
  return n.toFixed(dec);
}
function fmtMC(mc: number | null | undefined): string {
  if (!mc) return '?';
  if (mc >= 1_000_000) return `$${(mc / 1_000_000).toFixed(1)}M`;
  if (mc >= 1_000) return `$${(mc / 1_000).toFixed(0)}K`;
  return `$${mc}`;
}

// ─── Format opportunity token ──────────────────────────────────────────────
function fmtOpportunity(o: any, i: number): string {
  const stage  = o.lifecycle_stage ?? '?';
  const emoji  = lifecycleEmoji(stage as any) ?? '•';
  const upside = o.estimated_upside_x ? ` ~${o.estimated_upside_x}x` : '';
  return (
    `${i + 1}. *${o.symbol ?? '?'}* ${emoji} ${stage}\n` +
    `   Opp: *${o.opportunity_score}* | GAD: ${o.gad_score ?? '?'} | Risk: ${o.risk_score ?? '?'}\n` +
    `   MC: ${fmtMC(o.market_cap)}${upside}\n` +
    `   \`${o.mint_address}\``
  );
}

// ─── Register all Alpha commands ───────────────────────────────────────────
export function registerAlphaCommands(
  bot: TelegramBot,
  requireSub: (chatId: number, tgId: number) => Promise<boolean>
) {

  // ── /opportunity — top early opportunity tokens ──────────────────────────
  bot.onText(/\/opportunity/, (msg) => {
    const chatId = msg.chat.id;
    const tgId   = msg.from?.id ?? chatId;
    (async () => {
      if (!await requireSub(chatId, tgId)) return;
      const data = await apiGet('/opportunity?min_score=50&limit=16');
      const list = data.opportunities ?? [];
      if (!list.length) {
        return send(bot, chatId, '🔍 No opportunities found right now. System is warming up or market is quiet.');
      }
      const regime = await apiGet('/regime').then(r => r.regime).catch(() => null);
      const regText = regime
        ? `\n${regimeEmoji(regime.regime)} Market: *${regime.regime}* (confidence ${Math.round(regime.confidence * 100)}%)\n`
        : '';

      const text = `🎯 *TOP OPPORTUNITIES*${regText}\n` +
        list.slice(0, PAGE_SIZE).map((o: any, i: number) => fmtOpportunity(o, i)).join('\n\n');

      send(bot, chatId, text, {
        reply_markup: {
          inline_keyboard: [
            list.length > PAGE_SIZE
              ? [{ text: 'Next ▶', callback_data: 'opportunity:1' }]
              : []
          ].filter(r => r.length > 0)
        }
      });
    })().catch(err => bot.sendMessage(chatId, `❌ ${err.message}`).catch(() => {}));
  });

  // ── /replay [hours] — historical signals with outcomes ───────────────────
  bot.onText(/\/replay ?(\d+)?/, (msg, match) => {
    const chatId = msg.chat.id;
    const tgId   = msg.from?.id ?? chatId;
    const hours  = Number(match?.[1] ?? 24);
    (async () => {
      if (!await requireSub(chatId, tgId)) return;
      send(bot, chatId, `🎬 Loading signals from last ${hours}h…`);
      const data = await apiGet(`/replay?hours=${hours}`);
      const { signals, summary } = data;

      if (!signals?.length) {
        return send(bot, chatId, `📭 No signals found for the last ${hours}h. System needs more runtime.`);
      }

      let text = `🎬 *REPLAY — Last ${hours}h*\n`;
      text += `📊 ${summary.totalSignals} signals`;
      if (summary.winRate != null) {
        text += ` | Win Rate: *${summary.winRate}%*`;
        text += ` | Avg 24h: *${summary.avgGain24h > 0 ? '+' : ''}${summary.avgGain24h}%*`;
      } else {
        text += ` (outcomes pending — need ${hours}h+ runtime)`;
      }
      text += '\n\n';

      text += signals.slice(0, 8).map((s: any, i: number) => {
        const outcome = s.outcome_confirmed
          ? (s.outcome_24h_pct > 0 ? `✅ +${fmtNum(s.outcome_24h_pct, 0)}%` : `❌ ${fmtNum(s.outcome_24h_pct, 0)}%`)
          : '⏳ pending';
        return (
          `${i + 1}. *${s.symbol ?? '?'}* — ${s.recommendation ?? '?'}\n` +
          `   Score: ${s.signal_score} | Stage: ${s.lifecycle_stage ?? '?'} | ${outcome}\n` +
          `   \`${s.mint_address?.slice(0, 16)}…\``
        );
      }).join('\n\n');

      send(bot, chatId, text);
    })().catch(err => bot.sendMessage(chatId, `❌ ${err.message}`).catch(() => {}));
  });

  // ── /backtest [30|90|180] — strategy backtest results ───────────────────
  bot.onText(/\/backtest ?(\d+)?/, (msg, match) => {
    const chatId = msg.chat.id;
    const tgId   = msg.from?.id ?? chatId;
    const days   = Math.min(Number(match?.[1] ?? 30), 180);
    (async () => {
      if (!await requireSub(chatId, tgId)) return;
      send(bot, chatId, `📊 Running ${days}-day backtest…`);
      const data = await apiGet(`/replay/backtest?days=${days}&min_score=70`);
      const bt   = data.backtest;
      if (!bt) {
        return send(bot, chatId,
          `📊 *Backtest — ${days} days*\n\n` +
          `⏳ Insufficient data. The system needs to run for at least ${days} days to generate this report.\n\n` +
          `Try again after more runtime.`
        );
      }
      send(bot, chatId,
        `📊 *Backtest — ${days} days*\n\n` +
        `Signals: *${bt.total_signals}* | Wins: *${bt.winning_signals}*\n` +
        `Win Rate: *${bt.win_rate}%*\n` +
        `Avg 24h Gain: *${bt.avg_gain_pct > 0 ? '+' : ''}${bt.avg_gain_pct}%*\n` +
        `Best: *+${bt.max_gain_pct}%* | Worst: *${bt.max_loss_pct}%*\n\n` +
        `Strategy: GAD Score ≥ 70 signals`
      );
    })().catch(err => bot.sendMessage(chatId, `❌ ${err.message}`).catch(() => {}));
  });

  // ── /lifecycle <mint> — lifecycle stage of a token ───────────────────────
  bot.onText(/\/lifecycle (.+)/, (msg, match) => {
    const chatId = msg.chat.id;
    const tgId   = msg.from?.id ?? chatId;
    const mint   = (match?.[1] ?? '').trim();
    (async () => {
      if (!await requireSub(chatId, tgId)) return;
      const data = await apiGet(`/lifecycle/${mint}`);
      const lc   = data.lifecycle;
      const emoji = lifecycleEmoji(lc.stage);

      let text = `${emoji} *${lc.symbol ?? mint.slice(0, 8)}* — ${lc.stage}\n\n`;
      text += `Stage Confidence: *${lc.stage_score}/100*\n`;
      text += `${lc.explanation}\n\n`;

      if (data.transitions?.length) {
        text += `*Recent transitions:*\n`;
        text += data.transitions.slice(0, 3).map((t: any) =>
          `  ${t.from_stage ?? '?'} → ${t.to_stage} (${new Date(t.transitioned_at).toLocaleString()})`
        ).join('\n');
      }
      text += `\n\n\`${mint}\``;
      send(bot, chatId, text);
    })().catch(err => bot.sendMessage(chatId, `❌ ${err.message ?? 'Not found'}`).catch(() => {}));
  });

  // ── /regime — current market regime ──────────────────────────────────────
  bot.onText(/\/regime/, (msg) => {
    const chatId = msg.chat.id;
    (async () => {
      const data   = await apiGet('/regime');
      const regime = data.regime;
      const emoji  = regimeEmoji(regime.regime);
      send(bot, chatId,
        `${emoji} *Market Regime: ${regime.regime}*\n` +
        `Confidence: ${Math.round(regime.confidence * 100)}%\n\n` +
        `${regime.explanation ?? ''}\n\n` +
        `*Action:* ${regime.action_guide ?? 'No guide available.'}\n\n` +
        `SOL: $${regime.sol_price ?? '?'} | F&G: ${regime.fear_greed_index ?? '?'}/100`
      );
    })().catch(err => bot.sendMessage(chatId, `❌ ${err.message}`).catch(() => {}));
  });

  // ── /feed — personalized AI feed ─────────────────────────────────────────
  bot.onText(/\/feed/, (msg) => {
    const chatId = msg.chat.id;
    const tgId   = msg.from?.id ?? chatId;
    (async () => {
      if (!await requireSub(chatId, tgId)) return;
      const data = await apiGet(`/feed/${tgId}`);
      const feed = data.feed ?? [];
      if (!feed.length) {
        return send(bot, chatId,
          `📡 *Personal AI Feed*\n\nNo tokens match your preferences yet.\n\nUse /setfeed to customize your feed.`
        );
      }
      const text = `📡 *Your AI Feed (${feed.length})*\n\n` +
        feed.slice(0, PAGE_SIZE).map((t: any, i: number) => {
          const stage = t.lifecycle_stage ?? '?';
          const emoji = lifecycleEmoji(stage as any) ?? '•';
          return (
            `${i + 1}. *${t.symbol ?? '?'}* ${emoji}\n` +
            `   GAD: *${t.gad_score}* | Opp: ${t.opportunity_score ?? '?'} | ${t.narrative_tag ?? 'UNKNOWN'}\n` +
            `   \`${t.mint_address}\``
          );
        }).join('\n\n');

      send(bot, chatId, text);
    })().catch(err => bot.sendMessage(chatId, `❌ ${err.message}`).catch(() => {}));
  });

  // ── /setfeed — configure personal feed ───────────────────────────────────
  bot.onText(/\/setfeed (.+)/, (msg, match) => {
    const chatId = msg.chat.id;
    const tgId   = msg.from?.id ?? chatId;
    const input  = (match?.[1] ?? '').trim().toUpperCase();
    (async () => {
      if (!await requireSub(chatId, tgId)) return;

      // Parse: "AI DOG LOW_RISK" or "narrative=AI,DOG stage=BIRTH,ACCUMULATION"
      const validNarratives = ['AI_AGENT', 'DOG', 'CAT', 'PEPE', 'ELON', 'POLITICS', 'ANIME', 'MEME', 'DEFI', 'GAMING', 'NFT'];
      const validStages     = ['BIRTH', 'ACCUMULATION', 'BREAKOUT', 'HYPE', 'DISTRIBUTION'];
      const words           = input.split(/[\s,]+/);

      const preferred_narratives = words.filter(w => validNarratives.includes(w) || validNarratives.includes('AI_AGENT'.replace('AI', w)));
      const preferred_stages     = words.filter(w => validStages.includes(w));
      const lowRisk = words.includes('LOW_RISK') || words.includes('SAFE');

      await apiPost('/feed/preferences', {
        user_key: String(tgId),
        preferred_narratives,
        preferred_stages,
        max_risk_score: lowRisk ? 50 : 70
      });

      send(bot, chatId,
        `✅ *Feed configured!*\n\n` +
        `Narratives: ${preferred_narratives.length ? preferred_narratives.join(', ') : 'all'}\n` +
        `Stages: ${preferred_stages.length ? preferred_stages.join(', ') : 'all'}\n` +
        `Max risk: ${lowRisk ? '50' : '70'}\n\n` +
        `Use /feed to see your personalized feed.`
      );
    })().catch(err => bot.sendMessage(chatId, `❌ ${err.message}`).catch(() => {}));
  });

  // ── /reputation <address> — wallet reputation ────────────────────────────
  bot.onText(/\/reputation (.+)/, (msg, match) => {
    const chatId  = msg.chat.id;
    const tgId    = msg.from?.id ?? chatId;
    const address = (match?.[1] ?? '').trim();
    (async () => {
      if (!await requireSub(chatId, tgId)) return;
      const data = await apiGet(`/reputation/${address}`);
      const rep  = data.reputation;
      const emoji = reputationEmoji(rep.reputation_tier);

      let text = `${emoji} *Wallet Reputation*\n\n`;
      text += `Tier: *${rep.reputation_tier}* | Score: *${rep.reputation_score}/100*\n`;
      text += `${rep.description ?? ''}\n`;
      if (rep.warning) text += `\n⚠️ ${rep.warning}\n`;
      text += `\nWins: ${rep.verified_wins ?? 0} | Rugs: ${rep.verified_rugs ?? 0}`;
      text += `\nAvg hold: ${fmtNum(rep.avg_hold_hours, 0)}h\n`;
      text += `\`${address.slice(0, 20)}…\``;

      send(bot, chatId, text);
    })().catch(err => bot.sendMessage(chatId, `❌ ${err.message ?? 'Wallet not found'}`).catch(() => {}));
  });

  // ── /memory <mint> — alpha similarity ────────────────────────────────────
  bot.onText(/\/memory (.+)/, (msg, match) => {
    const chatId = msg.chat.id;
    const tgId   = msg.from?.id ?? chatId;
    const mint   = (match?.[1] ?? '').trim();
    (async () => {
      if (!await requireSub(chatId, tgId)) return;
      const data = await apiGet(`/memory/${mint}`);
      const sim  = data.alphaSimilarity;

      let text = `🧠 *Alpha Memory Analysis*\n\n`;
      text += `Similarity to winners: *${sim.similarity_score}%*\n`;
      text += `Matched winners: *${sim.matched_winners}*`;
      if (sim.avg_winner_gain_x > 0) text += ` (avg *${fmtNum(sim.avg_winner_gain_x, 1)}x*)\n`;
      else text += '\n';
      if (sim.top_match_outcome) text += `Top match type: ${sim.top_match_outcome}\n`;
      text += `\n${sim.explanation ?? ''}\n\n\`${mint}\``;

      send(bot, chatId, text);
    })().catch(err => bot.sendMessage(chatId, `❌ ${err.message ?? 'No data yet'}`).catch(() => {}));
  });

  // ── /narratives — narrative rotation ranking ──────────────────────────────
  bot.onText(/\/narratives/, (msg) => {
    const chatId = msg.chat.id;
    (async () => {
      const data = await apiGet('/narratives/rotation');
      const rot  = data.rotation ?? [];
      if (!rot.length) return send(bot, chatId, '📊 Narrative rotation data not yet available.');

      const text = `🌀 *Narrative Rotation*\n\n` +
        rot.slice(0, 8).map((n: any) => {
          const arrow = n.momentum === 'RISING' ? '📈' : n.momentum === 'FALLING' ? '📉' : '→';
          return `${n.current_rank}. *${n.narrative_tag}* ${arrow} ${n.momentum} (${n.token_count} tokens)`;
        }).join('\n');

      send(bot, chatId, text);
    })().catch(err => bot.sendMessage(chatId, `❌ ${err.message}`).catch(() => {}));
  });

  // ── Callback query extensions for alpha features ──────────────────────────
  return {
    handleAlphaCallback: async (
      bot: TelegramBot,
      action: string,
      param: string,
      chatId: number,
      msgId: number,
      requireSub: (chatId: number, tgId: number) => Promise<boolean>,
      tgId: number
    ) => {
      if (action === 'opportunity') {
        const page = parseInt(param ?? '0', 10) || 0;
        if (!await requireSub(chatId, tgId)) return;
        const data = await apiGet('/opportunity?min_score=50&limit=50');
        const list = data.opportunities ?? [];
        const start = page * PAGE_SIZE;
        const slice = list.slice(start, start + PAGE_SIZE);
        const hasNext = start + PAGE_SIZE < list.length;
        const hasPrev = page > 0;

        const row: TelegramBot.InlineKeyboardButton[] = [];
        if (hasPrev) row.push({ text: '◀ Prev', callback_data: `opportunity:${page - 1}` });
        if (hasNext) row.push({ text: 'Next ▶', callback_data: `opportunity:${page + 1}` });

        const text = `🎯 *Opportunities (${list.length})* — page ${page + 1}\n\n` +
          slice.map((o: any, i: number) => fmtOpportunity(o, start + i)).join('\n\n');

        bot.editMessageText(text, {
          chat_id: chatId, message_id: msgId, parse_mode: 'Markdown',
          reply_markup: row.length ? { inline_keyboard: [row] } : undefined
        }).catch(() => {});
      }
    }
  };

  // ── /analyze <mint> — deep intelligence analysis ───────────────────────────
  bot.onText(/\/analyze(?:\s+(\S+))?/, (msg, match) => {
    const chatId = msg.chat.id;
    const tgId   = msg.from?.id ?? chatId;
    const mint   = match?.[1]?.trim();

    (async () => {
      if (!await requireSub(chatId, tgId)) return;
      if (!mint) {
        return send(bot, chatId, '❓ Usage: `/analyze <mint_address>`\n\nExample:\n`/analyze DfaPx6oj5gHcEbBa8N2JSmdLgdQX4Tq7EcJPbTGya4Yx`');
      }

      await send(bot, chatId, `🔍 Analyzing \`${mint}\`...`);

      const data = await apiGet(`/tokens/${mint}/intelligence`);
      const intel = data.intelligence;
      if (!intel) return send(bot, chatId, '❌ No data found for this token.');

      const {
        symbol, ageMins, marketCapUsd, liquidityUsd, holders,
        aiScore, gadScore, gadScoreLabel, opportunityScore,
        rugProbability, confidenceScore, confidenceLevel,
        lifecycleStage, narrativeTag, whaleAccumulation,
        holderVelocity, slippageRisk, survivalScores,
        signals, redFlags, devIntelligence, buySellRatio,
      } = intel;

      const age = ageMins < 60
        ? `${Math.round(ageMins)}min`
        : `${(ageMins / 60).toFixed(1)}h`;

      const mc  = marketCapUsd >= 1e6 ? `$${(marketCapUsd / 1e6).toFixed(1)}M`
                : marketCapUsd >= 1e3 ? `$${(marketCapUsd / 1e3).toFixed(0)}K`
                : `$${marketCapUsd?.toFixed(0) ?? 0}`;

      const liq = liquidityUsd >= 1e3 ? `$${(liquidityUsd / 1e3).toFixed(0)}K` : `$${liquidityUsd?.toFixed(0) ?? 0}`;

      const signalLines = (signals?.length ?? 0) > 0
        ? signals.map((s: string) => `✅ ${s}`).join('\n')
        : '• No strong signals detected';

      const flagLines = (redFlags?.length ?? 0) > 0
        ? redFlags.map((f: string) => `⚠️ ${f}`).join('\n')
        : '• No red flags detected';

      const dev = devIntelligence?.devConviction !== 'UNKNOWN'
        ? `Dev: ${devIntelligence.devConviction} (sold ${devIntelligence.devSoldPct}%)`
        : '';

      const text = [
        `🧠 *GAD INTELLIGENCE — ${symbol ?? '?'}*`,
        ``,
        `🆔 \`${mint}\``,
        `🕐 Age: ${age} | MC: ${mc} | Liq: ${liq}`,
        `👥 Holders: ${holders} ${holderVelocity?.per5m > 0 ? `(+${holderVelocity.per5m}/5m)` : ''}`,
        `📈 B/S Ratio: ${buySellRatio?.toFixed(2) ?? '?'}`,
        ``,
        `*── SCORES ──*`,
        `🤖 AI: ${aiScore} | GAD: ${gadScore} (${gadScoreLabel})`,
        `🎯 Opportunity: ${opportunityScore} | Whale: ${whaleAccumulation}`,
        `💀 Rug: ${rugProbability}% | Narrative: ${narrativeTag}`,
        `📊 Stage: ${lifecycleStage}`,
        ``,
        `*── SURVIVAL ──*`,
        `1h: ${survivalScores?.h1 ?? '?'}% | 6h: ${survivalScores?.h6 ?? '?'}% | 24h: ${survivalScores?.h24 ?? '?'}% | 7d: ${survivalScores?.d7 ?? '?'}%`,
        ``,
        `*── EXIT ──*`,
        `Slippage $1k: ${slippageRisk?.usd1000 ?? '?'}%`,
        dev,
        ``,
        `*── SIGNALS ──*`,
        signalLines,
        ``,
        `*── RED FLAGS ──*`,
        flagLines,
        ``,
        `_Confidence: ${confidenceScore}% (${confidenceLevel})_`,
      ].filter(Boolean).join('\n');

      send(bot, chatId, text);
    })().catch(err => send(bot, chatId, `❌ Error: ${err.message}`));
  });
}
