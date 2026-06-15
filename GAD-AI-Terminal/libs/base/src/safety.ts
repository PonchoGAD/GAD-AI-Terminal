import axios from 'axios';
import { ethers } from 'ethers';
import { getProvider } from './provider';
import { ERC20_ABI } from './contracts';

const BASESCAN_API = process.env.BASESCAN_API_KEY || '';
const BASESCAN_URL = 'https://api.basescan.org/api';

export interface TokenSafetyResult {
  is_verified:      boolean;
  is_renounced:     boolean;
  lp_locked:        boolean;
  top10_pct:        number;  // top 10 holders % of supply
  safe_score:       number;  // 0-100
  flags:            string[];
}

export async function checkTokenSafety(address: string): Promise<TokenSafetyResult> {
  const flags: string[] = [];
  let score = 100;

  // GoPlus honeypot check runs first — fastest way to kill bad tokens
  const goplus = await checkGoPlusHoneypot(address);
  if (goplus.is_honeypot)        { flags.push('HONEYPOT');         score -= 80; }
  if (goplus.buy_tax > 10)       { flags.push(`BUY_TAX_${Math.round(goplus.buy_tax)}PCT`);  score -= 30; }
  if (goplus.sell_tax > 10)      { flags.push(`SELL_TAX_${Math.round(goplus.sell_tax)}PCT`); score -= 40; }
  if (goplus.cannot_sell)        { flags.push('CANNOT_SELL');       score -= 80; }
  if (goplus.is_blacklisted)     { flags.push('BLACKLIST_FUNC');    score -= 20; }
  if (goplus.is_mintable)        { flags.push('MINTABLE');          score -= 15; }
  if (goplus.hidden_owner)       { flags.push('HIDDEN_OWNER');      score -= 25; }

  const [verified, renounced] = await Promise.all([
    checkVerified(address),
    checkOwnershipRenounced(address),
  ]);

  if (!verified)  { flags.push('NOT_VERIFIED');  score -= 15; }
  if (!renounced) { flags.push('OWNER_ACTIVE');  score -= 15; }

  // Check top holders via Basescan token holder API
  const top10pct = await getTop10HoldersPct(address);
  if (top10pct > 50) { flags.push(`TOP10_${Math.round(top10pct)}PCT`); score -= 20; }
  else if (top10pct > 30) { score -= 10; }

  if (flags.length) {
    console.debug(`[base-safety] ${address.slice(0, 8)} flags: ${flags.join(', ')} score:${Math.max(0, score)}`);
  }

  return {
    is_verified:  verified,
    is_renounced: renounced,
    lp_locked:    false,
    top10_pct:    top10pct,
    safe_score:   Math.max(0, score),
    flags,
  };
}

interface GoPlusResult {
  is_honeypot:   boolean;
  buy_tax:       number;
  sell_tax:      number;
  cannot_sell:   boolean;
  is_blacklisted:boolean;
  is_mintable:   boolean;
  hidden_owner:  boolean;
}

// GoPlus Security API — free, no API key, covers Base (chain_id=8453)
async function checkGoPlusHoneypot(address: string): Promise<GoPlusResult> {
  const empty: GoPlusResult = { is_honeypot: false, buy_tax: 0, sell_tax: 0, cannot_sell: false, is_blacklisted: false, is_mintable: false, hidden_owner: false };
  try {
    const r = await axios.get(
      `https://api.gopluslabs.io/api/v1/token_security/8453?contract_addresses=${address}`,
      { timeout: 6000 }
    );
    const result = r.data?.result?.[address.toLowerCase()];
    if (!result) return empty;
    return {
      is_honeypot:    result.is_honeypot === '1',
      buy_tax:        Number(result.buy_tax ?? 0) * 100,
      sell_tax:       Number(result.sell_tax ?? 0) * 100,
      cannot_sell:    result.cannot_sell_all === '1' || result.sell_tax === '1',
      is_blacklisted: result.is_blacklisted === '1',
      is_mintable:    result.is_mintable === '1',
      hidden_owner:   result.hidden_owner === '1',
    };
  } catch {
    return empty; // GoPlus unavailable → continue without it
  }
}

async function checkVerified(address: string): Promise<boolean> {
  if (!BASESCAN_API) return false;
  try {
    const r = await axios.get(BASESCAN_URL, {
      params: { module: 'contract', action: 'getsourcecode', address, apikey: BASESCAN_API },
      timeout: 5000,
    });
    return r.data?.result?.[0]?.SourceCode?.length > 0;
  } catch { return false; }
}

async function checkOwnershipRenounced(address: string): Promise<boolean> {
  try {
    const provider = getProvider();
    const contract = new ethers.Contract(address, [
      'function owner() view returns (address)',
      'function getOwner() view returns (address)',
    ], provider);
    try {
      const owner = await contract.owner();
      return owner === ethers.ZeroAddress;
    } catch {
      const owner = await contract.getOwner();
      return owner === ethers.ZeroAddress;
    }
  } catch { return true; } // No owner() function = probably renounced or non-ownable
}

async function getTop10HoldersPct(address: string): Promise<number> {
  if (!BASESCAN_API) return 0;
  try {
    const [holdersRes, tokenRes] = await Promise.all([
      axios.get(BASESCAN_URL, {
        params: { module: 'token', action: 'tokenholderlist', contractaddress: address, page: 1, offset: 10, apikey: BASESCAN_API },
        timeout: 5000,
      }),
      axios.get(BASESCAN_URL, {
        params: { module: 'stats', action: 'tokensupply', contractaddress: address, apikey: BASESCAN_API },
        timeout: 5000,
      }),
    ]);
    const holders: any[] = holdersRes.data?.result ?? [];
    const totalSupply = BigInt(tokenRes.data?.result ?? '1');
    if (!holders.length || totalSupply === 0n) return 0;
    const top10 = holders.reduce((sum: bigint, h: any) => sum + BigInt(h.TokenHolderQuantity || '0'), 0n);
    return Number((top10 * 10000n) / totalSupply) / 100;
  } catch { return 0; }
}
