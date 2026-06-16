/**
 * Alpha Signal Broadcaster
 * Posts top GAD signals to @gadfamilytg every 6 hours.
 * Shows tokens with high score + momentum — social proof for marketing.
 */

import axios from 'axios';
import TelegramBot from 'node-telegram-bot-api';

const API_BASE   = process.env.API_BASE_URL    || 'http://localhost:4000';
const CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID || '@gadfamilytg';
const INTERVAL_H = Number(process.env.BROADCAST_INTERVAL_H || '6');
const ENABLED    = process.env.BROADCAST_SIGNALS === 'true';

async function fetchTopTokens(): Promise<any[]> {
  try {
    const r = await axios.get(`${API_BASE}/tokens/highscore?threshold=70&limit=20`, { timeout: 8000 });
    return (r.data?.tokens ?? r.data ?? []).slice(0, 20);
  } catch { return []; }
}

async function fetchFearGreed(): Promise<{ value: number; label: string }> {
  try {
    const r = await axios.get('https://api.alternative.me/fng/?limit=1', { timeout: 5000 });
    const d = r.data?.data?.[0];
    return { value: Number(d?.value ?? 50), label: d?.value_classification ?? 'Neutral' };
  } catch { return { value: 50, label: 'Neutral' }; }
}

async function fetchRecentWinners(): Promise<any[]> {
  try {
    const r = await axios.get(`${API_BASE}/autobuy/trades?limit=20`, { timeout: 8000 });
    const trades: any[] = r.data?.trades ?? [];
    return trades.filter(t =>
      t.total_sold_sol && t.amount_sol &&
      t.total_sold_sol > t.amount_sol * 1.12  // 12%+ profit
    ).slice(0, 3);
  } catch { return []; }
}

function fngEmoji(v: number): string {
  if (v < 25) return '😱 EXTREME FEAR';
  if (v < 45) return '😨 FEAR';
  if (v < 55) return '😐 NEUTRAL';
  if (v < 75) return '😏 GREED';
  return '🤑 EXTREME GREED';
}

function scoreBar(score: number): string {
  const filled = Math.round(score / 10);
  return '█'.repeat(filled) + '░'.repeat(10 - filled);
}

export async function broadcastAlphaSignal(bot: TelegramBot): Promise<void> {
  if (!ENABLED) return;

  try {
    const [tokens, fng, winners] = await Promise.all([
      fetchTopTokens(),
      fetchFearGreed(),
      fetchRecentWinners(),
    ]);

    if (!tokens.length) return;

    const top3 = tokens
      .filter(t => t.gad_score >= 70 && t.mint_address)
      .sort((a, b) => (b.gad_score ?? 0) - (a.gad_score ?? 0))
      .slice(0, 3);

    if (!top3.length) return;

    const now   = new Date().toUTCString().slice(0, 16);
    const regime = `${fng.label.toUpperCase()} (F&G: ${fng.value})`;

    let msg = `📡 *GAD AI ALPHA SIGNAL — ${now}*\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `🌡️ Market: ${fngEmoji(fng.value)}\n\n`;

    top3.forEach((t, i) => {
      const sym    = t.symbol ?? t.mint_address?.slice(0, 8) ?? '?';
      const score  = t.gad_score ?? 0;
      const mint   = t.mint_address ?? '';
      const liq    = t.liquidity_usd ? `$${(t.liquidity_usd / 1000).toFixed(0)}K` : '?';
      const pc1h   = t.price_change_1h != null ? `${Number(t.price_change_1h).toFixed(1)}%` : '?';
      const stage  = t.lifecycle_stage ?? 'ACCUMULATION';
      const narrative = t.narrative ?? '';

      msg += `${i === 0 ? '🥇' : i === 1 ? '🥈' : '🥉'} *$${sym}*\n`;
      msg += `Score: \`${scoreBar(score)}\` ${score}/100\n`;
      msg += `Liq: ${liq} | 1h: ${pc1h} | Stage: ${stage}\n`;
      if (narrative) msg += `Narrative: ${narrative}\n`;
      msg += `\`${mint.slice(0, 24)}...\`\n\n`;
    });

    if (winners.length) {
      msg += `━━━━━━━━━━━━━━━━━━━━━━\n`;
      msg += `✅ *Recent Bot Wins:*\n`;
      winners.slice(0, 3).forEach(w => {
        const sym = w.label?.split(':')[2]?.replace(/^liq\d+k?/, '') ?? w.mint_address?.slice(0, 6);
        const pnl = w.total_sold_sol && w.amount_sol
          ? `+${((w.total_sold_sol / w.amount_sol - 1) * 100).toFixed(0)}%`
          : '';
        if (pnl) msg += `• $${sym || '?'} → ${pnl}\n`;
      });
      msg += '\n';
    }

    msg += `━━━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `🤖 [@gadai\\_sol\\_bot](https://t.me/gadai_sol_bot) — \`/tokenscore <CA>\`\n`;
    msg += `💳 Trial: [0.05 SOL](https://gadai.shop/pay) · Monthly: 1 SOL\n`;
    msg += `📢 [Join channel](https://t.me/gadfamilytg) for daily signals`;

    await bot.sendMessage(CHANNEL_ID, msg, {
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
    });

    console.info(`[broadcaster] ✅ Signal posted to ${CHANNEL_ID} — top tokens: ${top3.map(t => t.symbol ?? '?').join(', ')}`);
  } catch (err: any) {
    console.warn(`[broadcaster] ⚠️ Broadcast failed: ${err.message?.slice(0, 80)}`);
  }
}

export function startBroadcaster(bot: TelegramBot): void {
  if (!ENABLED) {
    console.info('[broadcaster] Disabled (set BROADCAST_SIGNALS=true + TELEGRAM_CHANNEL_ID=@gadfamilytg to enable)');
    return;
  }

  console.info(`[broadcaster] Started — posting to ${CHANNEL_ID} every ${INTERVAL_H}h`);

  // First post after 2 minutes (bot startup), then every INTERVAL_H hours
  setTimeout(() => {
    broadcastAlphaSignal(bot);
    setInterval(() => broadcastAlphaSignal(bot), INTERVAL_H * 60 * 60 * 1000);
  }, 2 * 60 * 1000);
}
