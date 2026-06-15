"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getProvider = getProvider;
exports.getWallet = getWallet;
exports.withRetry = withRetry;
exports.getBscStatus = getBscStatus;
const ethers_1 = require("ethers");
// Public BSC Mainnet RPC endpoints — tried in order, fastest wins
// Set BSC_RPC_URL in .env to use NodeReal/QuickNode for best reliability
const RPC_ENDPOINTS = [
    process.env.BSC_RPC_URL || 'https://bsc-dataseed1.binance.org',
    process.env.BSC_BACKUP_RPC || 'https://bsc-dataseed2.binance.org',
    'https://bsc-dataseed3.binance.org',
    'https://bsc.drpc.org',
];
const CHAIN = { chainId: 56, name: 'bnb' };
let _provider = null;
let _wallet = null;
let _rpcIndex = 0;
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
        const pk = process.env.BSC_WALLET_PRIVATE_KEY;
        if (!pk)
            throw new Error('BSC_WALLET_PRIVATE_KEY not set');
        _wallet = new ethers_1.ethers.Wallet(pk, getProvider());
    }
    return _wallet;
}
function rotateRpc() {
    _rpcIndex = (_rpcIndex + 1) % RPC_ENDPOINTS.length;
    const url = RPC_ENDPOINTS[_rpcIndex];
    console.warn(`[bsc-rpc] Rotating to endpoint #${_rpcIndex}: ${url}`);
    _provider = makeProvider(url);
    if (_wallet)
        _wallet = new ethers_1.ethers.Wallet(_wallet.privateKey, _provider);
}
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
    throw new Error('All BSC RPC retry attempts exhausted');
}
async function getBscStatus() {
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
            bnb_balance: Number(ethers_1.ethers.formatEther(balanceBig)),
            network: 'bsc-mainnet',
            block,
            rpc: RPC_ENDPOINTS[_rpcIndex],
        };
    }
    catch (e) {
        return { connected: false, wallet_address: '', bnb_balance: 0, network: 'bsc-mainnet', block: 0, rpc: 'error' };
    }
}
