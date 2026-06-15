import { ethers } from 'ethers';

// Public Base RPC endpoints — tried in order, fastest wins
// Set BASE_RPC_URL in .env to use Alchemy/QuickNode for best reliability
const RPC_ENDPOINTS = [
  process.env.BASE_RPC_URL    || 'https://mainnet.base.org',        // Coinbase official (or Alchemy if set)
  process.env.BASE_BACKUP_RPC || 'https://base.drpc.org',            // dRPC (free, no key)
  'https://base-rpc.publicnode.com',                                  // PublicNode (free, no key)
  'https://1rpc.io/base',                                             // 1RPC (free, no key)
];

const CHAIN = { chainId: 8453, name: 'base' };

let _provider: ethers.JsonRpcProvider | null = null;
let _wallet:   ethers.Wallet | null = null;
let _rpcIndex  = 0;  // current active RPC index

function makeProvider(url: string): ethers.JsonRpcProvider {
  return new ethers.JsonRpcProvider(url, CHAIN, { staticNetwork: true });
}

export function getProvider(): ethers.JsonRpcProvider {
  if (!_provider) _provider = makeProvider(RPC_ENDPOINTS[_rpcIndex]);
  return _provider;
}

export function getWallet(): ethers.Wallet {
  if (!_wallet) {
    const pk = process.env.BASE_WALLET_PRIVATE_KEY;
    if (!pk) throw new Error('BASE_WALLET_PRIVATE_KEY not set');
    _wallet = new ethers.Wallet(pk, getProvider());
  }
  return _wallet;
}

// Rotate to next RPC on failure — called internally when a provider times out
function rotateRpc(): void {
  _rpcIndex = (_rpcIndex + 1) % RPC_ENDPOINTS.length;
  const url = RPC_ENDPOINTS[_rpcIndex];
  console.warn(`[base-rpc] Rotating to endpoint #${_rpcIndex}: ${url.replace(/\/v2\/.*/, '/v2/***')}`);
  _provider = makeProvider(url);
  if (_wallet) _wallet = new ethers.Wallet(_wallet.privateKey, _provider);
}

// withRetry: retry with RPC rotation on network errors, up to 3 attempts
export async function withRetry<T>(fn: (p: ethers.JsonRpcProvider) => Promise<T>, attempts = 3): Promise<T> {
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn(getProvider());
    } catch (e: any) {
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

export async function getBaseStatus(): Promise<{
  connected: boolean;
  wallet_address: string;
  eth_balance: number;
  network: string;
  block: number;
  rpc: string;
}> {
  try {
    const provider = getProvider();
    const wallet   = getWallet();
    const [block, balanceBig] = await Promise.all([
      provider.getBlockNumber(),
      provider.getBalance(wallet.address),
    ]);
    return {
      connected:      true,
      wallet_address: wallet.address,
      eth_balance:    Number(ethers.formatEther(balanceBig)),
      network:        'base-mainnet',
      block,
      rpc:            RPC_ENDPOINTS[_rpcIndex].replace(/\/v2\/.*/, '/v2/***'),
    };
  } catch (e: any) {
    return { connected: false, wallet_address: '', eth_balance: 0, network: 'base-mainnet', block: 0, rpc: 'error' };
  }
}

// Legacy withFallback kept for compatibility
export async function withFallback<T>(fn: (p: ethers.JsonRpcProvider) => Promise<T>): Promise<T> {
  return withRetry(fn, 3);
}
