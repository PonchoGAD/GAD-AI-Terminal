/**
 * Launcher filter: verifies a Base token was deployed by an official meme launchpad factory.
 *
 * Why: All cbXRP/cbADA scams and L1 impersonators are deployed by random EOAs.
 * Clanker and Virtual.tech tokens are deployed by known factory contracts — any
 * other creator = not a meme launchpad token → skip.
 *
 * Mode: BASE_LAUNCHER_ONLY=true → REQUIRE factory match (hard filter)
 *       BASE_LAUNCHER_ONLY=false → factory check is soft (logged but not enforced)
 */

import axios from 'axios';

// ─── Known factory addresses (add new versions as launchpads upgrade) ─────────
const CLANKER_FACTORIES = new Set([
  // Clanker V2 factory (2024-2025)
  '0x6ee98c9d12dd7b6b07eb77fc44a11b81bd25c94',
  // Clanker V3 factory (user-provided — verify if tokens aren't detected)
  '0x1fc81a106fb8ec387ec4440268571473105ff761',
]);

const VIRTUAL_FACTORIES = new Set([
  // Virtual Protocol token factory
  '0x0b3f868e0be5597d5db7feb59e1cadabb0015506',
]);

// Additional known deployers from DexScreener labels
const ALL_LAUNCHPAD_FACTORIES = new Set([
  ...CLANKER_FACTORIES,
  ...VIRTUAL_FACTORIES,
]);

// Add custom factories via env: BASE_EXTRA_FACTORIES=0xABC,0xDEF
const extras = (process.env.BASE_EXTRA_FACTORIES ?? '').split(',').map(a => a.trim().toLowerCase()).filter(Boolean);
extras.forEach(a => ALL_LAUNCHPAD_FACTORIES.add(a));

// ─── Basescan creator cache (avoid spamming API on same token) ────────────────
const creatorCache = new Map<string, { creator: string; ts: number }>();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

async function getTokenCreator(tokenAddress: string): Promise<string | null> {
  const addr = tokenAddress.toLowerCase();
  const cached = creatorCache.get(addr);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.creator;

  const apiKey = process.env.BASESCAN_API_KEY;
  if (!apiKey) return null; // without API key, skip creator check

  try {
    const url = `https://api.basescan.org/api?module=contract&action=getcontractcreation&contractaddresses=${addr}&apikey=${apiKey}`;
    const res = await axios.get(url, { timeout: 5000 });
    if (res.data?.status !== '1' || !res.data?.result?.length) return null;
    const creator = res.data.result[0].contractCreator?.toLowerCase() ?? null;
    if (creator) creatorCache.set(addr, { creator, ts: Date.now() });
    return creator;
  } catch { return null; }
}

export type LaunchpadName = 'clanker' | 'virtual' | 'custom' | null;

export interface LaunchpadResult {
  isLaunchpad:  boolean;
  launchpad:    LaunchpadName;
  creator:      string | null;
}

/**
 * Returns { isLaunchpad: true, launchpad: 'clanker'|'virtual' } if the token
 * was deployed by a known meme launchpad factory. Returns isLaunchpad=false if
 * creator is unknown or belongs to a random EOA.
 *
 * If BASESCAN_API_KEY is not set, returns isLaunchpad=false (neutral/unknown).
 */
export async function checkLaunchpadOrigin(tokenAddress: string): Promise<LaunchpadResult> {
  const creator = await getTokenCreator(tokenAddress);

  if (!creator) return { isLaunchpad: false, launchpad: null, creator: null };

  if (CLANKER_FACTORIES.has(creator))         return { isLaunchpad: true, launchpad: 'clanker',  creator };
  if (VIRTUAL_FACTORIES.has(creator))         return { isLaunchpad: true, launchpad: 'virtual',  creator };
  if (ALL_LAUNCHPAD_FACTORIES.has(creator))   return { isLaunchpad: true, launchpad: 'custom',   creator };

  return { isLaunchpad: false, launchpad: null, creator };
}
