/**
 * Social Monitor — main loop
 * Polls monitored_accounts every N minutes, stores social_signals in DB,
 * and updates hype scores for mentioned tokens.
 */
import { query } from '@lib/db';
import { fetchTweetsForHandle } from './twitter';
import { scanXTrends, XTrend } from './x-trends';
import { huntCoinForTheme } from './coin-hunter';
import { runTrendLaunchCycle } from './trend-launcher';
import { runFreeAlphaCycle } from './free-aggregator';
import axios from 'axios';

const POLL_INTERVAL_MS = Number(process.env.SOCIAL_POLL_INTERVAL_SECONDS ?? '120') * 1000;

// UTC quiet hours: skip LLM-heavy cycles to save API credits (default 00:00-07:00 UTC)
const QUIET_START = Number(process.env.QUIET_HOURS_START ?? '0');
const QUIET_END   = Number(process.env.QUIET_HOURS_END   ?? '7');
function isQuietHour(): boolean {
  const h = new Date().getUTCHours();
  return h >= QUIET_START && h < QUIET_END;
}

interface MonitoredAccount {
  id:              string;
  platform:        string;
  handle:          string;
  influence_score: number;
  last_checked_at: string | null;
}

/** Fetch accounts that need checking (haven't been checked in POLL_INTERVAL) */
async function getDueAccounts(): Promise<MonitoredAccount[]> {
  const { rows } = await query<MonitoredAccount>(`
    SELECT id, platform, handle, influence_score, last_checked_at
    FROM monitored_accounts
    WHERE active = true
      AND (last_checked_at IS NULL OR last_checked_at < now() - ($1 || ' seconds')::interval)
    ORDER BY influence_score DESC
    LIMIT 10
  `, [String(POLL_INTERVAL_MS / 1000)]);
  return rows;
}

/** Store a signal in DB and link to any detected tokens */
async function storeSocialSignal(
  account: MonitoredAccount,
  tweetId: string,
  text: string,
  detectedMints: string[],
  sentiment: number,
  engagement: number,
  createdAt: Date
): Promise<void> {
  // Upsert signal (idempotent on source_id)
  await query(`
    INSERT INTO social_signals
      (source, source_id, author, content, detected_tokens, sentiment, engagement, influence_score)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    ON CONFLICT DO NOTHING
  `, [
    account.platform,
    tweetId,
    account.handle,
    text.slice(0, 2000),
    detectedMints,
    sentiment,
    engagement,
    account.influence_score
  ]);

  // Bump social_metrics velocity for each mentioned token
  for (const mint of detectedMints) {
    await query(`
      UPDATE social_metrics sm
      SET mention_count    = mention_count + 1,
          mention_velocity = mention_velocity + 1,
          snapshot_at      = now()
      FROM tokens t
      WHERE t.id = sm.token_id AND t.mint_address = $1
    `, [mint]).catch(() => {});
  }
}

/** Poll a single Twitter account */
async function pollTwitterAccount(account: MonitoredAccount): Promise<number> {
  // Load sinceId from last processed tweet
  const lastQ = await query<{ source_id: string }>(
    `SELECT source_id FROM social_signals WHERE author = $1 AND source = 'twitter' ORDER BY created_at DESC LIMIT 1`,
    [account.handle]
  );
  const sinceId = lastQ.rows[0]?.source_id;

  const tweets = await fetchTweetsForHandle(account.handle, sinceId);
  let stored = 0;

  for (const tweet of tweets) {
    // Only store if it has token mentions OR if from a very high-influence account
    if (tweet.detectedMints.length > 0 || account.influence_score >= 80) {
      await storeSocialSignal(
        account,
        tweet.id,
        tweet.text,
        tweet.detectedMints,
        tweet.sentiment,
        tweet.engagement,
        tweet.createdAt
      );
      stored++;
    }
  }

  return stored;
}

/** Mark account as checked */
async function markChecked(accountId: string): Promise<void> {
  await query(`UPDATE monitored_accounts SET last_checked_at = now() WHERE id = $1`, [accountId]);
}

/** One monitoring cycle */
async function runMonitorCycle(): Promise<void> {
  const accounts = await getDueAccounts();
  if (!accounts.length) return;

  for (const account of accounts) {
    try {
      let count = 0;

      if (account.platform === 'twitter') {
        count = await pollTwitterAccount(account);
      }
      // Future: add telegram channel polling here

      if (count > 0) {
        console.info(`[social] @${account.handle}: ${count} new signals stored`);
      }
    } catch (err: any) {
      const status = (err as any).response?.status;
      if (status === 402 || status === 403 || status === 429) {
        console.debug(`[social] @${account.handle} unavailable (${status}) — Nitter/Twitter rate-limited, skipping`);
      } else {
        console.warn(`[social] @${account.handle} failed: ${err.message}`);
      }
    } finally {
      await markChecked(account.id);
    }

    // Rate limit: 1 request/second
    await new Promise(r => setTimeout(r, 1000));
  }
}

/** Mark high-engagement signals as processed and route to intelligence */
async function processUnprocessedSignals(): Promise<void> {
  const { rows } = await query<{
    id: string; author: string; content: string;
    detected_tokens: string[]; influence_score: number; engagement: number;
  }>(`
    SELECT id, author, content, detected_tokens, influence_score, engagement
    FROM social_signals
    WHERE processed = false
      AND (array_length(detected_tokens, 1) > 0 OR engagement > 100)
    ORDER BY created_at DESC
    LIMIT 50
  `);

  for (const sig of rows) {
    // Mark as processed
    await query(`UPDATE social_signals SET processed = true WHERE id = $1`, [sig.id]);

    // Log high-impact signals
    if (sig.influence_score >= 80 && sig.detected_tokens.length > 0) {
      console.info(
        `[social] HIGH-IMPACT: @${sig.author} (influence ${sig.influence_score}) ` +
        `mentions ${sig.detected_tokens.join(', ')} | engagement ${sig.engagement}`
      );
    }
  }
}

const TG_BOT_TOKEN  = process.env.TELEGRAM_BOT_TOKEN ?? '';
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID ?? process.env.TELEGRAM_ADMIN_CHAT_ID ?? '';

async function sendTelegramAlert(text: string): Promise<void> {
  if (!TG_BOT_TOKEN || !ADMIN_CHAT_ID) return;
  try {
    await axios.post(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
      chat_id: ADMIN_CHAT_ID,
      text,
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
    }, { timeout: 8000 });
  } catch (err: any) {
    console.warn(`[social] TG alert failed: ${err.message}`);
  }
}

async function saveXSignal(trend: XTrend, coinMint: string | null, coinSymbol: string | null, action: string): Promise<void> {
  await query(`
    INSERT INTO x_trend_signals
      (theme, keywords, tweet_url, engagement, coin_mint, coin_symbol, action)
    VALUES ($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT DO NOTHING
  `, [
    trend.theme,
    trend.keywords,
    trend.tweetUrl,
    trend.engagement,
    coinMint,
    coinSymbol,
    action,
  ]).catch(() => {});
}

async function runXTrendCycle(): Promise<void> {
  const trends = await scanXTrends();
  if (!trends.length) return;

  // Process top 3 trends
  for (const trend of trends.slice(0, 3)) {
    const coin = await huntCoinForTheme(trend.theme, trend.keywords);

    if (coin) {
      const signalText =
        `🔥 *X TREND SIGNAL*\n` +
        `Theme: *${trend.theme}* (${trend.retweets} RT, ${trend.likes} ❤️)\n` +
        `"${trend.topTweet.slice(0, 120)}..."\n\n` +
        `🪙 *${coin.symbol}* (${coin.name})\n` +
        `Liq: $${(coin.liqUsd / 1000).toFixed(0)}k | Vol24h: $${(coin.vol24h / 1000).toFixed(0)}k\n` +
        `5m: ${coin.priceChange5m > 0 ? '+' : ''}${coin.priceChange5m.toFixed(1)}% | 1h: ${coin.priceChange1h > 0 ? '+' : ''}${coin.priceChange1h.toFixed(1)}%\n` +
        `DEX: ${coin.dex} | Score: ${coin.score.toFixed(1)}\n` +
        `[DexScreener](${coin.pairUrl}) | [Tweet](${trend.tweetUrl})\n\n` +
        `CA: \`${coin.mint}\``;

      console.info(`[social] 🔥 X trend → ${trend.theme} → ${coin.symbol} (score: ${coin.score.toFixed(1)})`);
      await sendTelegramAlert(signalText);
      await saveXSignal(trend, coin.mint, coin.symbol, 'ALERT_SENT');
    } else {
      // Log trend without a coin match for later review
      console.info(`[social] X trend: ${trend.theme} — no tradeable coin found`);
      await saveXSignal(trend, null, null, 'NO_COIN');
    }

    await new Promise(r => setTimeout(r, 1000));
  }
}

export async function startSocialMonitor(): Promise<void> {
  console.info(`[social] Social Monitor started. Poll interval: ${POLL_INTERVAL_MS / 1000}s`);

  let shouldStop = false;
  process.on('SIGINT',  () => { shouldStop = true; });
  process.on('SIGTERM', () => { shouldStop = true; });

  // Offset X trend cycle so it doesn't run simultaneously with KOL poll
  setTimeout(() => {
    const runXCycle = async () => {
      if (shouldStop) return;
      if (!isQuietHour()) {
        try { await runXTrendCycle(); } catch (err: any) { console.warn(`[social] X cycle error: ${err.message}`); }
      }
      if (!shouldStop) setTimeout(runXCycle, 15 * 60 * 1000);
    };
    runXCycle();
  }, 60_000); // first run 60s after start

  // Trend auto-launch cycle: every 4h, checks cooldown + min engagement internally
  setTimeout(() => {
    const runLaunchCycle = async () => {
      if (shouldStop) return;
      try { await runTrendLaunchCycle(); } catch (err: any) { console.warn(`[social] Trend launch error: ${err.message}`); }
      if (!shouldStop) setTimeout(runLaunchCycle, 4 * 60 * 60 * 1000);
    };
    runLaunchCycle();
  }, 3 * 60 * 1000); // first check 3 min after start

  // Free Alpha Aggregator: Reddit + DexScreener profiles + Telegram web — every 5 min, zero API cost
  setTimeout(() => {
    const runAlphaCycle = async () => {
      if (shouldStop) return;
      if (!isQuietHour()) {
        try { await runFreeAlphaCycle(); } catch (err: any) { console.debug(`[social] Free alpha error: ${err.message}`); }
      }
      if (!shouldStop) setTimeout(runAlphaCycle, 5 * 60 * 1000);
    };
    runAlphaCycle();
  }, 2 * 60 * 1000); // first run 2 min after start

  while (!shouldStop) {
    try {
      await runMonitorCycle();
      await processUnprocessedSignals();
    } catch (err: any) {
      console.error('[social] Cycle error:', err.message);
    }

    if (shouldStop) break;
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }

  console.info('[social] Social Monitor stopped.');
}
