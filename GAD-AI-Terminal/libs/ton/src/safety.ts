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
}

// Uses tonapi.io (free, no API key needed for basic reads)
export async function checkJettonSafety(address: string): Promise<JettonSafety> {
  const defaults: JettonSafety = {
    safe_score: 50, mintable: false, admin_renounced: false,
    holders: 0, total_supply: '0', decimals: 9,
    name: '', symbol: '', image_url: '', flags: [],
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

    const flags: string[] = [];
    let score = 100;

    if (mintable && !admin_renounced) { flags.push('MINTABLE'); score -= 40; }
    if (!admin_renounced)             { flags.push('ADMIN_NOT_RENOUNCED'); score -= 20; }
    if (holders < 30)                 { flags.push('FEW_HOLDERS'); score -= 15; }
    if (holders < 10)                 { flags.push('VERY_FEW_HOLDERS'); score -= 25; }

    const meta = d.metadata ?? {};
    const name     = meta.name    ?? d.name    ?? '';
    const symbol   = meta.symbol  ?? d.symbol  ?? '';
    const image    = meta.image   ?? '';

    return {
      safe_score:      Math.max(0, score),
      mintable,
      admin_renounced,
      holders,
      total_supply:    d.total_supply  ?? '0',
      decimals:        d.decimals      ?? 9,
      name,
      symbol,
      image_url:       image,
      flags,
    };
  } catch {
    return defaults;
  }
}
