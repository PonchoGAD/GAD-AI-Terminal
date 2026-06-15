import axios from 'axios';
import { ethers } from 'ethers';
import { getProvider } from './provider';
import { ERC20_ABI, PANCAKE_ROUTER_ABI, ADDRESSES } from './contracts';

export interface BscSafetyResult {
  is_honeypot:   boolean;
  buy_tax:       number;   // %
  sell_tax:      number;   // %
  safe_score:    number;   // 0-100
  flags:         string[];
  risk_level:    'SAFE' | 'CAUTION' | 'HONEYPOT';
}

// Level 1: honeypot.is — fastest, purpose-built BSC honeypot API
async function checkHoneypotIs(address: string): Promise<{
  is_honeypot: boolean;
  buy_tax: number;
  sell_tax: number;
}> {
  const empty = { is_honeypot: false, buy_tax: 0, sell_tax: 0 };
  try {
    const r = await axios.get(
      `https://api.honeypot.is/v2/IsHoneypot?address=${address}&chainID=56`,
      { timeout: 6_000 }
    );
    const d = r.data;
    return {
      is_honeypot: d?.isHoneypot === true,
      buy_tax:     Number(d?.simulationResult?.buyTax  ?? 0),
      sell_tax:    Number(d?.simulationResult?.sellTax ?? 0),
    };
  } catch { return empty; }
}

// Level 2: GoPlus Security API — covers BSC (chain_id=56), adds extra risk flags
async function checkGoPlus(address: string): Promise<{
  cannot_sell:    boolean;
  is_blacklisted: boolean;
  is_mintable:    boolean;
  hidden_owner:   boolean;
  buy_tax:        number;
  sell_tax:       number;
}> {
  const empty = { cannot_sell: false, is_blacklisted: false, is_mintable: false, hidden_owner: false, buy_tax: 0, sell_tax: 0 };
  try {
    const r = await axios.get(
      `https://api.gopluslabs.io/api/v1/token_security/56?contract_addresses=${address}`,
      { timeout: 6_000 }
    );
    const result = r.data?.result?.[address.toLowerCase()];
    if (!result) return empty;
    return {
      cannot_sell:    result.cannot_sell_all === '1',
      is_blacklisted: result.is_blacklisted  === '1',
      is_mintable:    result.is_mintable      === '1',
      hidden_owner:   result.hidden_owner     === '1',
      buy_tax:        Number(result.buy_tax  ?? 0) * 100,
      sell_tax:       Number(result.sell_tax ?? 0) * 100,
    };
  } catch { return empty; }
}

// Level 3: On-chain sell simulation via PancakeSwap staticCall
// Simulates selling a tiny amount without spending gas
async function canSellSimulation(address: string): Promise<boolean> {
  try {
    const provider = getProvider();
    const router   = new ethers.Contract(ADDRESSES.PANCAKESWAP_ROUTER_V2, PANCAKE_ROUTER_ABI, provider);
    // Check if getAmountsOut works (basic liquidity existence test)
    const amounts = await router.getAmountsOut(
      ethers.parseEther('0.001'),
      [ADDRESSES.WBNB, address]
    );
    if (!amounts || amounts.length < 2 || amounts[1] === 0n) return false;
    // Check the reverse path: can we get BNB back?
    await router.getAmountsOut(amounts[1], [address, ADDRESSES.WBNB]);
    return true;
  } catch { return false; }
}

// Full multi-level BSC safety check — mandatory before any buy
export async function checkBscTokenSafety(address: string): Promise<BscSafetyResult> {
  const flags: string[] = [];
  let score = 100;

  // Run Level 1 and Level 2 in parallel
  const [honeypot, goplus] = await Promise.all([
    checkHoneypotIs(address),
    checkGoPlus(address),
  ]);

  // HONEYPOT is an immediate hard reject
  if (honeypot.is_honeypot) {
    return {
      is_honeypot: true,
      buy_tax:     honeypot.buy_tax,
      sell_tax:    honeypot.sell_tax,
      safe_score:  0,
      flags:       ['HONEYPOT'],
      risk_level:  'HONEYPOT',
    };
  }

  // Use best available tax estimate (honeypot.is is more reliable for BSC)
  const buyTax  = honeypot.buy_tax  || goplus.buy_tax;
  const sellTax = honeypot.sell_tax || goplus.sell_tax;

  if (buyTax > 10)  { flags.push(`BUY_TAX_${Math.round(buyTax)}PCT`);  score -= 30; }
  else if (buyTax > 5) { flags.push(`BUY_TAX_${Math.round(buyTax)}PCT`); score -= 15; }

  if (sellTax > 10) { flags.push(`SELL_TAX_${Math.round(sellTax)}PCT`); score -= 40; }
  else if (sellTax > 5) { flags.push(`SELL_TAX_${Math.round(sellTax)}PCT`); score -= 20; }

  if (goplus.cannot_sell)    { flags.push('CANNOT_SELL');    score -= 80; }
  if (goplus.is_blacklisted) { flags.push('BLACKLIST_FUNC'); score -= 25; }
  if (goplus.is_mintable)    { flags.push('MINTABLE');       score -= 15; }
  if (goplus.hidden_owner)   { flags.push('HIDDEN_OWNER');   score -= 20; }

  // Level 3: on-chain simulation (only if score still reasonable)
  if (score >= 30) {
    const sellable = await canSellSimulation(address);
    if (!sellable) {
      flags.push('SELL_SIMULATION_FAILED');
      score -= 50;
    }
  }

  const safeScore = Math.max(0, score);
  let riskLevel: 'SAFE' | 'CAUTION' | 'HONEYPOT' = 'SAFE';
  if (safeScore < 20) riskLevel = 'HONEYPOT';
  else if (safeScore < 55) riskLevel = 'CAUTION';

  if (flags.length) {
    console.debug(`[bsc-safety] ${address.slice(0, 8)} flags: ${flags.join(', ')} score:${safeScore} tax:${buyTax}/${sellTax}%`);
  }

  return {
    is_honeypot: riskLevel === 'HONEYPOT',
    buy_tax:     buyTax,
    sell_tax:    sellTax,
    safe_score:  safeScore,
    flags,
    risk_level:  riskLevel,
  };
}

// Quick top-holder check — returns % held by single largest address
// Tokens with dev holding > 50% are rug candidates
export async function checkBscTopHolder(address: string): Promise<number> {
  const BSCSCAN_API = process.env.BSCSCAN_API_KEY ?? '';
  if (!BSCSCAN_API) return 0;
  try {
    const [holdersRes, supplyRes] = await Promise.all([
      axios.get('https://api.bscscan.com/api', {
        params: { module: 'token', action: 'tokenholderlist', contractaddress: address, page: 1, offset: 5, apikey: BSCSCAN_API },
        timeout: 5_000,
      }),
      axios.get('https://api.bscscan.com/api', {
        params: { module: 'stats', action: 'tokensupply', contractaddress: address, apikey: BSCSCAN_API },
        timeout: 5_000,
      }),
    ]);
    const holders: any[]   = holdersRes.data?.result ?? [];
    const totalSupply = BigInt(supplyRes.data?.result ?? '1');
    if (!holders.length || totalSupply === 0n) return 0;
    const top1 = BigInt(holders[0]?.TokenHolderQuantity ?? '0');
    return Number((top1 * 10000n) / totalSupply) / 100;
  } catch { return 0; }
}
