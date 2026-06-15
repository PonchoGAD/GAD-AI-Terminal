import { ethers } from 'ethers';

// Public BSC Mainnet RPC endpoints — tried in order, fastest wins
// Set BSC_RPC_URL in .env to use NodeReal/QuickNode for best reliability
const RPC_ENDPOINTS = [
  process.env.BSC_RPC_URL    || 'https://bsc-dataseed1.binance.org',
  process.env.BSC_BACKUP_RPC || 'https://bsc-dataseed2.binance.org',
  'https://bsc-dataseed3.binance.org',
  'https://bsc.drpc.org',
];

const CHAIN = { chainId: 56, name: 'bnb' };

let _provider: ethers.JsonRpcProvider | null = null;
let _wallet:   ethers.Wallet | null = null;
let _rpcIndex  = 0;

function makeProvider(url: string): ethers.JsonRpcProvider {
  return new ethers.JsonRpcProvider(url, CHAIN, { staticNetwork: true });
}

export function getProvider(): ethers.JsonRpcProvider {
  if (!_provider) _provider = makeProvider(RPC_ENDPOINTS[_rpcIndex]);
  return _provider;
}

export function getWallet(): ethers.Wallet {
  if (!_wallet) {
    const pk = process.env.BSC_WALLET_PRIVATE_KEY;
    if (!pk) throw new Error('BSC_WALLET_PRIVATE_KEY not set');
    _wallet = new ethers.Wallet(pk, getProvider());
  }
  return _wallet;
}

function rotateRpc(): void {
  _rpcIndex = (_rpcIndex + 1) % RPC_ENDPOINTS.length;
  const url = RPC_ENDPOINTS[_rpcIndex];
  console.warn(`[bsc-rpc] Rotating to endpoint #${_rpcIndex}: ${url}`);
  _provider = makeProvider(url);
  if (_wallet) _wallet = new ethers.Wallet(_wallet.privateKey, _provider);
}

export async function withRetry<T>(fn: (p: ethers.JsonRpcProvider) => Promise<T>, attempts = 3): Promise<T> {
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn(getProvider());
    } catch (e: any) {
      const isNetworkErr = e.code === 'NETWORK_ERROR' || e.code === 'TIMEOUT' ||
                           e.message?.includes('timeout') || e.message?.includes('connection');
      if (isNetworkErr && i < attempts - 1) { rotateRpc(); continue; }
      throw e;
    }
  }
  throw new Error('All BSC RPC retry attempts exhausted');
}

export async function getBscStatus(): Promise<{
  connected: boolean;
  wallet_address: string;
  bnb_balance: number;
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
      bnb_balance:    Number(ethers.formatEther(balanceBig)),
      network:        'bsc-mainnet',
      block,
      rpc:            RPC_ENDPOINTS[_rpcIndex],
    };
  } catch (e: any) {
    return { connected: false, wallet_address: '', bnb_balance: 0, network: 'bsc-mainnet', block: 0, rpc: 'error' };
  }
}
