"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getProvider = getProvider;
exports.getWallet = getWallet;
exports.getBaseStatus = getBaseStatus;
exports.withFallback = withFallback;
const ethers_1 = require("ethers");
const BASE_RPC_URL = process.env.BASE_RPC_URL || 'https://mainnet.base.org';
const BASE_BACKUP_RPC = process.env.BASE_BACKUP_RPC || 'https://base.drpc.org';
let _provider = null;
let _wallet = null;
function getProvider() {
    if (!_provider) {
        _provider = new ethers_1.ethers.JsonRpcProvider(BASE_RPC_URL, {
            chainId: 8453,
            name: 'base',
        });
    }
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
        };
    }
    catch (e) {
        return {
            connected: false,
            wallet_address: '',
            eth_balance: 0,
            network: 'base-mainnet',
            block: 0,
        };
    }
}
// Fallback provider on error
async function withFallback(fn) {
    try {
        return await fn(getProvider());
    }
    catch {
        const fallback = new ethers_1.ethers.JsonRpcProvider(BASE_BACKUP_RPC, { chainId: 8453, name: 'base' });
        return await fn(fallback);
    }
}
