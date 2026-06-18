/**
 * Alpha Signal Broadcaster
 * Posts top GAD signals to @gadfamilytg every 6 hours.
 * Also posts project promo content every 12h — features, X link, how to start.
 */

import axios from 'axios';
import TelegramBot from 'node-telegram-bot-api';
import { query } from '@lib/db';

const API_BASE       = process.env.API_BASE_URL        || 'http://localhost:4000';
const CHANNEL_ID     = process.env.TELEGRAM_CHANNEL_ID || '@gadfamilytg';
const INTERVAL_H     = Number(process.env.BROADCAST_INTERVAL_H || '6');
const PROMO_INTERVAL_H = Number(process.env.BROADCAST_PROMO_H  || '12');
const ENABLED        = process.env.BROADCAST_SIGNALS === 'true';
const PROMO_ENABLED  = process.env.BROADCAST_PROMOS  !== 'false'; // on by default when BROADCAST_SIGNALS=true

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
      Number(t.total_sold_sol) > Number(t.amount_sol) * 1.12  // 12%+ profit
    ).slice(0, 3);
  } catch { return []; }
}

async function fetchBotStats(): Promise<{ trades: number; wins: number; winRate: number; netPnl: number }> {
  try {
    const r = await axios.get(`${API_BASE}/autobuy/bot-status`, { timeout: 8000 });
    const s = r.data?.summary ?? {};
    return {
      trades:  Number(s.closed ?? 0),
      wins:    Number(s.wins ?? 0),
      winRate: s.win_rate != null ? Number(s.win_rate) : 0,
      netPnl:  Number(s.net_pnl ?? 0),
    };
  } catch { return { trades: 0, wins: 0, winRate: 0, netPnl: 0 }; }
}

async function fetchRecentLaunches(limit = 3): Promise<any[]> {
  try {
    const { rows } = await query<any>(`
      SELECT ticker, name, mint_address, created_at
      FROM coin_launches ORDER BY created_at DESC LIMIT $1
    `, [limit]);
    return rows;
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

// ─── Alpha Signal (every 6h) ──────────────────────────────────────────────────
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
    let msg = `📡 *GAD AI ALPHA SIGNAL — ${now}*\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `🌡️ Market: ${fngEmoji(fng.value)}\n\n`;

    top3.forEach((t, i) => {
      const sym       = t.symbol ?? t.mint_address?.slice(0, 8) ?? '?';
      const score     = t.gad_score ?? 0;
      const mint      = t.mint_address ?? '';
      const liq       = t.liquidity_usd ? `$${(t.liquidity_usd / 1000).toFixed(0)}K` : '?';
      const pc1h      = t.price_change_1h != null ? `${Number(t.price_change_1h).toFixed(1)}%` : '?';
      const stage     = t.lifecycle_stage ?? 'ACCUMULATION';
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
          ? `+${((Number(w.total_sold_sol) / Number(w.amount_sol) - 1) * 100).toFixed(0)}%`
          : '';
        if (pnl) msg += `• $${sym || '?'} → ${pnl}\n`;
      });
      msg += '\n';
    }

    msg += `━━━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `🤖 [@gadai\\_sol\\_bot](https://t.me/gadai_sol_bot) — \`/tokenscore <CA>\`\n`;
    msg += `🐦 Follow on X: [@gadaisol](https://x.com/gadaisol)\n`;
    msg += `💳 Trial: [0.05 SOL](https://gadai.shop/pay) · Monthly: 1 SOL`;

    await bot.sendMessage(CHANNEL_ID, msg, {
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
    });

    console.info(`[broadcaster] ✅ Alpha signal posted — top: ${top3.map(t => t.symbol ?? '?').join(', ')}`);
  } catch (err: any) {
    console.warn(`[broadcaster] ⚠️ Alpha broadcast failed: ${err.message?.slice(0, 80)}`);
  }
}

// ─── Promo Posts (every 12h) — rotating content about GAD AI features ────────

const PROMO_MESSAGES: Array<() => Promise<string>> = [

  // Promo 0: What is GAD AI
  async () => {
    const stats = await fetchBotStats();
    const pnlSign = stats.netPnl >= 0 ? '+' : '';
    return (
      `🤖 *GAD AI Terminal — What is it?*\n\n` +
      `An AI-powered Solana memecoin trading bot that never sleeps.\n\n` +
      `🔍 *Scans* Raydium, Pump.fun, PumpSwap every 30s\n` +
      `📊 *Scores* every token 0-100 across 6 AI factors\n` +
      `⚡ *Buys* automatically on high-score signals\n` +
      `📈 *Sells* via trailing stop + TP targets\n` +
      `🌐 *Multi-chain:* Solana · Base (ETH) · BSC · TON\n\n` +
      (stats.trades > 0 ? `📋 Today: *${stats.trades} trades* · WR: *${stats.winRate}%* · PnL: *${pnlSign}${stats.netPnl.toFixed(3)} SOL*\n\n` : '') +
      `━━━━━━━━━━━━━━━━━━━━━━\n` +
      `🤖 [@gadai\\_sol\\_bot](https://t.me/gadai_sol_bot)\n` +
      `🐦 [@gadaisol](https://x.com/gadaisol) on X\n` +
      `💳 [Start for 0.05 SOL →](https://gadai.shop/pay)`
    );
  },

  // Promo 1: Features spotlight
  async () => (
    `⚡ *GAD AI — Feature Spotlight*\n\n` +
    `*🔥 Velocity Tracker*\n` +
    `Real-time PumpPortal WebSocket. Detects SOL inflow surges into bonding curves before price moves. Zero lag.\n\n` +
    `*📡 X / Twitter Radar*\n` +
    `Monitors KOL tweets every 15min → detects narrative shift → finds matching token → sends signal.\n\n` +
    `*🧠 Trend-to-Coin Engine*\n` +
    `GDELT + Google News → clusters viral events → AI generates meme coin ideas → launches on pump.fun.\n\n` +
    `*📊 TokenScore*\n` +
    `Score any Solana token 0-100:\n` +
    `\`/tokenscore <CA>\` in the bot\n\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `🤖 [@gadai\\_sol\\_bot](https://t.me/gadai_sol_bot)\n` +
    `🐦 [@gadaisol](https://x.com/gadaisol)\n` +
    `💳 [gadai.shop/pay](https://gadai.shop/pay) — 0.05 SOL trial`
  ),

  // Promo 2: AI scoring explanation
  async () => (
    `📊 *How GAD AI Scores Tokens*\n\n` +
    `Every token gets an AI score 0-100 based on:\n\n` +
    `🏆 *GAD Score components:*\n` +
    `• AI Score (25%) — pattern match vs historical winners\n` +
    `• Volume/Liq ratio (20%) — real vs wash trading\n` +
    `• Rug probability (15%) — dev wallet analysis\n` +
    `• Social/narrative (15%) — X mentions + sentiment\n` +
    `• Holder distribution (15%) — whale concentration\n` +
    `• Age/lifecycle stage (10%) — accumulation timing\n\n` +
    `Score ≥ 80 = *STRONG BUY* signal\n` +
    `Score ≥ 65 = *WATCH* closely\n\n` +
    `Try it: \`/tokenscore <CA>\`\n\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `🤖 [@gadai\\_sol\\_bot](https://t.me/gadai_sol_bot)\n` +
    `🐦 [@gadaisol](https://x.com/gadaisol) — follow for alpha`
  ),

  // Promo 3: Plans & pricing
  async () => (
    `💳 *GAD AI — Access Plans*\n\n` +
    `🧪 *1-Day Trial* — 0.05 SOL\n` +
    `Full analytics · Signals · Whale tracking · Trade journal\n\n` +
    `⚡ *3-Day Access* — 0.1 SOL\n` +
    `Everything + Trend engine · Coin ideas · X signals\n\n` +
    `💎 *Monthly PRO* — 1 SOL / 30 days\n` +
    `Everything + AutoBuy bot · Portfolio · Token launcher\n` +
    `Futures · Base/BSC/TON scanners\n\n` +
    `*No KYC. No middleman.*\n` +
    `Pay direct from Phantom → verified on-chain → instant access.\n\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `💳 [Get Access →](https://gadai.shop/pay)\n` +
    `🤖 [@gadai\\_sol\\_bot](https://t.me/gadai_sol_bot)\n` +
    `🐦 [@gadaisol](https://x.com/gadaisol)`
  ),

  // Promo 4: Recent launches
  async () => {
    const launches = await fetchRecentLaunches(3);
    let content = `🚀 *GAD AI Token Launcher*\n\n`;
    content += `Trend events → AI coin ideas → instant pump.fun launch.\n\n`;
    if (launches.length) {
      content += `*Recent launches:*\n`;
      for (const l of launches) {
        const ageH = Math.round((Date.now() - new Date(l.created_at).getTime()) / 3_600_000);
        content += `• *$${l.ticker}* — ${l.name} (${ageH}h ago)\n`;
        content += `  [pump.fun](https://pump.fun/coin/${l.mint_address})\n`;
      }
      content += '\n';
    } else {
      content += `No tokens launched yet — stay tuned!\n\n`;
    }
    content += `━━━━━━━━━━━━━━━━━━━━━━\n`;
    content += `🤖 [@gadai\\_sol\\_bot](https://t.me/gadai_sol_bot)\n`;
    content += `🐦 [@gadaisol](https://x.com/gadaisol) — follow for launch alerts`;
    return content;
  },
];

export async function broadcastPromo(bot: TelegramBot): Promise<void> {
  if (!ENABLED || !PROMO_ENABLED) return;

  try {
    // Rotate through promo messages based on day+hour to ensure variety
    const idx = Math.floor(Date.now() / (PROMO_INTERVAL_H * 3_600_000)) % PROMO_MESSAGES.length;
    const msg = await PROMO_MESSAGES[idx]();

    await bot.sendMessage(CHANNEL_ID, msg, {
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
    });

    console.info(`[broadcaster] ✅ Promo posted (type ${idx})`);
  } catch (err: any) {
    console.warn(`[broadcaster] ⚠️ Promo failed: ${err.message?.slice(0, 80)}`);
  }
}

// ─── Start scheduled broadcasting ────────────────────────────────────────────
export function startBroadcaster(bot: TelegramBot): void {
  if (!ENABLED) {
    console.info('[broadcaster] Disabled (set BROADCAST_SIGNALS=true + TELEGRAM_CHANNEL_ID=@gadfamilytg)');
    return;
  }

  console.info(`[broadcaster] Started — alpha every ${INTERVAL_H}h, promo every ${PROMO_INTERVAL_H}h → ${CHANNEL_ID}`);

  // Alpha signal: first post after 5 minutes, then every INTERVAL_H hours
  setTimeout(() => {
    broadcastAlphaSignal(bot);
    setInterval(() => broadcastAlphaSignal(bot), INTERVAL_H * 60 * 60 * 1000);
  }, 5 * 60 * 1000);

  // Promo: first post after 30 minutes (after alpha), then every PROMO_INTERVAL_H hours
  setTimeout(() => {
    broadcastPromo(bot);
    setInterval(() => broadcastPromo(bot), PROMO_INTERVAL_H * 60 * 60 * 1000);
  }, 30 * 60 * 1000);
}
