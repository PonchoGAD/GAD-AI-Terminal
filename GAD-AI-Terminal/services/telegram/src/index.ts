import dotenv from 'dotenv';
import TelegramBot from 'node-telegram-bot-api';
import axios from 'axios';

dotenv.config();

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const API_BASE  = process.env.API_BASE_URL || 'http://localhost:4000';
const SITE_URL  = process.env.SITE_URL     || 'https://gadai.com';
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

async function requireSub(chatId: number, telegramId: number): Promise<boolean> {
  const status  = await getSubStatus(telegramId);
  if (status.active) return true;

  const payUrl = `${SITE_URL}/pay?tg_id=${telegramId}`;
  const msg = status.walletLinked
    ? `🔒 *Subscription expired.*\nRenew to continue using GAD AI Terminal.\n\n🧪 Trial — 0.1 SOL / 1 day\n💎 Monthly — 1 SOL / 30 days`
    : `🔒 *Access Required*\n\nSubscription needed to use this feature.\n\n🧪 Trial — 0.1 SOL / 1 day\n💎 Monthly — 1 SOL / 30 days\n\nConnect Phantom or Solflare on the payment page.`;

  await send(chatId, msg, {
    reply_markup: { inline_keyboard: [[{ text: '💳 Get Access', url: payUrl }]] }
  });
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

bot.onText(/\/start/, (msg) => {
  const name = msg.from?.first_name ?? 'degen';
  send(msg.chat.id,
    `🤖 *GAD AI Terminal*\n\nGM, ${name}! The Solana degen terminal is live.\n\n` +
    `*Premium commands:*\n/trending /new /highscore /highrisk\n/token /analyze /whales /signals\n/portfolio /watchlist /autobuy\n\n` +
    `*Free:*\n/subscribe — get access\n/status — subscription info\n/wallet — link Solana wallet\n\nWAGMI 🚀`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: '📈 Trending',    callback_data: 'trending:0' }, { text: '🆕 New Tokens',  callback_data: 'new:0' }],
          [{ text: '🏆 High Score',  callback_data: 'highscore:0' }, { text: '⚠️ High Risk',  callback_data: 'highrisk:0' }],
          [{ text: '🐋 Whales',      callback_data: 'whales:0' },   { text: '🧠 Smart Money', callback_data: 'smartmoney:0' }],
          [{ text: '📋 Watchlist',   callback_data: 'watchlist:0' }, { text: '🚨 Signals',    callback_data: 'alerts:0' }],
          [{ text: '💼 Portfolio',   callback_data: 'portfolio:0' }],
          [{ text: '💳 Subscribe',   callback_data: 'subscribe' },  { text: '📊 My Status',  callback_data: 'status' }],
        ]
      }
    }
  );
});

bot.onText(/\/help/, (msg) => {
  send(msg.chat.id,
    `*GAD AI Terminal — Commands*\n\n` +
    `*Free (no subscription needed):*\n` +
    `/start — main menu\n/subscribe — get access\n/status — subscription status\n/wallet <address> — link Solana wallet\n\n` +
    `*Requires active subscription:*\n` +
    `/trending — top tokens by AI score\n/new — recent tokens\n/highscore — AI ≥ 80\n/highrisk — risk ≥ 70\n` +
    `/token <mint> — token details\n/analyze <mint> — full GAD AI report\n` +
    `/whales — top whale traders\n/signals — active signals\n` +
    `/portfolio — positions & P&L\n/watchlist — your watchlist\n` +
    `/autobuy list|add|stop|resume|delete`
  );
});

bot.onText(/\/subscribe/, (msg) => guard(msg.chat.id, async () => {
  const tgId   = msg.from?.id ?? msg.chat.id;
  const payUrl = `${SITE_URL}/pay?tg_id=${tgId}`;
  send(msg.chat.id,
    `💳 *Subscription Plans*\n\n` +
    `🧪 *1-Day Trial* — 0.1 SOL\n  24 hours access, one trial per wallet\n\n` +
    `💎 *Monthly Full Access* — 1 SOL\n  30 days, all features unlocked\n\n` +
    `Payment goes directly to treasury on Solana mainnet.\nAccepted wallets: Phantom, Solflare.`,
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
  const plan    = status.isTrial ? '🧪 1-Day Trial' : '💎 Monthly';
  const expires = status.expiresAt
    ? new Date(status.expiresAt).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }) + ' UTC'
    : '?';
  send(msg.chat.id,
    `📊 *Status*\n\n✅ *Active*\nPlan: ${plan}\nExpires: ${expires}\nRemaining: ~${status.remainingHours}h\nWallet: \`${status.wallet?.slice(0, 16)}…\``
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
  if (!await requireSub(msg.chat.id, msg.from?.id ?? msg.chat.id)) return;
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
  if (!await requireSub(msg.chat.id, msg.from?.id ?? msg.chat.id)) return;
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
  if (!await requireSub(msg.chat.id, msg.from?.id ?? msg.chat.id)) return;
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
  if (!await requireSub(msg.chat.id, msg.from?.id ?? msg.chat.id)) return;
  const prefix = (match?.[1] ?? '').trim();
  const job = ((await apiGet('/autobuy')).jobs ?? []).find((j: any) => j.id.startsWith(prefix));
  if (!job) return send(msg.chat.id, `Job \`${prefix}…\` not found.`);
  await axios.patch(`${API_BASE}/autobuy/${job.id}`, { active: false });
  send(msg.chat.id, `⏸ Stopped: \`${job.id.slice(0, 8)}…\``);
}));

bot.onText(/\/autobuy resume (.+)/, (msg, match) => guard(msg.chat.id, async () => {
  if (!await requireSub(msg.chat.id, msg.from?.id ?? msg.chat.id)) return;
  const prefix = (match?.[1] ?? '').trim();
  const job = ((await apiGet('/autobuy')).jobs ?? []).find((j: any) => j.id.startsWith(prefix));
  if (!job) return send(msg.chat.id, `Job \`${prefix}…\` not found.`);
  await axios.patch(`${API_BASE}/autobuy/${job.id}`, { active: true });
  send(msg.chat.id, `▶️ Resumed: \`${job.id.slice(0, 8)}…\``);
}));

bot.onText(/\/autobuy delete (.+)/, (msg, match) => guard(msg.chat.id, async () => {
  if (!await requireSub(msg.chat.id, msg.from?.id ?? msg.chat.id)) return;
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

  if (action === 'subscribe') {
    const payUrl = `${SITE_URL}/pay?tg_id=${tgId}`;
    await send(chatId,
      `💳 *Subscription Plans*\n\n🧪 Trial — 0.1 SOL / 1 day\n💎 Monthly — 1 SOL / 30 days`,
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
    }
  });
});

// ─── Errors ───────────────────────────────────────────────────────────────────
bot.on('polling_error', (err) => log('error', 'polling:', err.message));
if (ADMIN_ID) bot.sendMessage(ADMIN_ID, '🤖 GAD AI Terminal online.').catch(() => {});
log('info', 'Telegram bot running. t.me/gadai_sol_bot');
