import axios from 'axios';

export interface JettonSafety {
  safe_score:       number;   // 0-100
  mintable:         boolean;
  admin_renounced:  boolean;
  holders:          number;
  total_supply:     string;
  decimals:         number;
  name:             string;
  symbol:           string;
  image_url:        string;
  flags:            string[];
  isSafe:           boolean;  // false if blacklisted or verification='none'
}

// Uses tonapi.io (free, no API key needed for basic reads)
export async function checkJettonSafety(address: string): Promise<JettonSafety> {
  const defaults: JettonSafety = {
    safe_score: 50, mintable: false, admin_renounced: false,
    holders: 0, total_supply: '0', decimals: 9,
    name: '', symbol: '', image_url: '', flags: [], isSafe: true,
  };

  try {
    const r = await axios.get(
      `https://tonapi.io/v2/jettons/${encodeURIComponent(address)}`,
      { timeout: 6000, headers: { Accept: 'application/json' } }
    );
    const d = r.data;

    const mintable        = d.mintable ?? false;
    const adminAddress    = d.admin?.address ?? null;
    // Renounced = admin is null or the burn address (all zeros)
    const admin_renounced = !adminAddress || adminAddress === '0:0000000000000000000000000000000000000000000000000000000000000000';
    const holders         = d.holders_count ?? 0;
    const blacklisted     = d.blacklisted === true;
    const verification    = d.verification ?? 'none';

    const flags: string[] = [];
    let score = 100;

    // Hard disqualifiers — instant fail
    if (blacklisted)               { flags.push('BLACKLISTED'); score = 0; }
    if (verification === 'none')   { flags.push('UNVERIFIED'); score -= 30; }

    if (mintable && !admin_renounced) { flags.push('MINTABLE'); score -= 40; }
    if (!admin_renounced)             { flags.push('ADMIN_NOT_RENOUNCED'); score -= 20; }
    if (holders < 30)                 { flags.push('FEW_HOLDERS'); score -= 15; }
    if (holders < 10)                 { flags.push('VERY_FEW_HOLDERS'); score -= 25; }

    const meta = d.metadata ?? {};
    const name     = meta.name    ?? d.name    ?? '';
    const symbol   = meta.symbol  ?? d.symbol  ?? '';
    const image    = meta.image   ?? '';

    const safeScore = Math.max(0, score);

    if (blacklisted || safeScore < 30) {
      console.warn(`[ton-safety] ❌ ${symbol || address.slice(0,8)} unsafe: ${flags.join(', ')} score:${safeScore}`);
    }

    return {
      safe_score:      safeScore,
      mintable,
      admin_renounced,
      holders,
      total_supply:    d.total_supply  ?? '0',
      decimals:        d.decimals      ?? 9,
      name,
      symbol,
      image_url:       image,
      flags,
      isSafe:          !blacklisted && safeScore >= 30,
    };
  } catch {
    return defaults;
  }
}

// Convenience wrapper — returns isSafe bool + reason for scanner gate
export async function checkTonJettonSafety(address: string): Promise<{ isSafe: boolean; reason: string; score: number }> {
  const safety = await checkJettonSafety(address);
  if (!safety.isSafe) {
    return { isSafe: false, reason: safety.flags.join(', ') || 'score<30', score: safety.safe_score };
  }
  return { isSafe: true, reason: 'ok', score: safety.safe_score };
}
