/**
 * Social Sentiment Filter — pump.fun thread activity check.
 *
 * Research finding: scam tokens launched by bots have 0-2 comments.
 * Tokens that survive and reach Raydium typically have ≥5 unique replies within first 5 min.
 *
 * Note: pump.fun frontend API may be blocked from VPS (Cloudflare 530).
 * Fail-open pattern: if API unreachable, return `true` to avoid blocking the strategy.
 *
 * Cache: 5 min per mint (token sentiment doesn't change rapidly).
 */

import axios from 'axios';

// Cache: mint → { active, ts }
interface SentCache { active: boolean; replyCount: number; ts: number }
const cache = new Map<string, SentCache>();
const CACHE_TTL_MS = 5 * 60 * 1000;

// User-agent rotation to reduce Cloudflare detection
const UA_POOL = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/123.0.0.0 Safari/537.36',
];
let uaIdx = 0;
function nextUA(): string { return UA_POOL[uaIdx++ % UA_POOL.length]; }

export interface SocialResult {
  active:     boolean;   // true = organic community activity detected
  replyCount: number;
  mcapUsd:    number;
  reason:     string;
}

const FAIL_OPEN: SocialResult = { active: true, replyCount: 0, mcapUsd: 0, reason: 'api_blocked_failopen' };

/**
 * Check if a pump.fun token has organic community activity.
 * Conditions for "active":
 *   - reply_count >= MIN_REPLIES (default 5)
 *   - mcap < MAX_MCAP_USD (don't check already-pumpd tokens)
 */
export async function checkPumpFunSentiment(
  mintAddress: string,
  minReplies = 5,
  maxMcapUsd = 15000
): Promise<SocialResult> {
  const cached = cache.get(mintAddress);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return {
      active: cached.active,
      replyCount: cached.replyCount,
      mcapUsd: 0,
      reason: cached.active ? 'cached_active' : `cached_dead: ${cached.replyCount} replies`,
    };
  }

  try {
    const res = await axios.get(
      `https://frontend-api.pump.fun/coins/${mintAddress}`,
      {
        headers: {
          'User-Agent':  nextUA(),
          'Accept':      'application/json',
          'Referer':     'https://pump.fun',
          'Origin':      'https://pump.fun',
        },
        timeout: 4_000,
      }
    );

    if (!res.data) {
      cache.set(mintAddress, { active: true, replyCount: 0, ts: Date.now() });
      return FAIL_OPEN;
    }

    const replyCount  = Number(res.data.reply_count  ?? 0);
    const mcapUsd     = Number(res.data.usd_market_cap ?? 0);
    const kingOfHill  = Boolean(res.data.king_of_the_hill_timestamp);  // viral signal
    const complete    = Boolean(res.data.complete);  // already graduated

    // Token already graduated — not relevant for bonding curve strategy
    if (complete) {
      cache.set(mintAddress, { active: false, replyCount, ts: Date.now() });
      return { active: false, replyCount, mcapUsd, reason: 'already_graduated' };
    }

    // "King of the Hill" status = very high organic activity
    if (kingOfHill) {
      cache.set(mintAddress, { active: true, replyCount, ts: Date.now() });
      return { active: true, replyCount, mcapUsd, reason: `king_of_the_hill: ${replyCount} replies` };
    }

    const active = replyCount >= minReplies && mcapUsd < maxMcapUsd;
    const reason = active
      ? `organic: ${replyCount} replies, mcap $${mcapUsd.toFixed(0)}`
      : `dead: only ${replyCount}/${minReplies} replies (mcap $${mcapUsd.toFixed(0)})`;

    cache.set(mintAddress, { active, replyCount, ts: Date.now() });
    return { active, replyCount, mcapUsd, reason };

  } catch (err: any) {
    const status = err.response?.status;

    if (status === 403 || status === 530 || status === 429) {
      // Cloudflare block — fail open so VPS doesn't permanently lose this filter
      console.debug(`[social-sentiment] pump.fun API blocked (${status}) — fail open for ${mintAddress.slice(0, 8)}`);
      cache.set(mintAddress, { active: true, replyCount: 0, ts: Date.now() });
      return FAIL_OPEN;
    }

    if (status === 404) {
      // Token not found on pump.fun (may have migrated)
      cache.set(mintAddress, { active: false, replyCount: 0, ts: Date.now() });
      return { active: false, replyCount: 0, mcapUsd: 0, reason: 'not_found_on_pumpfun' };
    }

    // Other error — fail open
    cache.set(mintAddress, { active: true, replyCount: 0, ts: Date.now() });
    return FAIL_OPEN;
  }
}
