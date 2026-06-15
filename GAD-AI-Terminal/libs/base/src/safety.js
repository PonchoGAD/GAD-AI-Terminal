"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkTokenSafety = checkTokenSafety;
exports.checkTokenSniffer = checkTokenSniffer;
const axios_1 = __importDefault(require("axios"));
const ethers_1 = require("ethers");
const provider_1 = require("./provider");
const BASESCAN_API = process.env.BASESCAN_API_KEY || '';
const BASESCAN_URL = 'https://api.basescan.org/api';
async function checkTokenSafety(address) {
    const flags = [];
    let score = 100;
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
    // GoPlus honeypot check runs first — fastest way to kill bad tokens
    if (goplus.is_honeypot) {
        flags.push('HONEYPOT');
        score -= 80;
    }
    if (goplus.buy_tax > 10) {
        flags.push(`BUY_TAX_${Math.round(goplus.buy_tax)}PCT`);
        score -= 30;
    }
    if (goplus.sell_tax > 10) {
        flags.push(`SELL_TAX_${Math.round(goplus.sell_tax)}PCT`);
        score -= 40;
    }
    if (goplus.cannot_sell) {
        flags.push('CANNOT_SELL');
        score -= 80;
    }
    if (goplus.is_blacklisted) {
        flags.push('BLACKLIST_FUNC');
        score -= 20;
    }
    if (goplus.is_mintable) {
        flags.push('MINTABLE');
        score -= 15;
    }
    if (goplus.hidden_owner) {
        flags.push('HIDDEN_OWNER');
        score -= 25;
    }
    const [verified, renounced] = await Promise.all([
        checkVerified(address),
        checkOwnershipRenounced(address),
    ]);
    if (!verified) {
        flags.push('NOT_VERIFIED');
        score -= 15;
    }
    if (!renounced) {
        flags.push('OWNER_ACTIVE');
        score -= 15;
    }
    // Check top holders via Basescan token holder API
    const top10pct = await getTop10HoldersPct(address);
    if (top10pct > 50) {
        flags.push(`TOP10_${Math.round(top10pct)}PCT`);
        score -= 20;
    }
    else if (top10pct > 30) {
        score -= 10;
    }
    if (flags.length) {
        console.debug(`[base-safety] ${address.slice(0, 8)} flags: ${flags.join(', ')} score:${Math.max(0, score)}`);
    }
    return {
        is_verified: verified,
        is_renounced: renounced,
        lp_locked: false,
        top10_pct: top10pct,
        safe_score: Math.max(0, score),
        flags,
    };
}
// Token Sniffer API — activates when TOKEN_SNIFFER_API_KEY is set
// Get key: tokensniffer.com → API → Subscribe ($29/mo)
// Checks: rug similarity, honeypot, owner privileges, LP lock
async function checkTokenSniffer(address) {
    const key = process.env.TOKEN_SNIFFER_API_KEY;
    if (!key)
        return { score: 100, flags: [] };
    try {
        const r = await axios_1.default.get(`https://tokensniffer.com/api/v2/tokens/8453/${address}?apikey=${key}&include_metrics=1`, { timeout: 8000 });
        const d = r.data;
        const flags = [];
        let deduction = 0;
        if (d?.is_honeypot) {
            flags.push('TS_HONEYPOT');
            deduction += 80;
        }
        if (d?.has_high_buy_fee) {
            flags.push('TS_HIGH_BUY_FEE');
            deduction += 30;
        }
        if (d?.has_high_sell_fee) {
            flags.push('TS_HIGH_SELL_FEE');
            deduction += 40;
        }
        if (d?.has_blacklist) {
            flags.push('TS_BLACKLIST');
            deduction += 20;
        }
        if (d?.similar_token?.score > 0.8) {
            flags.push('TS_COPY_TOKEN');
            deduction += 25;
        }
        if (d?.lp_locked === false) {
            flags.push('TS_LP_UNLOCKED');
            deduction += 15;
        }
        if (flags.length)
            console.debug(`[base-safety] TokenSniffer ${address.slice(0, 8)}: ${flags.join(', ')}`);
        return { score: Math.max(0, 100 - deduction), flags };
    }
    catch {
        return { score: 100, flags: [] };
    }
}
// GoPlus Security API — free, no API key, covers Base (chain_id=8453)
async function checkGoPlusHoneypot(address) {
    const empty = { is_honeypot: false, buy_tax: 0, sell_tax: 0, cannot_sell: false, is_blacklisted: false, is_mintable: false, hidden_owner: false };
    try {
        const r = await axios_1.default.get(`https://api.gopluslabs.io/api/v1/token_security/8453?contract_addresses=${address}`, { timeout: 6000 });
        const result = r.data?.result?.[address.toLowerCase()];
        if (!result)
            return empty;
        return {
            is_honeypot: result.is_honeypot === '1',
            buy_tax: Number(result.buy_tax ?? 0) * 100,
            sell_tax: Number(result.sell_tax ?? 0) * 100,
            cannot_sell: result.cannot_sell_all === '1' || result.sell_tax === '1',
            is_blacklisted: result.is_blacklisted === '1',
            is_mintable: result.is_mintable === '1',
            hidden_owner: result.hidden_owner === '1',
        };
    }
    catch {
        return empty; // GoPlus unavailable → continue without it
    }
}
async function checkVerified(address) {
    if (!BASESCAN_API)
        return false;
    try {
        const r = await axios_1.default.get(BASESCAN_URL, {
            params: { module: 'contract', action: 'getsourcecode', address, apikey: BASESCAN_API },
            timeout: 5000,
        });
        return r.data?.result?.[0]?.SourceCode?.length > 0;
    }
    catch {
        return false;
    }
}
async function checkOwnershipRenounced(address) {
    try {
        const provider = (0, provider_1.getProvider)();
        const contract = new ethers_1.ethers.Contract(address, [
            'function owner() view returns (address)',
            'function getOwner() view returns (address)',
        ], provider);
        try {
            const owner = await contract.owner();
            return owner === ethers_1.ethers.ZeroAddress;
        }
        catch {
            const owner = await contract.getOwner();
            return owner === ethers_1.ethers.ZeroAddress;
        }
    }
    catch {
        return true;
    } // No owner() function = probably renounced or non-ownable
}
async function getTop10HoldersPct(address) {
    const MORALIS_API_KEY = process.env.MORALIS_API_KEY ?? '';
    // Prefer Moralis (no Basescan key needed) — free tier covers this
    if (MORALIS_API_KEY) {
        try {
            const r = await axios_1.default.get(`https://deep-index.moralis.io/api/v2.2/erc20/${address}/top-holders?chain=base&limit=10`, { headers: { 'X-API-Key': MORALIS_API_KEY }, timeout: 6000 });
            const holders = r.data?.result ?? [];
            if (!holders.length)
                return 0;
            const total = holders.reduce((s, h) => s + Number(h.percentage_relative_to_total_supply ?? 0), 0);
            return total; // Moralis already gives % of total supply
        }
        catch { /* fallthrough to Basescan */ }
    }
    if (!BASESCAN_API)
        return 0;
    try {
        const [holdersRes, tokenRes] = await Promise.all([
            axios_1.default.get(BASESCAN_URL, {
                params: { module: 'token', action: 'tokenholderlist', contractaddress: address, page: 1, offset: 10, apikey: BASESCAN_API },
                timeout: 5000,
            }),
            axios_1.default.get(BASESCAN_URL, {
                params: { module: 'stats', action: 'tokensupply', contractaddress: address, apikey: BASESCAN_API },
                timeout: 5000,
            }),
        ]);
        const holders = holdersRes.data?.result ?? [];
        const totalSupply = BigInt(tokenRes.data?.result ?? '1');
        if (!holders.length || totalSupply === 0n)
            return 0;
        const top10 = holders.reduce((sum, h) => sum + BigInt(h.TokenHolderQuantity || '0'), 0n);
        return Number((top10 * 10000n) / totalSupply) / 100;
    }
    catch {
        return 0;
    }
}
