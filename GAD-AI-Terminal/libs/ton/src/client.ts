import { TonClient, WalletContractV4 } from '@ton/ton';
import { mnemonicToPrivateKey } from '@ton/crypto';
import { fromNano, Address } from '@ton/core';

const TON_RPC     = process.env.TON_RPC_URL        ?? 'https://toncenter.com/api/v2/jsonRPC';
const TON_API_KEY = process.env.TON_API_KEY         ?? '';
const MNEMONIC    = process.env.TON_WALLET_MNEMONIC ?? '';

let _client:  TonClient | null = null;
let _keyPair: Awaited<ReturnType<typeof mnemonicToPrivateKey>> | null = null;

export function getClient(): TonClient {
  if (!_client) {
    _client = new TonClient({
      endpoint: TON_RPC,
      apiKey:   TON_API_KEY || undefined,
    });
  }
  return _client;
}

export async function getKeyPair() {
  if (!_keyPair) {
    if (!MNEMONIC) throw new Error('TON_WALLET_MNEMONIC not set');
    _keyPair = await mnemonicToPrivateKey(MNEMONIC.trim().split(/\s+/));
  }
  return _keyPair;
}

export async function getWalletOpen() {
  const client  = getClient();
  const keyPair = await getKeyPair();
  const wallet  = WalletContractV4.create({ publicKey: keyPair.publicKey, workchain: 0 });
  return client.open(wallet);
}

export async function getTonBalance(): Promise<number> {
  const client = getClient();
  const wo     = await getWalletOpen();
  const bal    = await client.getBalance(wo.address);
  return Number(fromNano(bal));
}

export async function getWalletAddress(): Promise<string> {
  const wo = await getWalletOpen();
  return wo.address.toString({ bounceable: false });
}

// Get jetton wallet address for user wallet + jetton master
export async function getJettonWalletAddress(jettonMaster: string): Promise<Address | null> {
  try {
    const client = getClient();
    const wo     = await getWalletOpen();
    const { beginCell } = await import('@ton/core');
    const { stack } = await client.runMethod(
      Address.parse(jettonMaster),
      'get_wallet_address',
      [{ type: 'slice', cell: beginCell().storeAddress(wo.address).endCell() }]
    );
    return stack.readAddress();
  } catch {
    return null;
  }
}

// Get jetton balance (in nano units)
export async function getJettonBalance(jettonMaster: string): Promise<bigint> {
  try {
    const client          = getClient();
    const jettonWalletAddr = await getJettonWalletAddress(jettonMaster);
    if (!jettonWalletAddr) return 0n;
    const { stack } = await client.runMethod(jettonWalletAddr, 'get_wallet_data', []);
    return stack.readBigNumber();
  } catch {
    return 0n;
  }
}
