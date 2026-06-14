import { ethers } from 'ethers';

const BASE_RPC_URL    = process.env.BASE_RPC_URL    || 'https://mainnet.base.org';
const BASE_BACKUP_RPC = process.env.BASE_BACKUP_RPC || 'https://base.drpc.org';

let _provider: ethers.JsonRpcProvider | null = null;
let _wallet:   ethers.Wallet | null = null;

export function getProvider(): ethers.JsonRpcProvider {
  if (!_provider) {
    _provider = new ethers.JsonRpcProvider(BASE_RPC_URL, {
      chainId: 8453,
      name: 'base',
    });
  }
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

export async function getBaseStatus(): Promise<{
  connected: boolean;
  wallet_address: string;
  eth_balance: number;
  network: string;
  block: number;
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
    };
  } catch (e: any) {
    return {
      connected:      false,
      wallet_address: '',
      eth_balance:    0,
      network:        'base-mainnet',
      block:          0,
    };
  }
}

// Fallback provider on error
export async function withFallback<T>(fn: (p: ethers.JsonRpcProvider) => Promise<T>): Promise<T> {
  try {
    return await fn(getProvider());
  } catch {
    const fallback = new ethers.JsonRpcProvider(BASE_BACKUP_RPC, { chainId: 8453, name: 'base' });
    return await fn(fallback);
  }
}
