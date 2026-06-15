"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getProvider = getProvider;
exports.getWallet = getWallet;
exports.withRetry = withRetry;
exports.getBaseStatus = getBaseStatus;
exports.withFallback = withFallback;
const ethers_1 = require("ethers");
// Public Base RPC endpoints — tried in order, fastest wins
// Set BASE_RPC_URL in .env to use Alchemy/QuickNode for best reliability
const RPC_ENDPOINTS = [
    process.env.BASE_RPC_URL || 'https://mainnet.base.org', // Coinbase official (or Alchemy if set)
    process.env.BASE_BACKUP_RPC || 'https://base.drpc.org', // dRPC (free, no key)
    'https://base-rpc.publicnode.com', // PublicNode (free, no key)
    'https://1rpc.io/base', // 1RPC (free, no key)
];
const CHAIN = { chainId: 8453, name: 'base' };
let _provider = null;
let _wallet = null;
let _rpcIndex = 0; // current active RPC index
function makeProvider(url) {
    return new ethers_1.ethers.JsonRpcProvider(url, CHAIN, { staticNetwork: true });
}
function getProvider() {
    if (!_provider)
        _provider = makeProvider(RPC_ENDPOINTS[_rpcIndex]);
    return _provider;
}
function getWallet() {
    if (!_wallet) {
        const pk = process.env.BASE_WALLET_PRIVATE_KEY;
        if (!pk)
            throw new Error('BASE_WALLET_PRIVATE_KEY not set');
        _wallet = new ethers_1.ethers.Wallet(pk, getProvider());
    }
    return _wallet;
}
// Rotate to next RPC on failure — called internally when a provider times out
function rotateRpc() {
    _rpcIndex = (_rpcIndex + 1) % RPC_ENDPOINTS.length;
    const url = RPC_ENDPOINTS[_rpcIndex];
    console.warn(`[base-rpc] Rotating to endpoint #${_rpcIndex}: ${url.replace(/\/v2\/.*/, '/v2/***')}`);
    _provider = makeProvider(url);
    if (_wallet)
        _wallet = new ethers_1.ethers.Wallet(_wallet.privateKey, _provider);
}
// withRetry: retry with RPC rotation on network errors, up to 3 attempts
async function withRetry(fn, attempts = 3) {
    for (let i = 0; i < attempts; i++) {
        try {
            return await fn(getProvider());
        }
        catch (e) {
            const isNetworkErr = e.code === 'NETWORK_ERROR' || e.code === 'TIMEOUT' ||
                e.message?.includes('timeout') || e.message?.includes('connection');
            if (isNetworkErr && i < attempts - 1) {
                rotateRpc();
                continue;
            }
            throw e;
        }
    }
    throw new Error('All retry attempts exhausted');
}
async function getBaseStatus() {
    try {
        const provider = getProvider();
        const wallet = getWallet();
        const [block, balanceBig] = await Promise.all([
            provider.getBlockNumber(),
            provider.getBalance(wallet.address),
        ]);
        return {
            connected: true,
            wallet_address: wallet.address,
            eth_balance: Number(ethers_1.ethers.formatEther(balanceBig)),
            network: 'base-mainnet',
            block,
            rpc: RPC_ENDPOINTS[_rpcIndex].replace(/\/v2\/.*/, '/v2/***'),
        };
    }
    catch (e) {
        return { connected: false, wallet_address: '', eth_balance: 0, network: 'base-mainnet', block: 0, rpc: 'error' };
    }
}
// Legacy withFallback kept for compatibility
async function withFallback(fn) {
    return withRetry(fn, 3);
}
