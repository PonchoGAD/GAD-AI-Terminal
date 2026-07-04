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

interface HoneypotIsResult {
  available:  boolean; // false = API timeout/error
  isHoneypot: boolean;
  sellTax:    number;  // percentage 0-100
  buyTax:     number;
}

// PRIMARY honeypot check — simulates actual buy+sell on-chain via honeypot.is
// More reliable than GoPlus for detecting sell-tax honeypots
async function checkHoneypotIs(address: string): Promise<HoneypotIsResult> {
  const safe: HoneypotIsResult = { available: false, isHoneypot: false, sellTax: 0, buyTax: 0 };
  try {
    const r = await axios.get(
      `https://api.honeypot.is/v2/IsHoneypot?address=${address}&chain=base`,
      { timeout: 7000 }
    );
    const d = r.data;
    return {
      available:  true,
      isHoneypot: d?.honeypotResult?.isHoneypot === true,
      sellTax:    Number(d?.simulationResult?.sellTax ?? 0),
      buyTax:     Number(d?.simulationResult?.buyTax  ?? 0),
    };
  } catch {
    return safe; // available=false → caller will penalize
  }
}

export async function checkTokenSafety(address: string): Promise<TokenSafetyResult> {
  const flags: string[] = [];
  let score = 100;

  // ── STEP 1: honeypot.is (PRIMARY, before anything else) ──────────────────
  // Simulates an actual buy+sell transaction on-chain — most reliable honeypot check.
  const hp = await checkHoneypotIs(address);
  if (hp.isHoneypot) {
    console.warn(`[base-safety] 🚨 ${address.slice(0,8)} HONEYPOT confirmed by honeypot.is`);
    return { is_verified: false, is_renounced: false, lp_locked: false, top10_pct: 0, safe_score: 0, flags: ['HONEYPOT_IS_CONFIRMED'] };
  }
  if (hp.sellTax > 5) {
    console.warn(`[base-safety] 🚨 ${address.slice(0,8)} SELL_TAX ${hp.sellTax.toFixed(0)}% detected by honeypot.is`);
    return { is_verified: false, is_renounced: false, lp_locked: false, top10_pct: 0, safe_score: 0, flags: [`HONEYPOT_IS_SELL_TAX_${Math.round(hp.sellTax)}PCT`] };
  }
  if (hp.buyTax > 10) {
    flags.push(`HONEYPOT_IS_BUY_TAX_${Math.round(hp.buyTax)}PCT`);
    score -= 25;
  }
  if (!hp.available) {
    // Fail-closed: if honeypot.is is down we can't confirm the token is sellable.
    // POKERBULL (04.07.2026): passed all guards but reverted on sell — honeypot.is was unavailable at buy time.
    console.warn(`[base-safety] ⛔ ${address.slice(0,8)} honeypot.is UNAVAILABLE — blocking buy (fail-closed)`);
    return { is_verified: false, is_renounced: false, lp_locked: false, top10_pct: 0, safe_score: 0, flags: ['HONEYPOT_IS_UNAVAILABLE_BLOCK'] };
  }

  // ── STEP 2: GoPlus + Token Sniffer in parallel ────────────────────────────
  // Run GoPlus + Token Sniffer in parallel (both non-blocking)
  const [goplus, tsResult] = await Promise.all([
    checkGoPlusHoneypot(address),
    checkTokenSniffer(address),
  ]);

  // Apply Token Sniffer score (only when key is set)
  if (tsResult.flags.length) {
    flags.push(...tsResult.flags);
    score = Math.min(score, tsResult.score);
  }

  // GoPlus secondary checks (ownership, mintable, blacklist, etc.)
  if (goplus._failed) {
    // GoPlus unavailable — penalize but don't block (honeypot.is already ran above)
    flags.push('GOPLUS_UNAVAILABLE');
    score -= 15;
  } else {
    if (goplus.is_honeypot)    { flags.push('HONEYPOT');         score -= 80; }
    if (goplus.buy_tax > 10)   { flags.push(`BUY_TAX_${Math.round(goplus.buy_tax)}PCT`);  score -= 30; }
    if (goplus.sell_tax > 10)  { flags.push(`SELL_TAX_${Math.round(goplus.sell_tax)}PCT`); score -= 40; }
    if (goplus.cannot_sell)    { flags.push('CANNOT_SELL');       score -= 80; }
    if (goplus.is_blacklisted) { flags.push('BLACKLIST_FUNC');    score -= 20; }
    if (goplus.is_mintable)    { flags.push('MINTABLE');          score -= 15; }
    if (goplus.hidden_owner)   { flags.push('HIDDEN_OWNER');      score -= 25; }
  }

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
  _failed?:      boolean; // true when GoPlus API was unreachable
}

// Token Sniffer API — activates when TOKEN_SNIFFER_API_KEY is set
// Get key: tokensniffer.com → API → Subscribe ($29/mo)
// Checks: rug similarity, honeypot, owner privileges, LP lock
export async function checkTokenSniffer(address: string): Promise<{ score: number; flags: string[] }> {
  const key = process.env.TOKEN_SNIFFER_API_KEY;
  if (!key) return { score: 100, flags: [] };
  try {
    const r = await axios.get(
      `https://tokensniffer.com/api/v2/tokens/8453/${address}?apikey=${key}&include_metrics=1`,
      { timeout: 8000 }
    );
    const d = r.data;
    const flags: string[] = [];
    let deduction = 0;
    if (d?.is_honeypot)             { flags.push('TS_HONEYPOT');     deduction += 80; }
    if (d?.has_high_buy_fee)        { flags.push('TS_HIGH_BUY_FEE'); deduction += 30; }
    if (d?.has_high_sell_fee)       { flags.push('TS_HIGH_SELL_FEE');deduction += 40; }
    if (d?.has_blacklist)           { flags.push('TS_BLACKLIST');     deduction += 20; }
    if (d?.similar_token?.score > 0.8) { flags.push('TS_COPY_TOKEN');deduction += 25; }
    if (d?.lp_locked === false)     { flags.push('TS_LP_UNLOCKED');  deduction += 15; }
    if (flags.length) console.debug(`[base-safety] TokenSniffer ${address.slice(0,8)}: ${flags.join(', ')}`);
    return { score: Math.max(0, 100 - deduction), flags };
  } catch { return { score: 100, flags: [] }; }
}

// GoPlus Security API — free, no API key, covers Base (chain_id=8453)
// IMPORTANT: catch returns a "failed" marker so callers can penalize instead of silently passing
async function checkGoPlusHoneypot(address: string): Promise<GoPlusResult> {
  const failed: GoPlusResult  = { is_honeypot: false, buy_tax: 0, sell_tax: 0, cannot_sell: false, is_blacklisted: false, is_mintable: false, hidden_owner: false, _failed: true };
  const empty: GoPlusResult   = { is_honeypot: false, buy_tax: 0, sell_tax: 0, cannot_sell: false, is_blacklisted: false, is_mintable: false, hidden_owner: false, _failed: false };
  try {
    const r = await axios.get(
      `https://api.gopluslabs.io/api/v1/token_security/8453?contract_addresses=${address}`,
      { timeout: 6000 }
    );
    const result = r.data?.result?.[address.toLowerCase()];
    if (!result) return empty; // no data but API responded — treat as unknown
    return {
      _failed:        false,
      is_honeypot:    result.is_honeypot === '1',
      buy_tax:        Number(result.buy_tax ?? 0) * 100,
      sell_tax:       Number(result.sell_tax ?? 0) * 100,
      cannot_sell:    result.cannot_sell_all === '1' || Number(result.sell_tax ?? 0) >= 1,
      is_blacklisted: result.is_blacklisted === '1',
      is_mintable:    result.is_mintable === '1',
      hidden_owner:   result.hidden_owner === '1',
    };
  } catch {
    return failed; // GoPlus unavailable — flagged so caller can penalize
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
  const MORALIS_API_KEY = process.env.MORALIS_API_KEY ?? '';
  // Prefer Moralis (no Basescan key needed) — free tier covers this
  if (MORALIS_API_KEY) {
    try {
      const r = await axios.get(
        `https://deep-index.moralis.io/api/v2.2/erc20/${address}/top-holders?chain=base&limit=10`,
        { headers: { 'X-API-Key': MORALIS_API_KEY }, timeout: 6000 }
      );
      const holders: any[] = r.data?.result ?? [];
      if (!holders.length) return 0;
      const total = holders.reduce((s: number, h: any) => s + Number(h.percentage_relative_to_total_supply ?? 0), 0);
      return total; // Moralis already gives % of total supply
    } catch { /* fallthrough to Basescan */ }
  }
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
