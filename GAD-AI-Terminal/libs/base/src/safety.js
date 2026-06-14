"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkTokenSafety = checkTokenSafety;
const axios_1 = __importDefault(require("axios"));
const ethers_1 = require("ethers");
const provider_1 = require("./provider");
const BASESCAN_API = process.env.BASESCAN_API_KEY || '';
const BASESCAN_URL = 'https://api.basescan.org/api';
async function checkTokenSafety(address) {
    const flags = [];
    let score = 100;
    const [verified, renounced] = await Promise.all([
        checkVerified(address),
        checkOwnershipRenounced(address),
    ]);
    if (!verified) {
        flags.push('NOT_VERIFIED');
        score -= 30;
    }
    if (!renounced) {
        flags.push('OWNER_ACTIVE');
        score -= 20;
    }
    // Check top holders via Basescan token holder API
    const top10pct = await getTop10HoldersPct(address);
    if (top10pct > 50) {
        flags.push(`TOP10_${Math.round(top10pct)}PCT`);
        score -= 25;
    }
    else if (top10pct > 30) {
        score -= 10;
    }
    // Basic honeypot-like checks: can we get a quote to sell?
    // (skipping full honeypot check here — would need on-chain simulation)
    return {
        is_verified: verified,
        is_renounced: renounced,
        lp_locked: false, // Unicrypt check requires their API — default false
        top10_pct: top10pct,
        safe_score: Math.max(0, score),
        flags,
    };
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
