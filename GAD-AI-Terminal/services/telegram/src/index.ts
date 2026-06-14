import dotenv from 'dotenv';
import TelegramBot from 'node-telegram-bot-api';
import axios from 'axios';
import { runTrendCycle, getTopClusters, getClusterById, getIdeasForCluster, generateCoinIdeas, saveCoinIdea, updateIdeaStatus } from '@lib/trend-engine';
const FUTURES_API = process.env.FUTURES_API_URL || 'http://futures:4003';

dotenv.config();

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const API_BASE  = process.env.API_BASE_URL || 'http://localhost:4000';
const SITE_URL  = process.env.SITE_URL     || 'https://gadai.shop';
const ADMIN_ID  = process.env.TELEGRAM_ADMIN_CHAT_ID;
const PAGE_SIZE = 8;

if (!BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN is required');

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// ─── Logging ──────────────────────────────────────────────────────────────────
function log(level: 'info' | 'warn' | 'error', ...args: unknown[]) {
  console[level](`[tg][${new Date().toISOString()}]`, ...args);
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────
async function apiGet<T = any>(path: string): Promise<T> {
  const res = await axios.get<T>(`${API_BASE}${path}`, { timeout: 8000 });
  return res.data;
}
async function apiPost<T = any>(path: string, body: unknown): Promise<T> {
  const res = await axios.post<T>(`${API_BASE}${path}`, body, { timeout: 8000 });
  return res.data;
}
async function apiDelete<T = any>(path: string): Promise<T> {
  const res = await axios.delete<T>(`${API_BASE}${path}`, { timeout: 8000 });
  return res.data;
}

// ─── Messaging helpers ────────────────────────────────────────────────────────
async function send(chatId: number, text: string, extra: TelegramBot.SendMessageOptions = {}) {
  return bot.sendMessage(chatId, text, { parse_mode: 'Markdown', ...extra });
}
async function edit(chatId: number, msgId: number, text: string, extra: TelegramBot.EditMessageTextOptions = {}) {
  return bot.editMessageText(text, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', ...extra });
}

// ─── Error guard ──────────────────────────────────────────────────────────────
async function guard(chatId: number, fn: () => Promise<unknown>) {
  try { await fn(); }
  catch (err: any) {
    const msg = err?.response?.data?.error ?? err?.message ?? String(err);
    log('error', msg);
    bot.sendMessage(chatId, `❌ Error: ${msg}`).catch(() => {});
  }
}

// ─── Pagination ───────────────────────────────────────────────────────────────
function paginate<T>(items: T[], page: number) {
  const start = page * PAGE_SIZE;
  return { slice: items.slice(start, start + PAGE_SIZE), hasNext: start + PAGE_SIZE < items.length, hasPrev: page > 0, total: items.length };
}
function pageButtons(cmd: string, page: number, hasNext: boolean, hasPrev: boolean) {
  const row: TelegramBot.InlineKeyboardButton[] = [];
  if (hasPrev) row.push({ text: '◀ Prev', callback_data: `${cmd}:${page - 1}` });
  if (hasNext) row.push({ text: 'Next ▶', callback_data: `${cmd}:${page + 1}` });
  return row.length ? [row] : [];
}

// ─── Token formatter ──────────────────────────────────────────────────────────
function fmtToken(t: any, index?: number): string {
  const prefix = index !== undefined ? `${index + 1}. ` : '';
  const sym    = t.symbol ? `*${t.symbol}*` : '?';
  const mc     = t.market_cap ? `MC: $${Number(t.market_cap).toLocaleString()}` : '';
  const ai     = t.ai_score   ? `AI: ${t.ai_score}`   : '';
  const risk   = t.risk_score ? `Risk: ${t.risk_score}` : '';
  const parts  = [mc, ai, risk].filter(Boolean).join(' | ');
  return `${prefix}${sym} ${parts ? `— ${parts}` : ''}\n  \`${t.mint_address}\``;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  SUBSCRIPTION CHECK
// ═══════════════════════════════════════════════════════════════════════════════

interface SubStatus {
  active: boolean;
  walletLinked: boolean;
  wallet?: string;
  plan?: string;
  expiresAt?: string;
  remainingHours?: number;
  isTrial?: boolean;
}

async function getSubStatus(telegramId: number): Promise<SubStatus> {
  try { return await apiGet<SubStatus>(`/tg/status/${telegramId}`); }
  catch { return { active: false, walletLinked: false }; }
}

function planTier(plan?: string): 'free' | 'starter' | 'pro' {
  if (!plan) return 'free';
  if (plan === 'monthly' || plan === 'autobuy_pro') return 'pro';
  return 'starter'; // trial_1d, trial_3d
}

function planLabel(plan?: string): string {
  if (plan === 'monthly')     return '💎 Monthly';
  if (plan === 'trial_3d')    return '⚡ 3-Day Access';
  if (plan === 'trial_1d')    return '🧪 1-Day Trial';
  if (plan === 'autobuy_pro') return '🤖 AutoBuy Pro';
  return '❓ Unknown';
}

async function requireSub(chatId: number, telegramId: number): Promise<boolean> {
  const status  = await getSubStatus(telegramId);
  if (status.active) return true;

  const payUrl = `${SITE_URL}/pay?tg_id=${telegramId}`;
  const msg = status.walletLinked
    ? `🔒 *Subscription expired.*\nRenew to continue using GAD AI Terminal.\n\n🧪 1-Day Trial — 0.05 SOL\n⚡ 3-Day Access — 0.1 SOL\n💎 Monthly — 1 SOL / 30 days`
    : `🔒 *Access Required*\n\nSubscription needed to use this feature.\n\n🧪 1-Day Trial — 0.05 SOL\n⚡ 3-Day Access — 0.1 SOL\n💎 Monthly — 1 SOL / 30 days\n\nConnect Phantom or Solflare on the payment page.`;

  await send(chatId, msg, {
    reply_markup: { inline_keyboard: [[{ text: '💳 Get Access', url: payUrl }]] }
  });
  return false;
}

// Requires monthly (PRO) plan — shows upgrade prompt for trial users
async function requirePro(chatId: number, telegramId: number): Promise<boolean> {
  const status = await getSubStatus(telegramId);
  if (!status.active) return requireSub(chatId, telegramId);
  if (planTier(status.plan) === 'pro') return true;

  const payUrl = `${SITE_URL}/pay?tg_id=${telegramId}`;
  await send(chatId,
    `🔒 *PRO Feature*\n\nThis command requires *Monthly* subscription.\n\nYour plan: ${planLabel(status.plan)}\n\n💎 *Monthly — 1 SOL / 30 days*\n✅ All analytics\n✅ AutoBuy bot control\n✅ Portfolio & Launch\n✅ Futures trading`,
    { reply_markup: { inline_keyboard: [[{ text: '🚀 Upgrade to PRO', url: payUrl }]] } }
  );
  return false;
}

// ─── Terminal analysis helper ─────────────────────────────────────────────────
async function sendAnalysis(chatId: number, mint: string) {
  await send(chatId, `🧠 Analyzing \`${mint.slice(0, 12)}…\``);
  const data = await apiGet(`/terminal/analyze/${mint}`);
  const r    = data.report ?? data;
  const sym  = r.symbol ?? r.ticker ?? mint.slice(0, 8);
  let text   = `🤖 *GAD AI — ${sym}*\n\n`;
  text += `📊 GAD Score: *${r.gad_score ?? r.ai_score ?? '?'}* | Risk: *${r.risk_score ?? '?'}*\n`;
  text += `🔫 Rug prob: *${r.rug_probability != null ? Number(r.rug_probability).toFixed(1) + '%' : '?'}*`;
  text += ` | Survival 24h: *${r.survival_24h != null ? Number(r.survival_24h).toFixed(0) + '%' : '?'}*\n`;
  text += `💰 MC: $${Number(r.market_cap ?? 0).toLocaleString()} | Liq: $${Number(r.liquidity ?? 0).toLocaleString()}\n`;
  if (r.summary) text += `\n${r.summary}`;
  text += `\n\n\`${mint}\``;
  send(chatId, text, {
    reply_markup: { inline_keyboard: [[
      { text: '➕ Watchlist', callback_data: `wl_add:${mint}` },
      { text: '🔄 Refresh',  callback_data: `analyze:${mint}` }
    ]]}
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
//  COMMANDS
// ═══════════════════════════════════════════════════════════════════════════════

bot.onText(/\/start/, async (msg) => {
  const name = msg.from?.first_name ?? 'degen';
  const tgId = msg.from?.id ?? msg.chat.id;
  const status = await getSubStatus(tgId);
  const tier = status.active ? planTier(status.plan) : 'free';

  const tierBadge = tier === 'pro' ? '💎 PRO' : tier === 'starter' ? '⚡ STARTER' : '🆓 FREE';
  const tierLine  = status.active
    ? `Plan: ${tierBadge} | ${planLabel(status.plan)} | ~${status.remainingHours}h left`
    : `Plan: ${tierBadge} — /subscribe to unlock features`;

  send(msg.chat.id,
    `🤖 *GAD AI Terminal*\n\nGM, ${name}! Real-time Solana alpha.\n\n${tierLine}\n\n` +
    `*📊 Analytics (Starter+):*\n/trending /new /highscore /highrisk\n/analyze /signals /whales /tokenscore\n\n` +
    `*🤖 Bot Control (PRO):*\n/bot — Solana bot PnL\n/futures — futures trading\n/basestatus — Base Network\n/autobuy /portfolio\n\n` +
    `*🔑 Free:*\n/subscribe /status /wallet /help`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: '📈 Trending', callback_data: 'trending:0' }, { text: '🆕 New', callback_data: 'new:0' }],
          [{ text: '🏆 Top Score', callback_data: 'highscore:0' }, { text: '🚨 Signals', callback_data: 'alerts:0' }],
          [{ text: '🐋 Whales', callback_data: 'whales:0' }, { text: '📋 Trades', callback_data: 'trades:0' }],
          tier === 'pro'
            ? [{ text: '🤖 Bot Status', callback_data: 'botstatus' }, { text: '💼 Portfolio', callback_data: 'portfolio:0' }]
            : [{ text: '💳 Subscribe', callback_data: 'subscribe' }, { text: '📊 My Status', callback_data: 'status' }],
        ]
      }
    }
  );
});

bot.onText(/\/help/, (msg) => {
  send(msg.chat.id,
    `*GAD AI Terminal — Command Guide*\n\n` +
    `🆓 *FREE (no subscription):*\n` +
    `/start — main menu\n` +
    `/subscribe — view plans & pay\n` +
    `/status — subscription status\n` +
    `/wallet <address> — link Solana wallet\n` +
    `/help — this guide\n\n` +
    `⚡ *ANY PLAN (0.05 SOL trial / 0.1 SOL 3d / 1 SOL monthly):*\n` +
    `*Solana Scanner:*\n` +
    `/trending — hot tokens right now\n` +
    `/new — freshly listed tokens\n` +
    `/highscore — top AI-scored tokens\n` +
    `/highrisk — high-risk radar\n` +
    `/analyze <mint> — full GAD AI report\n` +
    `/tokenscore <mint> — safety score 0-100\n` +
    `/signals — active buy signals\n` +
    `/whales — top whale wallets\n` +
    `*Trading:*\n` +
    `/trades — bot trade history (24h)\n` +
    `/journal — your personal trade log\n` +
    `/riskpassport — risk DNA profile\n` +
    `*Trends & Intelligence:*\n` +
    `/trends — GDELT + News meme engine\n` +
    `/ideas — AI-generated coin concepts\n` +
    `/xtrends — X/Twitter trend signals\n` +
    `/xsignal — latest X trend + coin\n` +
    `*Futures:*\n` +
    `/macro — BTC/SP500/F&G macro score\n` +
    `/signal — SOL futures entry signal\n` +
    `/futures — full futures dashboard\n` +
    `*Base Network (EVM):*\n` +
    `/basestatus — Base scanner status\n` +
    `/basepositions — open ETH positions\n` +
    `/basetokens — discovered Base tokens\n` +
    `/basetrades — Base trade history\n\n` +
    `💎 *PRO (1 SOL / 30 days) — extra:*\n` +
    `/bot — Solana bot PnL & status\n` +
    `/autobuy list|add|stop — manage bot\n` +
    `/portfolio — full portfolio view\n` +
    `/watchlist — token watchlist\n` +
    `/mycoins — your deployed tokens\n` +
    `/exitcoin <ticker> — sell launched token\n` +
    `/position — futures position\n` +
    `/capital — futures capital manager\n` +
    `/ftrades — futures trade log\n` +
    `/fclose — close futures position\n\n` +
    `🔑 *Admin only:*\n` +
    `/auto_launch — launch token on pump.fun 24/7\n` +
    `/approve_idea <id> — approve AI coin idea\n\n` +
    `📈 *Networks:* Solana · Base (EVM)\n` +
    `📡 *Sources:* DexScreener · Birdeye · Helius · GDELT · X/Twitter · Binance`
  );
});

bot.onText(/\/subscribe/, (msg) => guard(msg.chat.id, async () => {
  const tgId   = msg.from?.id ?? msg.chat.id;
  const payUrl = `${SITE_URL}/pay?tg_id=${tgId}`;
  send(msg.chat.id,
    `💳 *GAD AI Terminal — Plans*\n\n` +
    `🧪 *1-Day Trial* — 0.05 SOL\n` +
    `  24h · One trial per wallet\n` +
    `  ✅ All analytics, signals, whales\n` +
    `  ✅ Trade journal & risk passport\n\n` +
    `⚡ *3-Day Access* — 0.1 SOL\n` +
    `  72h · Best for testing the alpha\n` +
    `  ✅ Everything in Trial\n` +
    `  ✅ Trend engine & coin ideas\n\n` +
    `💎 *Monthly PRO* — 1 SOL / 30 days\n` +
    `  ✅ Everything above\n` +
    `  ✅ Bot control (AutoBuy /bot)\n` +
    `  ✅ Portfolio manager\n` +
    `  ✅ Token launcher on Pump.fun\n` +
    `  ✅ Futures trading module\n\n` +
    `Payment: Phantom or Solflare → direct to treasury.\nNo middleman. Verified on-chain.`,
    { reply_markup: { inline_keyboard: [[{ text: '💳 Pay & Get Access', url: payUrl }]] } }
  );
}));

bot.onText(/\/status/, (msg) => guard(msg.chat.id, async () => {
  const tgId   = msg.from?.id ?? msg.chat.id;
  const payUrl = `${SITE_URL}/pay?tg_id=${tgId}`;
  const status = await getSubStatus(tgId);

  if (!status.walletLinked) {
    return send(msg.chat.id,
      `📊 *Status*\n\n❌ No wallet linked.\nUse /wallet <address> to link your Solana wallet,\nor pay directly from the website.`,
      { reply_markup: { inline_keyboard: [[{ text: '💳 Get Access', url: payUrl }]] } }
    );
  }
  if (!status.active) {
    return send(msg.chat.id,
      `📊 *Status*\n\n❌ No active subscription\nWallet: \`${status.wallet?.slice(0, 16)}…\``,
      { reply_markup: { inline_keyboard: [[{ text: '🔄 Renew', url: payUrl }]] } }
    );
  }
  const tier    = planTier(status.plan);
  const badge   = tier === 'pro' ? '💎 PRO' : '⚡ STARTER';
  const expires = status.expiresAt
    ? new Date(status.expiresAt).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }) + ' UTC'
    : '?';
  const features = tier === 'pro'
    ? '✅ Analytics · Signals · Whales\n✅ Bot control · Portfolio · Launch\n✅ Futures trading'
    : '✅ Analytics · Signals · Whales\n✅ Journal · Risk passport · Trends\n🔒 Bot control (upgrade to PRO)';
  send(msg.chat.id,
    `📊 *Subscription Status*\n\n` +
    `✅ *Active* — ${badge}\n` +
    `Plan: ${planLabel(status.plan)}\n` +
    `Expires: ${expires}\n` +
    `Remaining: ~${status.remainingHours}h\n` +
    `Wallet: \`${status.wallet?.slice(0, 20)}…\`\n\n` +
    `${features}`,
    tier !== 'pro' ? { reply_markup: { inline_keyboard: [[{ text: '🚀 Upgrade to PRO', url: payUrl }]] } } : {}
  );
}));

bot.onText(/\/wallet (.+)/, (msg, match) => guard(msg.chat.id, async () => {
  const address = (match?.[1] ?? '').trim();
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) {
    return send(msg.chat.id, '❌ Invalid Solana address.');
  }
  const tgId = msg.from?.id ?? msg.chat.id;
  await apiPost('/tg/link', { telegram_id: tgId, wallet_address: address, username: msg.from?.username });
  send(msg.chat.id, `✅ Wallet linked!\n\`${address}\`\n\nNow use /subscribe to get access.`);
}));

// Premium commands — all go through requireSub
bot.onText(/\/trending/, (msg) => guard(msg.chat.id, async () => {
  if (!await requireSub(msg.chat.id, msg.from?.id ?? msg.chat.id)) return;
  const data = await apiGet('/tokens/trending');
  const { slice, total } = paginate(data.tokens ?? [], 0);
  send(msg.chat.id, `📈 *Trending (${total})*\n\n` + slice.map(fmtToken).join('\n\n'), {
    reply_markup: { inline_keyboard: pageButtons('trending', 0, total > PAGE_SIZE, false) }
  });
}));

bot.onText(/\/new/, (msg) => guard(msg.chat.id, async () => {
  if (!await requireSub(msg.chat.id, msg.from?.id ?? msg.chat.id)) return;
  const data = await apiGet('/tokens/new?minutes=30');
  const { slice, total } = paginate(data.tokens ?? [], 0);
  send(msg.chat.id, total ? `🆕 *New (${total})*\n\n` + slice.map(fmtToken).join('\n\n') : '🆕 No new tokens.', {
    reply_markup: { inline_keyboard: pageButtons('new', 0, total > PAGE_SIZE, false) }
  });
}));

bot.onText(/\/highscore/, (msg) => guard(msg.chat.id, async () => {
  if (!await requireSub(msg.chat.id, msg.from?.id ?? msg.chat.id)) return;
  const data = await apiGet('/tokens/highscore?threshold=80');
  const { slice, total } = paginate(data.tokens ?? [], 0);
  send(msg.chat.id, total ? `🏆 *High Score (${total})*\n\n` + slice.map(fmtToken).join('\n\n') : '🏆 No tokens.', {
    reply_markup: { inline_keyboard: pageButtons('highscore', 0, total > PAGE_SIZE, false) }
  });
}));

bot.onText(/\/highrisk/, (msg) => guard(msg.chat.id, async () => {
  if (!await requireSub(msg.chat.id, msg.from?.id ?? msg.chat.id)) return;
  const data = await apiGet('/tokens/highrisk?threshold=70');
  const { slice, total } = paginate(data.tokens ?? [], 0);
  send(msg.chat.id, total ? `⚠️ *High Risk (${total})*\n\n` + slice.map(fmtToken).join('\n\n') : '⚠️ None.', {
    reply_markup: { inline_keyboard: pageButtons('highrisk', 0, total > PAGE_SIZE, false) }
  });
}));

bot.onText(/\/token (.+)/, (msg, match) => guard(msg.chat.id, async () => {
  if (!await requireSub(msg.chat.id, msg.from?.id ?? msg.chat.id)) return;
  const mint = (match?.[1] ?? '').trim();
  const data = await apiGet(`/tokens/${mint}`);
  const t    = data.token ?? data;
  send(msg.chat.id,
    `*${t.symbol ?? mint.slice(0, 8)}*\n` +
    `MC: $${Number(t.market_cap ?? 0).toLocaleString()} | Liq: $${Number(t.liquidity ?? 0).toLocaleString()}\n` +
    `AI: ${t.ai_score ?? '?'} | Risk: ${t.risk_score ?? '?'} | Holders: ${t.holder_count ?? '?'}\n\`${mint}\``,
    { reply_markup: { inline_keyboard: [[
      { text: '🤖 AI Analyze', callback_data: `analyze:${mint}` },
      { text: '➕ Watchlist',  callback_data: `wl_add:${mint}` }
    ]]}}
  );
}));

bot.onText(/\/analyze (.+)/, (msg, match) => guard(msg.chat.id, async () => {
  if (!await requireSub(msg.chat.id, msg.from?.id ?? msg.chat.id)) return;
  await sendAnalysis(msg.chat.id, (match?.[1] ?? '').trim());
}));

bot.onText(/\/watchlist/, (msg) => guard(msg.chat.id, async () => {
  if (!await requireSub(msg.chat.id, msg.from?.id ?? msg.chat.id)) return;
  const data = await apiGet('/watchlist');
  const tokens = data.tokens ?? [];
  if (!tokens.length) return send(msg.chat.id, '📋 Watchlist is empty.');
  send(msg.chat.id, `📋 *Watchlist (${tokens.length})*\n\n` +
    tokens.slice(0, 15).map((t: any, i: number) => `${i + 1}. *${t.symbol ?? '?'}* \`${t.mint_address.slice(0, 12)}…\``).join('\n')
  );
}));

bot.onText(/\/signals/, (msg) => guard(msg.chat.id, async () => {
  if (!await requireSub(msg.chat.id, msg.from?.id ?? msg.chat.id)) return;
  const data    = await apiGet('/signals');
  const signals = data.signals ?? data.alerts ?? [];
  if (!signals.length) return send(msg.chat.id, '🚨 No active signals.');
  send(msg.chat.id, `🚨 *Signals (${signals.length})*\n\n` +
    signals.slice(0, 10).map((a: any, i: number) =>
      `${i + 1}. *${a.type}* score:${a.score ?? 0}\n   \`${(a.subject ?? '').slice(0, 24)}\``
    ).join('\n\n')
  );
}));

bot.onText(/\/whales/, (msg) => guard(msg.chat.id, async () => {
  if (!await requireSub(msg.chat.id, msg.from?.id ?? msg.chat.id)) return;
  const data = await apiGet('/whales');
  const list = data.whales ?? [];
  if (!list.length) return send(msg.chat.id, '🐋 No whale data yet.');
  send(msg.chat.id, `🐋 *Top Whales*\n\n` +
    list.slice(0, PAGE_SIZE).map((w: any, i: number) =>
      `${i + 1}. \`${w.address.slice(0, 12)}…\` Score:${w.whale_score} ROI:${Number(w.roi ?? 0).toFixed(0)}%`
    ).join('\n')
  );
}));

bot.onText(/\/portfolio/, (msg) => guard(msg.chat.id, async () => {
  if (!await requirePro(msg.chat.id, msg.from?.id ?? msg.chat.id)) return;
  const data  = await apiGet('/portfolio');
  const stats = data.stats ?? {};
  const open  = (data.positions ?? []).filter((p: any) => p.status === 'open');
  send(msg.chat.id,
    `💼 *Portfolio*\nOpen:${stats.open ?? 0} | WR:${stats.win_rate ?? 0}% | PnL:$${Number(stats.realized_pnl ?? 0).toFixed(2)}\n\n` +
    (open.slice(0, 8).map((p: any) =>
      `• ${p.symbol ?? '?'} Entry:${p.entry_price} Size:${p.position_size}${p.roi_pct != null ? ` ROI:${p.roi_pct}%` : ''}`
    ).join('\n') || 'No open positions.')
  );
}));

bot.onText(/\/autobuy list/, (msg) => guard(msg.chat.id, async () => {
  if (!await requirePro(msg.chat.id, msg.from?.id ?? msg.chat.id)) return;
  const data = await apiGet('/autobuy');
  const jobs = data.jobs ?? [];
  if (!jobs.length) return send(msg.chat.id, '💰 No auto-buy jobs.');
  send(msg.chat.id, `💰 *Auto-buy Jobs*\n\n` +
    jobs.map((j: any) => {
      const st  = j.active ? '🟢' : '🔴';
      const int = j.interval_seconds >= 3600 ? `${j.interval_seconds / 3600}h` : `${j.interval_seconds / 60}m`;
      return `${st} [${j.id.slice(0, 8)}] ${j.label ? `"${j.label}" ` : ''}${j.mint_address.slice(0, 8)}… ${j.amount_sol} SOL/${int} buys:${j.total_buys}`;
    }).join('\n')
  );
}));

bot.onText(/\/autobuy add (.+)/, (msg, match) => guard(msg.chat.id, async () => {
  if (!await requirePro(msg.chat.id, msg.from?.id ?? msg.chat.id)) return;
  const parts = (match?.[1] ?? '').trim().split(/\s+/);
  if (parts.length < 3) return send(msg.chat.id, 'Usage: `/autobuy add <mint_or_ticker> <sol> <min> [label]`');
  const [mintOrTicker, solStr, minStr, ...lbl] = parts;
  const amountSol = parseFloat(solStr);
  const intMin    = parseFloat(minStr);
  if (isNaN(amountSol) || amountSol <= 0) return send(msg.chat.id, 'amount_sol must be > 0');
  if (isNaN(intMin) || intMin < 1)        return send(msg.chat.id, 'interval must be ≥ 1 min');
  const isMint = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mintOrTicker);
  const body: any = { amount_sol: amountSol, interval_seconds: Math.round(intMin * 60), label: lbl.length ? lbl.join(' ') : undefined };
  if (isMint) body.mint_address = mintOrTicker; else body.ticker = mintOrTicker;
  const result = await apiPost('/autobuy', body);
  const job    = result.job;
  send(msg.chat.id, `✅ Auto-buy created!\nID: \`${job.id.slice(0, 8)}…\`\n${job.mint_address.slice(0, 12)}… — ${amountSol} SOL every ${intMin}m`);
}));

bot.onText(/\/autobuy stop (.+)/, (msg, match) => guard(msg.chat.id, async () => {
  if (!await requirePro(msg.chat.id, msg.from?.id ?? msg.chat.id)) return;
  const prefix = (match?.[1] ?? '').trim();
  const job = ((await apiGet('/autobuy')).jobs ?? []).find((j: any) => j.id.startsWith(prefix));
  if (!job) return send(msg.chat.id, `Job \`${prefix}…\` not found.`);
  await axios.patch(`${API_BASE}/autobuy/${job.id}`, { active: false });
  send(msg.chat.id, `⏸ Stopped: \`${job.id.slice(0, 8)}…\``);
}));

bot.onText(/\/autobuy resume (.+)/, (msg, match) => guard(msg.chat.id, async () => {
  if (!await requirePro(msg.chat.id, msg.from?.id ?? msg.chat.id)) return;
  const prefix = (match?.[1] ?? '').trim();
  const job = ((await apiGet('/autobuy')).jobs ?? []).find((j: any) => j.id.startsWith(prefix));
  if (!job) return send(msg.chat.id, `Job \`${prefix}…\` not found.`);
  await axios.patch(`${API_BASE}/autobuy/${job.id}`, { active: true });
  send(msg.chat.id, `▶️ Resumed: \`${job.id.slice(0, 8)}…\``);
}));

bot.onText(/\/autobuy delete (.+)/, (msg, match) => guard(msg.chat.id, async () => {
  if (!await requirePro(msg.chat.id, msg.from?.id ?? msg.chat.id)) return;
  const prefix = (match?.[1] ?? '').trim();
  const job = ((await apiGet('/autobuy')).jobs ?? []).find((j: any) => j.id.startsWith(prefix));
  if (!job) return send(msg.chat.id, `Job \`${prefix}…\` not found.`);
  await apiDelete(`/autobuy/${job.id}`);
  send(msg.chat.id, `🗑 Deleted: \`${job.id.slice(0, 8)}…\``);
}));

// ═══════════════════════════════════════════════════════════════════════════════
//  CALLBACK QUERY HANDLER
// ═══════════════════════════════════════════════════════════════════════════════

bot.on('callback_query', async (query) => {
  const chatId = query.message?.chat.id;
  const msgId  = query.message?.message_id;
  const tgId   = query.from?.id ?? chatId ?? 0;
  if (!chatId || !msgId) return;

  await bot.answerCallbackQuery(query.id).catch(() => {});
  const [action, param] = (query.data ?? '').split(':');
  const page = parseInt(param ?? '0', 10) || 0;

  if (action === 'exitcoin_cancel') {
    await bot.editMessageText('❌ Cancelled.', { chat_id: chatId, message_id: msgId }).catch(() => {});
    return;
  }
  if (action === 'exitcoin_confirm') {
    await bot.editMessageText('⏳ Selling...', { chat_id: chatId, message_id: msgId }).catch(() => {});
    try {
      const result = await apiPost(`/launcher/coins/${param}/sell`, { pct: 100 });
      await bot.editMessageText(
        `✅ *Sold!*\nReceived: ${result.solReceived?.toFixed(4)} SOL`,
        { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' }
      ).catch(() => {});
    } catch (err: any) {
      await bot.editMessageText(`❌ Sell failed: ${err.message}`, { chat_id: chatId, message_id: msgId }).catch(() => {});
    }
    return;
  }

  if (action === 'subscribe') {
    const payUrl = `${SITE_URL}/pay?tg_id=${tgId}`;
    await send(chatId,
      `💳 *Subscription Plans*\n\n🧪 1-Day Trial — 0.05 SOL\n⚡ 3-Day Access — 0.1 SOL\n💎 Monthly — 1 SOL / 30 days`,
      { reply_markup: { inline_keyboard: [[{ text: '💳 Open Payment Page', url: payUrl }]] } }
    );
    return;
  }

  if (action === 'status') {
    const s = await getSubStatus(tgId);
    const payUrl = `${SITE_URL}/pay?tg_id=${tgId}`;
    if (!s.active) {
      await send(chatId, `❌ No active subscription.`, { reply_markup: { inline_keyboard: [[{ text: '💳 Get Access', url: payUrl }]] } });
    } else {
      await send(chatId, `✅ *Active* — ${s.isTrial ? '🧪 Trial' : '💎 Monthly'}\nExpires: ${s.expiresAt ?? '?'}\nRemaining: ~${s.remainingHours}h`);
    }
    return;
  }

  if (!await requireSub(chatId, tgId)) return;

  await guard(chatId, async () => {
    switch (action) {
      case 'trending': {
        const data = await apiGet('/tokens/trending');
        const { slice, hasNext, hasPrev, total } = paginate(data.tokens ?? [], page);
        edit(chatId, msgId, `📈 *Trending (${total})* — page ${page + 1}\n\n` + slice.map(fmtToken).join('\n\n'),
          { reply_markup: { inline_keyboard: pageButtons('trending', page, hasNext, hasPrev) } });
        break;
      }
      case 'new': {
        const data = await apiGet('/tokens/new?minutes=30');
        const { slice, hasNext, hasPrev, total } = paginate(data.tokens ?? [], page);
        edit(chatId, msgId, total ? `🆕 *New (${total})* — page ${page + 1}\n\n` + slice.map(fmtToken).join('\n\n') : '🆕 No new tokens.',
          { reply_markup: { inline_keyboard: pageButtons('new', page, hasNext, hasPrev) } });
        break;
      }
      case 'highscore': {
        const data = await apiGet('/tokens/highscore?threshold=80');
        const { slice, hasNext, hasPrev, total } = paginate(data.tokens ?? [], page);
        edit(chatId, msgId, total ? `🏆 *High Score (${total})* — page ${page + 1}\n\n` + slice.map(fmtToken).join('\n\n') : '🏆 None.',
          { reply_markup: { inline_keyboard: pageButtons('highscore', page, hasNext, hasPrev) } });
        break;
      }
      case 'highrisk': {
        const data = await apiGet('/tokens/highrisk?threshold=70');
        const { slice, hasNext, hasPrev, total } = paginate(data.tokens ?? [], page);
        edit(chatId, msgId, total ? `⚠️ *High Risk (${total})* — page ${page + 1}\n\n` + slice.map(fmtToken).join('\n\n') : '⚠️ None.',
          { reply_markup: { inline_keyboard: pageButtons('highrisk', page, hasNext, hasPrev) } });
        break;
      }
      case 'whales': {
        const data = await apiGet('/whales');
        const { slice, hasNext, hasPrev, total } = paginate(data.whales ?? [], page);
        edit(chatId, msgId,
          `🐋 *Whales (${total})* — page ${page + 1}\n\n` +
          slice.map((w: any, i: number) => `${page * PAGE_SIZE + i + 1}. \`${w.address.slice(0, 12)}…\` Score:${w.whale_score}`).join('\n'),
          { reply_markup: { inline_keyboard: pageButtons('whales', page, hasNext, hasPrev) } });
        break;
      }
      case 'smartmoney': {
        const data = await apiGet('/smart-money');
        const { slice, hasNext, hasPrev, total } = paginate(data.smartWallets ?? [], page);
        edit(chatId, msgId,
          `🧠 *Smart Money (${total})* — page ${page + 1}\n\n` +
          slice.map((w: any, i: number) => `${page * PAGE_SIZE + i + 1}. \`${w.address.slice(0, 12)}…\` SM:${w.smart_money_score} ROI:${Number(w.roi).toFixed(0)}%`).join('\n'),
          { reply_markup: { inline_keyboard: pageButtons('smartmoney', page, hasNext, hasPrev) } });
        break;
      }
      case 'alerts': {
        const data = await apiGet('/alerts');
        const { slice, hasNext, hasPrev, total } = paginate(data.alerts ?? [], page);
        edit(chatId, msgId,
          `🚨 *Signals (${total})* — page ${page + 1}\n\n` +
          slice.map((a: any, i: number) => `${page * PAGE_SIZE + i + 1}. *${a.type}* score:${a.score ?? 0}\n   \`${(a.subject ?? '').slice(0, 20)}\``).join('\n\n'),
          { reply_markup: { inline_keyboard: pageButtons('alerts', page, hasNext, hasPrev) } });
        break;
      }
      case 'watchlist': {
        const data   = await apiGet('/watchlist');
        const tokens = data.tokens ?? [];
        edit(chatId, msgId,
          `📋 *Watchlist (${tokens.length})*\n\n` +
          (tokens.slice(0, 12).map((t: any, i: number) => `${i + 1}. ${t.symbol ?? t.mint_address.slice(0, 8)}`).join('\n') || 'Empty.')
        );
        break;
      }
      case 'portfolio': {
        const data  = await apiGet('/portfolio');
        const stats = data.stats ?? {};
        edit(chatId, msgId, `💼 *Portfolio*\nOpen:${stats.open} | WR:${stats.win_rate}% | PnL:$${Number(stats.realized_pnl ?? 0).toFixed(2)}`);
        break;
      }
      case 'analyze':  { await sendAnalysis(chatId, param); break; }
      case 'wl_add': {
        await apiPost('/watchlist/token', { mint: param, addedBy: 'telegram' }).catch(() => {});
        bot.sendMessage(chatId, `✅ \`${param.slice(0, 12)}…\` added to watchlist.`);
        break;
      }
      case 'botstatus': {
        if (!await requirePro(chatId, tgId)) break;
        const data = await apiGet<any>('/autobuy/bot-status');
        const s = data.summary ?? {};
        const opens: any[] = data.openPositions ?? [];
        const winRate = s.win_rate != null ? `${s.win_rate}%` : 'N/A';
        const pnl = s.net_pnl != null ? (Number(s.net_pnl) >= 0 ? `+${s.net_pnl}` : `${s.net_pnl}`) : '0';
        const lines = [
          `🤖 *BOT STATUS — 24h*`,
          `Closed: ${s.closed ?? 0}  Wins: ${s.wins ?? 0}  WR: ${winRate}  PnL: *${pnl} SOL*`,
          opens.length ? opens.slice(0, 5).map((p: any) => `• ${(p.label ?? '').split(':')[3] ?? '?'}  ${p.amount_sol} SOL`).join('\n') : 'No open positions',
        ];
        edit(chatId, msgId, lines.join('\n'), { reply_markup: { inline_keyboard: [[{ text: '🔄 Refresh', callback_data: 'botstatus' }]] } });
        break;
      }
      case 'trades': {
        const offset = page * 10;
        const data = await apiGet<any>(`/autobuy/trades?limit=10&offset=${offset}`);
        const trades: any[] = data.trades ?? [];
        const total = Number(data.total ?? 0);
        const tLines = [`📋 *Trades* (${offset + 1}-${Math.min(offset + 10, total)} of ${total})`, ``];
        for (const t of trades) {
          const sym = (t.label ?? '').split(':')[3] ?? '?';
          const pnlPct = t.total_sold_sol && t.amount_sol
            ? ((Number(t.total_sold_sol) / Number(t.amount_sol) - 1) * 100).toFixed(1) : null;
          const res = !t.total_sold_sol || Number(t.total_sold_sol) === 0 ? '⏳' : Number(pnlPct) >= 0 ? `✅ +${pnlPct}%` : `❌ ${pnlPct}%`;
          tLines.push(`${sym}  ${Number(t.amount_sol).toFixed(3)} SOL  ${res}`);
        }
        const hasNext = offset + 10 < total;
        const hasPrev = page > 0;
        edit(chatId, msgId, tLines.join('\n'), {
          reply_markup: { inline_keyboard: pageButtons('trades', page, hasNext, hasPrev) }
        });
        break;
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  TRADE JOURNAL
// ═══════════════════════════════════════════════════════════════════════════════

bot.onText(/\/journal/, (msg) => guard(msg.chat.id, async () => {
  if (!await requireSub(msg.chat.id, msg.from?.id ?? msg.chat.id)) return;
  const data = await apiGet('/journal?limit=15');
  const { trades, summary } = data;
  const s = summary ?? {};

  const pnlSign = (s.total_pnl ?? 0) >= 0 ? '+' : '';
  let text = `📖 *Trade Journal*\n\n`;
  text += `Trades: *${s.total_trades ?? 0}* | WR: *${s.win_rate ?? 0}%* | PnL: *${pnlSign}${Number(s.total_pnl ?? 0).toFixed(4)} SOL*\n`;
  text += `Wins: ${s.wins ?? 0} / Losses: ${s.losses ?? 0} / Zero: ${s.zero_exits ?? 0}\n`;
  text += `Avg Hold: ${s.avg_hold_min ?? 0}min\n\n`;

  if (!trades?.length) {
    text += '_No trades with executed buys yet._';
  } else {
    text += trades.slice(0, 10).map((t: any, i: number) => {
      const sym = t.symbol ?? t.mint_address?.slice(0, 8) ?? '?';
      const pnl = t.pnl_sol != null ? `${Number(t.pnl_sol) >= 0 ? '+' : ''}${Number(t.pnl_sol).toFixed(4)} SOL` : '?';
      const roi = t.roi_pct != null ? ` (${Number(t.roi_pct) >= 0 ? '+' : ''}${t.roi_pct}%)` : '';
      const stage = t.sell_stage_reached ? ` S${t.sell_stage_reached}` : '';
      const when = t.bought_at ? new Date(t.bought_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '?';
      return `${i + 1}. *${sym}*${stage} ${pnl}${roi} — ${when}`;
    }).join('\n');
  }

  send(msg.chat.id, text, {
    reply_markup: { inline_keyboard: [[
      { text: '📊 Risk Passport', callback_data: 'riskpassport' },
      { text: '📥 Export CSV', url: `${SITE_URL.replace('gadai.shop', 'api.gadai.shop')}/journal/export` },
    ]]}
  });
}));

bot.onText(/\/riskpassport/, (msg) => guard(msg.chat.id, async () => {
  if (!await requireSub(msg.chat.id, msg.from?.id ?? msg.chat.id)) return;
  const data = await apiGet('/riskpassport');
  const p = data.passport;

  if (!p) return send(msg.chat.id, `📊 *Risk Passport*\n\nNo trades yet. Start trading to build your profile.\n\nUse /autobuy or let the bot scan automatically.`);

  const profile_emoji = p.profile === 'DISCIPLINED' ? '🏆' : p.profile === 'LEARNING' ? '📚' : '⚠️';
  const pnlSign = p.total_pnl_sol >= 0 ? '+' : '';

  let text = `📊 *Risk Passport*\n\n`;
  text += `${profile_emoji} Profile: *${p.profile}* | Risk Score: *${p.risk_score}/100*\n\n`;
  text += `Trades: *${p.total_trades}* | WR: *${p.win_rate}%*\n`;
  text += `PnL: *${pnlSign}${p.total_pnl_sol.toFixed(4)} SOL* (ROI: ${p.roi_pct >= 0 ? '+' : ''}${p.roi_pct}%)\n`;
  text += `Avg Hold: *${p.avg_hold_min}min* | RR: *${p.risk_reward}*\n`;
  text += `Wins: ${p.wins} / Losses: ${p.losses} / Zero: ${p.zero_exits}\n\n`;

  text += `*By Tier:*\n`;
  const { t1, t2, t3 } = p.tier_breakdown ?? {};
  if (t1?.trades) text += `  T1 Micro: ${t1.trades} trades, WR: ${t1.win_rate ?? '?'}%\n`;
  if (t2?.trades) text += `  T2 Small: ${t2.trades} trades, WR: ${t2.win_rate ?? '?'}%\n`;
  if (t3?.trades) text += `  T3 Mid:   ${t3.trades} trades, WR: ${t3.win_rate ?? '?'}%\n`;

  if (p.advice?.length) {
    text += `\n*Advice:*\n`;
    text += p.advice.map((a: string) => `• ${a}`).join('\n');
  }

  send(msg.chat.id, text);
}));

bot.onText(/\/tokenscore (.+)/, (msg, match) => guard(msg.chat.id, async () => {
  if (!await requireSub(msg.chat.id, msg.from?.id ?? msg.chat.id)) return;
  const mint = (match?.[1] ?? '').trim();
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) return send(msg.chat.id, '❌ Invalid mint address.');

  await send(msg.chat.id, `🔍 Scoring \`${mint.slice(0, 12)}…\``);
  const data = await apiGet(`/tokenscore/${mint}`);

  const label_emoji =
    data.label === 'SAFE'     ? '🟢' :
    data.label === 'MODERATE' ? '🟡' :
    data.label === 'RISKY'    ? '🟠' : '🔴';

  const sym = data.symbol ?? mint.slice(0, 8);
  let text = `${label_emoji} *TokenScore — ${sym}*\n\n`;
  text += `Score: *${data.score}/100* — ${data.label}\n\n`;
  text += `🛡 Rug Safety:    *${data.components?.rug_safety ?? 0}*/40\n`;
  text += `💧 Liquidity:     *${data.components?.liquidity ?? 0}*/25\n`;
  text += `👥 Community:     *${data.components?.community ?? 0}*/20\n`;
  text += `📝 Transparency:  *${data.components?.transparency ?? 0}*/15\n\n`;
  text += `Rug prob: ${data.rug_probability?.toFixed(0)}% | Holders: ${data.holder_count} | Age: ${data.age_days}d | Liq: $${Number(data.liquidity_usd ?? 0).toLocaleString()}\n`;

  if (data.flags?.length) {
    text += `\n⚠️ *Flags:*\n`;
    text += data.flags.map((f: string) => `• ${f}`).join('\n');
  }
  text += `\n\n\`${mint}\``;

  send(msg.chat.id, text, {
    reply_markup: { inline_keyboard: [[{ text: '🤖 Full Analysis', callback_data: `analyze:${mint}` }]] }
  });
}));

bot.onText(/\/launch/, (msg) => guard(msg.chat.id, async () => {
  if (!await requirePro(msg.chat.id, msg.from?.id ?? msg.chat.id)) return;
  const launchUrl = `${SITE_URL}/launch`;
  send(msg.chat.id,
    `🚀 *Honest Token Launcher*\n\n` +
    `Deploy your token on Pump.fun with full transparency.\n\n` +
    `*What you get:*\n` +
    `• Token deployed on Pump.fun in <30 seconds\n` +
    `• Your budget goes ONLY to initial liquidity\n` +
    `• No coordinated buys, no fake volume\n` +
    `• P&L tracking in /mycoins\n` +
    `• Exit at market price via /exitcoin\n\n` +
    `*Use the Dashboard to launch your token.*\n` +
    `Choose a name, ticker, description, and budget.\n\n` +
    `⚠️ Fair launch only. No pump-and-dump.`,
    {
      reply_markup: { inline_keyboard: [[
        { text: '🚀 Open Launcher', url: `${SITE_URL}/dashboard` },
        { text: '📋 My Tokens', callback_data: 'mycoins' },
      ]]}
    }
  );
}));

// ─── Coin Launcher ────────────────────────────────────────────────────────────

bot.onText(/\/mycoins/, (msg) => guard(msg.chat.id, async () => {
  if (!await requirePro(msg.chat.id, msg.from?.id ?? msg.chat.id)) return;
  const coins: any[] = await apiGet('/launcher/coins');
  if (!coins.length) return send(msg.chat.id, '🚀 *My Tokens*\n\nNo tokens launched yet.\nUse the Dashboard to deploy your first token.');
  const lines = coins.map((c: any) => {
    const pnl  = Number(c.pnlSol);
    const sign = pnl >= 0 ? '+' : '';
    const icon = c.status === 'LIVE' ? '🟢' : c.status === 'SOLD' ? '🟣' : '🟡';
    return `${icon} *${c.name}* ($${c.ticker}) — ${sign}${pnl.toFixed(4)} SOL\n   Status: ${c.status} | Invested: ${c.solInvested} SOL\n   \`${c.mintAddress}\``;
  });
  send(msg.chat.id, `🚀 *My Tokens (${coins.length})*\n\n${lines.join('\n\n')}\n\n_Use /exitcoin <ticker> to sell_`);
}));

bot.onText(/\/exitcoin (.+)/, (msg, match) => guard(msg.chat.id, async () => {
  if (!await requirePro(msg.chat.id, msg.from?.id ?? msg.chat.id)) return;
  const ticker = (match?.[1] ?? '').trim().toUpperCase();
  const coins: any[] = await apiGet('/launcher/coins');
  const coin = coins.find((c: any) => c.ticker.toUpperCase() === ticker && c.status === 'LIVE');
  if (!coin) return send(msg.chat.id, `❌ LIVE token with ticker \`${ticker}\` not found.\nCheck /mycoins for your active tokens.`);

  const confirmMsg = await send(msg.chat.id,
    `⚠️ *Exit ${coin.name} ($${coin.ticker})?*\n\nThis will sell 100% of your position at market price.\nInvested: ${coin.solInvested} SOL`,
    {
      reply_markup: {
        inline_keyboard: [[
          { text: '🚨 YES — Sell Everything', callback_data: `exitcoin_confirm:${coin.mintAddress}` },
          { text: '❌ Cancel', callback_data: 'exitcoin_cancel' }
        ]]
      }
    }
  );
}));

// ═══════════════════════════════════════════════════════════════════════════════
//  TREND-TO-MEMECOIN ENGINE COMMANDS
// ═══════════════════════════════════════════════════════════════════════════════

function fmtTrend(c: any, idx: number): string {
  const age = Math.round((Date.now() - new Date(c.last_seen_at).getTime()) / 60000);
  return `*${idx + 1}. ${c.main_title.slice(0, 60)}*\n` +
    `Score: ${Number(c.final_score).toFixed(0)} | Trend: ${Number(c.trend_score).toFixed(0)} | Meme: ${Number(c.meme_score).toFixed(0)}\n` +
    `Mentions: ${c.total_mentions} | Updated: ${age < 60 ? `${age}m ago` : `${Math.round(age/60)}h ago`}\n` +
    `ID: \`${c.id}\``;
}

function fmtIdea(idea: any): string {
  const posts = (idea.twitter_posts ?? []).slice(0, 2).join('\n\n') || '(no posts)';
  return `*$${idea.ticker}* — ${idea.name}\n` +
    `Score: ${Number(idea.score).toFixed(0)}/100\n\n` +
    `*Meme angle:* ${idea.meme_angle}\n\n` +
    `*Description:*\n${idea.description}\n\n` +
    `*Twitter drafts:*\n${posts}\n\n` +
    `*Logo prompt:* ${(idea.logo_prompt ?? '').slice(0, 100)}\n` +
    (idea.risk_notes ? `*Risk:* ${idea.risk_notes}\n` : '') +
    `ID: \`${idea.id}\``;
}

// /trends — show top trending events
bot.onText(/^\/trends(@\w+)?$/, (msg) => guard(msg.chat.id, async () => {
  const chatId = msg.chat.id;
  await send(chatId, '_Fetching latest trends..._');
  const clusters = await getTopClusters(10);
  if (!clusters.length) {
    await send(chatId, 'No trends found yet. Run /trends again in a few minutes.');
    return;
  }
  const text = `*🔥 Top Trending Events*\n\n` + clusters.map(fmtTrend).join('\n\n');
  await send(chatId, text.slice(0, 4000));
}));

// /trend <id> — show cluster details
bot.onText(/^\/trend(?:@\w+)?\s+(.+)$/, (msg, match) => guard(msg.chat.id, async () => {
  const chatId = msg.chat.id;
  const id = match![1].trim();
  const cluster = await getClusterById(id);
  if (!cluster) { await send(chatId, '❌ Trend not found.'); return; }
  const text = `*${cluster.main_title}*\n\n` +
    `Trend: ${cluster.trend_score.toFixed(0)}/100 | Meme: ${cluster.meme_score.toFixed(0)}/100 | Risk: ${cluster.risk_score.toFixed(0)}/100\n` +
    `Final score: *${cluster.final_score.toFixed(0)}/100*\n\n` +
    `Mentions: ${cluster.total_mentions} | Sources: ${(cluster.sources ?? []).join(', ')}\n` +
    `Entities: ${(cluster.entities ?? []).join(', ')}\n\n` +
    `_To generate coin ideas: /idea ${id}_`;
  await send(chatId, text);
}));

// /ideas — generate ideas for top trends NOW
bot.onText(/^\/ideas(@\w+)?$/, (msg) => guard(msg.chat.id, async () => {
  const chatId = msg.chat.id;
  await send(chatId, '_Generating coin ideas from top trends..._');
  const clusters = await getTopClusters(3);
  if (!clusters.length) { await send(chatId, 'No trends available. Try /trends first.'); return; }
  for (const c of clusters.slice(0, 2)) {
    const ideas = await generateCoinIdeas(c, 2);
    for (const idea of ideas) {
      idea.trend_cluster_id = c.id;
      await saveCoinIdea(idea);
    }
    if (ideas.length) {
      const text = `*🧠 Ideas for: ${c.main_title.slice(0, 50)}*\n\n` + ideas.map(fmtIdea).join('\n\n---\n\n');
      await send(chatId, text.slice(0, 4000));
      await new Promise(r => setTimeout(r, 500));
    }
  }
}));

// /idea <cluster_id> — generate ideas for specific trend
bot.onText(/^\/idea(?:@\w+)?\s+(.+)$/, (msg, match) => guard(msg.chat.id, async () => {
  const chatId = msg.chat.id;
  const id = match![1].trim();
  const cluster = await getClusterById(id);
  if (!cluster) { await send(chatId, '❌ Trend not found.'); return; }
  await send(chatId, `_Generating ideas for: ${cluster.main_title.slice(0, 60)}_`);
  const ideas = await generateCoinIdeas(cluster, 3);
  for (const idea of ideas) {
    idea.trend_cluster_id = id;
    await saveCoinIdea(idea);
  }
  if (!ideas.length) { await send(chatId, '❌ Could not generate ideas (may be blocked by risk filter).'); return; }
  const text = `*🧠 Coin Ideas*\n\n` + ideas.map(fmtIdea).join('\n\n---\n\n');
  await send(chatId, text.slice(0, 4000), {
    reply_markup: {
      inline_keyboard: ideas.map(idea => [
        { text: `✅ Approve $${idea.ticker}`, callback_data: `approve_idea:${idea.id}` },
        { text: `❌ Reject`, callback_data: `reject_idea:${idea.id}` },
      ]),
    },
  });
}));

// /approve_idea <id> or /reject_idea <id>
bot.onText(/^\/approve_idea(?:@\w+)?\s+(.+)$/, (msg, match) => guard(msg.chat.id, async () => {
  await updateIdeaStatus(match![1].trim(), 'approved');
  await send(msg.chat.id, '✅ Idea approved! Ready for launch.');
}));
bot.onText(/^\/reject_idea(?:@\w+)?\s+(.+)$/, (msg, match) => guard(msg.chat.id, async () => {
  await updateIdeaStatus(match![1].trim(), 'rejected');
  await send(msg.chat.id, '🗑️ Idea rejected.');
}));

// Callback buttons for approve/reject
bot.on('callback_query', async (q) => {
  if (!q.data) return;
  if (q.data.startsWith('approve_idea:')) {
    const id = q.data.split(':')[1];
    await updateIdeaStatus(id, 'approved');
    bot.answerCallbackQuery(q.id, { text: '✅ Approved!' });
    bot.sendMessage(q.message!.chat.id, `✅ Idea approved! Use /ideas to see all.`).catch(() => {});
  }
  if (q.data.startsWith('reject_idea:')) {
    const id = q.data.split(':')[1];
    await updateIdeaStatus(id, 'rejected');
    bot.answerCallbackQuery(q.id, { text: '❌ Rejected' });
  }
});

// /alerts — show recent high-score trends as alerts
bot.onText(/^\/alerts(@\w+)?$/, (msg) => guard(msg.chat.id, async () => {
  const chatId = msg.chat.id;
  const clusters = await getTopClusters(5);
  const hot = clusters.filter((c: any) => Number(c.final_score) >= 65);
  if (!hot.length) { await send(chatId, 'No high-score trends right now. Try again later.'); return; }
  const text = `*🚨 Hot Trends (score ≥ 65)*\n\n` + hot.map(fmtTrend).join('\n\n');
  await send(chatId, text.slice(0, 4000));
}));

// Trend engine background worker (every 15 min)
let trendWorkerRunning = false;
const TREND_INTERVAL_MS = 15 * 60 * 1000;
setInterval(async () => {
  if (trendWorkerRunning) return;
  trendWorkerRunning = true;
  try {
    const clusters = await runTrendCycle(false); // don't auto-generate ideas
    // Send alert to admin if top cluster score > 75
    if (ADMIN_ID && clusters.length && clusters[0].final_score >= 75) {
      const c = clusters[0];
      const text =
        `🔥 *New Meme Opportunity*\n\n` +
        `*Trend:* ${c.main_title}\n\n` +
        `*Score:* Trend: ${c.trend_score.toFixed(0)}/100 | Meme: ${c.meme_score.toFixed(0)}/100 | Risk: ${c.risk_score.toFixed(0)}/100\n\n` +
        `*Sources:* ${(c.sources ?? []).join(', ')}\n` +
        `*Mentions:* ${c.total_mentions}\n\n` +
        `_Use /idea ${c.id} to generate coin ideas_`;
      bot.sendMessage(Number(ADMIN_ID), text, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            { text: '🧠 Generate Ideas', callback_data: `gen_ideas:${c.id}` },
          ]],
        },
      }).catch(() => {});
    }
  } catch (e: any) {
    log('error', '[trend-worker]', e.message);
  } finally {
    trendWorkerRunning = false;
  }
}, TREND_INTERVAL_MS);

// ─── Futures Commands (via HTTP to futures service on port 4003) ──────────────

async function futuresApi<T = any>(path: string): Promise<T> {
  const res = await axios.get<T>(`${FUTURES_API}${path}`, { timeout: 10_000 });
  return res.data;
}

// /macro — macro market status
bot.onText(/^\/macro(@\w+)?$/, (msg) => guard(msg.chat.id, async () => {
  if (!await requirePro(msg.chat.id, msg.from?.id ?? msg.chat.id)) return;
  const chatId = msg.chat.id;
  await send(chatId, '🔄 Fetching macro data...');
  try {
    const data = await futuresApi<any>('/macro');
    await send(chatId, data.formatted);
  } catch (e: any) {
    await send(chatId, `❌ Macro error: ${e.message}\n(futures service may be starting)`);
  }
}));

// /signal — technical entry signal for SOL-PERP
bot.onText(/^\/signal(@\w+)?$/, (msg) => guard(msg.chat.id, async () => {
  if (!await requirePro(msg.chat.id, msg.from?.id ?? msg.chat.id)) return;
  const chatId = msg.chat.id;
  await send(chatId, '📊 Analyzing SOL 15m chart...');
  try {
    const [signalData, macroData] = await Promise.all([
      futuresApi<any>('/signal'),
      futuresApi<any>('/macro'),
    ]);
    const combined =
      signalData.formatted + '\n\n' +
      (macroData.ok ? '✅ Macro: FAVORABLE' : '⛔ Macro: CAUTION (score ' + macroData.score + '/100)');
    await send(chatId, combined);
  } catch (e: any) {
    await send(chatId, `❌ Signal error: ${e.message}`);
  }
}));

// /position — show open futures positions
bot.onText(/^\/position(@\w+)?$/, (msg) => guard(msg.chat.id, async () => {
  if (!await requirePro(msg.chat.id, msg.from?.id ?? msg.chat.id)) return;
  const chatId = msg.chat.id;
  try {
    const { positions, mode } = await futuresApi<any>('/positions');
    if (!positions.length) {
      await send(chatId, '📭 No open futures positions.\n\nUse /signal to check for entry.');
      return;
    }
    const modeStr = mode === 'live' ? '🔴 LIVE' : '📝 PAPER';
    const lines: string[] = [`📌 *Open Positions* (${modeStr})\n`];
    for (const p of positions) {
      const age = Math.round((Date.now() - new Date(p.openedAt).getTime()) / 60000);
      lines.push(
        `${p.side === 'LONG' ? '🟢' : '🔴'} *${p.side}* SOL-PERP\n` +
        `Entry: $${Number(p.entryPrice).toFixed(3)}  Size: $${Number(p.sizeUsdc).toFixed(2)} x${p.leverage}\n` +
        `Opened: ${age}m ago  |  ID: \`${p.tradeId.slice(0, 16)}\``
      );
    }
    await send(chatId, lines.join('\n'));
  } catch (e: any) {
    await send(chatId, `❌ Error: ${e.message}`);
  }
}));

// /ftrades — recent trade history
bot.onText(/^\/ftrades(@\w+)?$/, (msg) => guard(msg.chat.id, async () => {
  if (!await requirePro(msg.chat.id, msg.from?.id ?? msg.chat.id)) return;
  const chatId = msg.chat.id;
  try {
    const { trades } = await futuresApi<any>('/trades?limit=10');
    if (!trades.length) {
      await send(chatId, '📭 No closed trades yet.');
      return;
    }
    let wins = 0, losses = 0, totalPnl = 0;
    const lines: string[] = [`📋 *Recent Futures Trades*\n`];
    for (const t of trades.slice(0, 8)) {
      const pnl    = parseFloat(t.pnl_usdc || '0');
      const pnlPct = parseFloat(t.pnl_pct  || '0');
      const emoji  = pnl >= 0 ? '🟢' : '🔴';
      totalPnl += pnl;
      if (pnl >= 0) wins++; else losses++;
      lines.push(`${emoji} ${t.side} ${t.close_reason}  ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(3)} (${pnlPct.toFixed(2)}%)`);
    }
    const wr = trades.length ? Math.round(wins / trades.length * 100) : 0;
    lines.push(`\nTotal P&L: ${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)} | WR: ${wr}% (${wins}W/${losses}L)`);
    await send(chatId, lines.join('\n'));
  } catch (e: any) {
    await send(chatId, `❌ Error: ${e.message}`);
  }
}));

// /capital — capital management status
bot.onText(/^\/capital(@\w+)?$/, (msg) => guard(msg.chat.id, async () => {
  if (!await requirePro(msg.chat.id, msg.from?.id ?? msg.chat.id)) return;
  const chatId = msg.chat.id;
  try {
    const data = await futuresApi<any>('/capital');
    await send(chatId, data.formatted);
  } catch (e: any) {
    await send(chatId, `❌ Error: ${e.message}`);
  }
}));

// /fclose <tradeId> — manually close a position (admin only)
bot.onText(/^\/fclose(?:\s+(.+))?$/, (msg, match) => {
  if (String(msg.chat.id) !== ADMIN_ID) return;
  guard(msg.chat.id, async () => {
    const chatId  = msg.chat.id;
    const tradeId = (match?.[1] || '').trim();
    if (!tradeId) { await send(chatId, 'Usage: /fclose <tradeId>'); return; }
    try {
      const res = await axios.post(`${FUTURES_API}/close`, { tradeId }, { timeout: 10_000 });
      const { pnl, exitPrice } = res.data;
      await send(chatId, `✅ Position closed manually\nExit: $${Number(exitPrice).toFixed(3)}\nP&L: ${pnl >= 0 ? '+' : ''}$${Number(pnl).toFixed(4)}`);
    } catch (e: any) {
      await send(chatId, `❌ Close error: ${e.message}`);
    }
  });
});

// /futures — overview panel
bot.onText(/^\/futures(@\w+)?$/, (msg) => guard(msg.chat.id, async () => {
  if (!await requirePro(msg.chat.id, msg.from?.id ?? msg.chat.id)) return;
  const chatId = msg.chat.id;
  await send(chatId, '🔄 Loading futures dashboard...');
  try {
    const { macro, signal, capital, positions, mode } = await futuresApi<any>('/dashboard');
    const modeStr = mode === 'live' ? '🔴 LIVE (Drift)' : '📝 PAPER';
    const lines = [
      `⚡ *FUTURES DASHBOARD* ${modeStr}`,
      ``,
      `*MACRO* ${macro.ok ? '✅' : '⛔'} Score: ${macro.score}/100`,
      `BTC $${macro.btcPrice?.toFixed(0)}  ${macro.btcChange1h >= 0 ? '+' : ''}${macro.btcChange1h?.toFixed(2)}%/1h  F&G: ${macro.fearGreedIndex}`,
      ``,
      `*SIGNAL* ${signal.signal}  Strength: ${signal.strength}/100`,
      `SOL $${Number(signal.price).toFixed(2)}  RSI: ${Number(signal.rsi14).toFixed(1)}`,
      `EMA21: $${Number(signal.ema21).toFixed(2)}  EMA50: $${Number(signal.ema50).toFixed(2)}`,
      ``,
      `*CAPITAL*`,
      `Total: $${Number(capital.totalUsdc).toFixed(2)}  Avail: $${Number(capital.availableUsdc).toFixed(2)}`,
      `P&L today: ${capital.dailyPnlUsdc >= 0 ? '+' : ''}$${Number(capital.dailyPnlUsdc).toFixed(2)}`,
      ``,
      `*POSITIONS* ${positions.length ? positions.length + ' open' : 'none'}`,
      positions.length ? positions.map((p: any) => `  ${p.side} @$${Number(p.entry_price).toFixed(2)}`).join('\n') : '  No open positions',
      ``,
      `Commands: /macro /signal /position /capital /ftrades`,
    ];
    await send(chatId, lines.join('\n'));
  } catch (e: any) {
    await send(chatId, `❌ Futures dashboard error: ${e.message}\nIs futures service running?`);
  }
}));

// /bot — PRO: bot trading status + open positions + 24h PnL
bot.onText(/^\/bot(@\w+)?$/, (msg) => guard(msg.chat.id, async () => {
  if (!await requirePro(msg.chat.id, msg.from?.id ?? msg.chat.id)) return;
  const chatId = msg.chat.id;
  const data = await apiGet<any>('/autobuy/bot-status');
  const s = data.summary ?? {};
  const opens: any[] = data.openPositions ?? [];
  const closed: any[] = data.recentClosed ?? [];

  const winRate = s.win_rate != null ? `${s.win_rate}%` : 'N/A';
  const pnl = s.net_pnl != null ? (Number(s.net_pnl) >= 0 ? `+${s.net_pnl}` : `${s.net_pnl}`) : '0';
  const lines = [
    `🤖 *BOT STATUS — 24h*`,
    ``,
    `📊 Closed: ${s.closed ?? 0} | Wins: ${s.wins ?? 0} | Losses: ${s.losses ?? 0}`,
    `📈 Win rate: ${winRate} | Net PnL: *${pnl} SOL*`,
    `💸 Total spent: ${s.total_spent ?? 0} SOL`,
    ``,
  ];

  if (opens.length) {
    lines.push(`🟢 *Open Positions (${opens.length})*`);
    for (const p of opens.slice(0, 8)) {
      const sym = (p.label ?? '').split(':')[3] ?? p.label ?? '?';
      const age = p.bought_at ? Math.floor((Date.now() - new Date(p.bought_at).getTime()) / 60000) : '?';
      lines.push(`  • ${sym}  ${p.amount_sol} SOL  ${age}m ago`);
    }
  } else {
    lines.push(`🟢 *Open Positions:* none`);
  }

  lines.push(``, `📋 /trades — see trade history`);
  await send(chatId, lines.join('\n'));
}));

// /trades — STARTER+: last bot auto-trades with PnL
bot.onText(/^\/trades(@\w+)?$/, (msg) => guard(msg.chat.id, async () => {
  if (!await requireSub(msg.chat.id, msg.from?.id ?? msg.chat.id)) return;
  const chatId = msg.chat.id;
  const data = await apiGet<any>('/autobuy/trades?limit=10&offset=0');
  const trades: any[] = data.trades ?? [];
  if (!trades.length) return send(chatId, '📋 No trades yet.');

  const lines = [`📋 *Recent Auto-Trades*`, ``];
  for (const t of trades) {
    const sym = (t.label ?? '').split(':')[3] ?? '?';
    const spent = Number(t.amount_sol).toFixed(3);
    const recv  = Number(t.total_sold_sol ?? 0).toFixed(3);
    const pnlPct = t.total_sold_sol && t.amount_sol
      ? ((Number(t.total_sold_sol) / Number(t.amount_sol) - 1) * 100).toFixed(1)
      : null;
    const res = t.total_sold_sol == null || Number(t.total_sold_sol) === 0
      ? '⏳ open'
      : pnlPct && Number(pnlPct) >= 0 ? `✅ +${pnlPct}%` : `❌ ${pnlPct}%`;
    const time = t.bought_at ? new Date(t.bought_at).toISOString().slice(11, 16) : '?';
    lines.push(`${sym}  ${spent}→${recv} SOL  ${res}  ${time}`);
  }
  if (Number(data.total) > 10) {
    lines.push(``, `_Showing 10 of ${data.total} trades_`);
  }
  await send(chatId, lines.join('\n'), {
    reply_markup: { inline_keyboard: [[{ text: '🔄 Refresh', callback_data: 'trades:0' }]] }
  });
}));

// ─── BASE NETWORK (EVM) commands ─────────────────────────────────────────────

// /basestatus — PRO: Base scanner status
bot.onText(/^\/basestatus(@\w+)?$/, (msg) => guard(msg.chat.id, async () => {
  if (!await requirePro(msg.chat.id, msg.from?.id ?? msg.chat.id)) return;
  const chatId = msg.chat.id;
  try {
    const d = await apiGet<any>('/base/status');
    const today = d.data ?? d;
    const pnl = Number(today.today_pnl_eth ?? 0);
    const lines = [
      `⛓ *BASE NETWORK STATUS*`,
      ``,
      `💰 ETH Balance: ${Number(today.eth_balance ?? 0).toFixed(5)} ETH`,
      `📂 Open Positions: ${today.open_count ?? 0}`,
      ``,
      `*Today*`,
      `Trades: ${today.today_trades ?? 0} | Wins: ${today.today_wins ?? 0}`,
      `PnL: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(5)} ETH`,
      ``,
      `/basepositions — open positions`,
      `/basetrades — trade history`,
    ];
    await send(chatId, lines.join('\n'));
  } catch (e: any) {
    await send(chatId, `❌ Base scanner: ${e.message}\nIs base-scanner running?`);
  }
}));

// /basepositions — PRO: open Base positions
bot.onText(/^\/basepositions(@\w+)?$/, (msg) => guard(msg.chat.id, async () => {
  if (!await requirePro(msg.chat.id, msg.from?.id ?? msg.chat.id)) return;
  const chatId = msg.chat.id;
  try {
    const d = await apiGet<any>('/base/positions?limit=10');
    const positions: any[] = d.data ?? [];
    if (!positions.length) return send(chatId, '⛓ No open Base positions.');
    const lines = [`⛓ *BASE OPEN POSITIONS*`, ``];
    for (const p of positions) {
      const age = p.bought_at ? Math.floor((Date.now() - new Date(p.bought_at).getTime()) / 60000) : '?';
      const tp = p.tp_index ?? 0;
      lines.push(`• ${p.symbol}  ${Number(p.amount_eth).toFixed(4)} ETH  TP${tp}/5  ${age}m`);
      lines.push(`  \`${p.contract_address}\``);
    }
    await send(chatId, lines.join('\n'));
  } catch (e: any) {
    await send(chatId, `❌ Base positions error: ${e.message}`);
  }
}));

// /basetrades — STARTER+: last 10 Base trades
bot.onText(/^\/basetrades(@\w+)?$/, (msg) => guard(msg.chat.id, async () => {
  if (!await requireSub(msg.chat.id, msg.from?.id ?? msg.chat.id)) return;
  const chatId = msg.chat.id;
  try {
    const d = await apiGet<any>('/base/trades?limit=10');
    const trades: any[] = d.data ?? [];
    if (!trades.length) return send(chatId, '⛓ No Base trades yet.');
    const lines = [`⛓ *BASE TRADE HISTORY*`, ``];
    for (const t of trades) {
      const ethIn  = Number(t.amount_eth ?? 0).toFixed(4);
      const ethOut = Number(t.total_sold_eth ?? 0).toFixed(4);
      const pnlPct = t.amount_eth && t.total_sold_eth
        ? ((Number(t.total_sold_eth) / Number(t.amount_eth) - 1) * 100).toFixed(1) : null;
      const icon = pnlPct == null ? '⏳' : Number(pnlPct) >= 0 ? '✅' : '❌';
      const time = t.bought_at ? new Date(t.bought_at).toISOString().slice(11, 16) : '?';
      lines.push(`${icon} ${t.symbol}  ${ethIn}→${ethOut} ETH  ${pnlPct != null ? (Number(pnlPct) >= 0 ? '+' : '') + pnlPct + '%' : 'open'}  ${time}`);
    }
    await send(chatId, lines.join('\n'));
  } catch (e: any) {
    await send(chatId, `❌ Base trades error: ${e.message}`);
  }
}));

// /basestart — PRO admin: enable auto-buy on Base
bot.onText(/^\/basestart(@\w+)?$/, (msg) => guard(msg.chat.id, async () => {
  if (!await requirePro(msg.chat.id, msg.from?.id ?? msg.chat.id)) return;
  const chatId = msg.chat.id;
  await send(chatId,
    `⛓ *Base Auto-Buy*\n\nTo enable: set \`BASE_AUTO_BUY=true\` in .env and restart base-scanner.\n\n` +
    `Default: 0.005 ETH/trade, max 5 positions.\n` +
    `Use /basestatus to check current state.`
  );
}));

// /basetokens — PRO: recently discovered Base tokens
bot.onText(/^\/basetokens(@\w+)?$/, (msg) => guard(msg.chat.id, async () => {
  if (!await requirePro(msg.chat.id, msg.from?.id ?? msg.chat.id)) return;
  const chatId = msg.chat.id;
  try {
    const d = await apiGet<any>('/base/tokens?limit=8');
    const tokens: any[] = d.data ?? [];
    if (!tokens.length) return send(chatId, '⛓ No Base tokens discovered yet.');
    const lines = [`⛓ *DISCOVERED BASE TOKENS*`, ``];
    for (const t of tokens) {
      lines.push(`• *${t.symbol}* — liq $${Number(t.liquidity_usd).toFixed(0)} | +${Number(t.price_change_1h).toFixed(1)}%/1h | score:${t.safe_score}`);
      lines.push(`  \`${t.contract_address}\``);
    }
    await send(chatId, lines.join('\n'));
  } catch (e: any) {
    await send(chatId, `❌ Base tokens error: ${e.message}`);
  }
}));

// ─── X Trend Commands ─────────────────────────────────────────────────────────

// /xtrends — last 10 X trend signals found by social-monitor
bot.onText(/^\/xtrends(@\w+)?$/, (msg) => guard(msg.chat.id, async () => {
  if (!await requirePro(msg.chat.id, msg.from?.id ?? msg.chat.id)) return;
  const chatId = msg.chat.id;
  try {
    const { rows } = await (await import('@lib/db')).query<any>(`
      SELECT theme, keywords, tweet_url, engagement, coin_mint, coin_symbol, action, created_at
      FROM x_trend_signals
      ORDER BY created_at DESC
      LIMIT 10
    `);
    if (!rows.length) return send(chatId, '📡 No X trend signals yet.\nSocial monitor scans every 15 minutes.');
    const lines = [`📡 *X TREND SIGNALS (last 10)*`, ``];
    for (const r of rows) {
      const ts = new Date(r.created_at).toISOString().slice(11, 16);
      const coin = r.coin_symbol ? `→ *${r.coin_symbol}* (\`${(r.coin_mint ?? '').slice(0, 8)}...\`)` : '→ no coin';
      const icon = r.action === 'ALERT_SENT' ? '🔥' : '📊';
      lines.push(`${icon} [${ts}] *${r.theme}* ${coin}`);
      if (r.tweet_url) lines.push(`  [Tweet](${r.tweet_url}) | eng:${r.engagement}`);
    }
    await send(chatId, lines.join('\n'));
  } catch (e: any) {
    await send(chatId, `❌ X trends error: ${e.message}`);
  }
}));

// /xsignal — latest actionable X signal (coin with volume found)
bot.onText(/^\/xsignal(@\w+)?$/, (msg) => guard(msg.chat.id, async () => {
  if (!await requirePro(msg.chat.id, msg.from?.id ?? msg.chat.id)) return;
  const chatId = msg.chat.id;
  try {
    const { rows } = await (await import('@lib/db')).query<any>(`
      SELECT theme, coin_mint, coin_symbol, tweet_url, engagement, created_at
      FROM x_trend_signals
      WHERE coin_mint IS NOT NULL
      ORDER BY created_at DESC
      LIMIT 1
    `);
    if (!rows.length) return send(chatId, '📡 No X trade signals yet. Check back in 15 minutes.');
    const r = rows[0];
    const ts = new Date(r.created_at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    const text =
      `📡 *Latest X Signal* (${ts})\n\n` +
      `Theme: *${r.theme}* | Eng: ${r.engagement}\n` +
      `Token: *${r.coin_symbol}*\n` +
      `CA: \`${r.coin_mint}\`\n\n` +
      `[Source Tweet](${r.tweet_url})\n\n` +
      `_Tip: paste CA into /tokenscore for full analysis_`;
    await send(chatId, text);
  } catch (e: any) {
    await send(chatId, `❌ X signal error: ${e.message}`);
  }
}));

// ─── Auto Launch (ADMIN ONLY) ─────────────────────────────────────────────────

import { launchToken, downloadTgPhoto, getPendingIdeas, LaunchConfig } from './launcher';

// In-memory launch session per admin chat
const launchSessions = new Map<number, {
  ideaId?: string; ticker: string; name: string; description: string;
  devBuySol: number; w2BuySol: number; w3BuySol: number;
  waitingImage: boolean;
}>();

function isAdmin(chatId: number): boolean {
  return ADMIN_ID != null && String(chatId) === String(ADMIN_ID);
}

// /auto_launch — show pending ideas OR show usage
bot.onText(/^\/auto_launch(@\w+)?$/, async (msg) => {
  if (!isAdmin(msg.chat.id)) return;
  const chatId = msg.chat.id;

  const ideas = await getPendingIdeas(8).catch(() => []);
  if (!ideas.length) {
    return send(chatId,
      `🚀 *Auto Launch — No pending ideas*\n\n` +
      `Use /trends to find trends, then /idea <cluster_id> to generate coin ideas.\n\n` +
      `Or launch manually:\n` +
      `/auto_launch TICKER "Token Name" "Description" DEV_SOL W2_SOL W3_SOL\n\n` +
      `Example:\n` +
      `/auto_launch MOON "Moon Dog" "Dog going to the moon" 0.1 0.05 0.03`
    );
  }

  const lines = [`🚀 *Auto Launch — Pending Ideas*`, ``];
  for (const idea of ideas) {
    lines.push(`• *${idea.ticker}* — ${idea.name} (score: ${idea.score}) [${idea.status}]`);
    lines.push(`  ID: \`${idea.id}\``);
    lines.push(`  /auto_launch ${idea.id}`);
  }
  lines.push(`\n_Send /auto_launch <id> to start launching_`);
  await send(chatId, lines.join('\n'));
});

// /auto_launch <id_or_args> — start launch session for a specific idea or manual config
bot.onText(/^\/auto_launch(?:@\w+)?\s+(.+)$/, async (msg, match) => {
  if (!isAdmin(msg.chat.id)) return;
  const chatId = msg.chat.id;
  const args = (match![1] ?? '').trim();

  // Check if it's a UUID (existing idea from DB)
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (uuidRe.test(args)) {
    const { rows } = await (await import('@lib/db')).query<any>(
      'SELECT * FROM coin_ideas WHERE id = $1', [args]
    );
    if (!rows.length) return send(chatId, `❌ Idea ${args} not found.`);
    const idea = rows[0];
    launchSessions.set(chatId, {
      ideaId: idea.id, ticker: idea.ticker, name: idea.name,
      description: idea.description ?? '',
      devBuySol: 0.1, w2BuySol: 0.05, w3BuySol: 0.03, waitingImage: true,
    });
    return send(chatId,
      `🚀 *Ready to launch:* ${idea.ticker} — ${idea.name}\n\n` +
      `Description: ${(idea.description ?? '').slice(0, 200)}\n\n` +
      `*Now send the token logo image (photo) to this chat.*\n` +
      `The bot will upload it to Pinata and create the token on pump.fun.\n\n` +
      `Buys: W1 dev 0.1 SOL | W2 +12min 0.05 SOL | W3 +28min 0.03 SOL\n` +
      `_Send /launch_cancel to abort_`
    );
  }

  // Manual config: TICKER "Name" "Description" dev_sol w2_sol w3_sol
  const parts = args.match(/^(\w+)\s+"([^"]+)"\s+"([^"]+)"\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)$/);
  if (!parts) {
    return send(chatId,
      `❌ Invalid format. Use:\n` +
      `/auto_launch TICKER "Token Name" "Description" DEV_SOL W2_SOL W3_SOL\n\n` +
      `Example:\n/auto_launch MOON "Moon Dog" "Dog going to the moon" 0.1 0.05 0.03`
    );
  }
  const [, ticker, name, description, devStr, w2Str, w3Str] = parts;
  launchSessions.set(chatId, {
    ticker: ticker.toUpperCase(), name, description,
    devBuySol: Number(devStr), w2BuySol: Number(w2Str), w3BuySol: Number(w3Str),
    waitingImage: true,
  });
  await send(chatId,
    `🚀 *Manual launch configured:*\n` +
    `Token: *${ticker.toUpperCase()}* — ${name}\n` +
    `Dev buy: ${devStr} SOL | W2: ${w2Str} SOL | W3: ${w3Str} SOL\n\n` +
    `*Send the token logo image (photo) to launch.*\n` +
    `_/launch_cancel to abort_`
  );
});

bot.onText(/^\/launch_cancel$/, async (msg) => {
  if (!isAdmin(msg.chat.id)) return;
  launchSessions.delete(msg.chat.id);
  await send(msg.chat.id, '❌ Launch cancelled.');
});

// Handle photo for launch
bot.on('photo', async (msg) => {
  if (!isAdmin(msg.chat.id)) return;
  const session = launchSessions.get(msg.chat.id);
  if (!session?.waitingImage) return;

  launchSessions.delete(msg.chat.id);
  const chatId = msg.chat.id;

  await send(chatId, `📤 Got it! Uploading logo and launching *${session.ticker}* on pump.fun...`);

  try {
    const photos = msg.photo!;
    const bestPhoto = photos[photos.length - 1]; // highest quality
    const imageBuffer = await downloadTgPhoto(bestPhoto.file_id);

    const cfg: LaunchConfig = {
      name:         session.name,
      ticker:       session.ticker,
      description:  session.description,
      imageBuffer,
      imageType:    'image/jpeg',
      website:      'https://gadai.shop',
      twitter:      'https://x.com/gadaisol',
      telegram:     'https://t.me/gadfamilytg',
      devBuySol:    session.devBuySol,
      w2BuySol:     session.w2BuySol,
      w3BuySol:     session.w3BuySol,
      w2DelayMs:    12 * 60 * 1000,  // 12 min
      w3DelayMs:    16 * 60 * 1000,  // +16 min = T+28min total
    };

    const result = await launchToken(cfg);

    if (result.ok) {
      await send(chatId,
        `✅ *TOKEN LAUNCHED!*\n\n` +
        `*${session.ticker}* — ${session.name}\n\n` +
        `🪙 CA: \`${result.mintAddr}\`\n` +
        `📌 Image: [IPFS](${result.imageUrl})\n` +
        `📄 Meta: [Pinata](${result.metaUri})\n\n` +
        `[pump.fun](https://pump.fun/coin/${result.mintAddr}) | [Solscan TX](https://solscan.io/tx/${result.createTx})\n\n` +
        `W2 buys in 12min (+${cfg.w2BuySol} SOL)\n` +
        `W3 buys in 28min (+${cfg.w3BuySol} SOL)`
      );
    } else {
      await send(chatId, `❌ Launch failed: ${result.error}`);
    }
  } catch (e: any) {
    await send(chatId, `❌ Error during launch: ${e.message}`);
  }
});

// ─── Errors ───────────────────────────────────────────────────────────────────
bot.on('polling_error', (err) => log('error', 'polling:', err.message));
if (ADMIN_ID) bot.sendMessage(ADMIN_ID, '🤖 GAD AI Terminal online.').catch(() => {});
log('info', 'Telegram bot running. t.me/gadai_sol_bot');
