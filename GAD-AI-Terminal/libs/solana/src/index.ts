import { Connection, clusterApiUrl, PublicKey } from '@solana/web3.js';
import fetch from 'node-fetch';

const rpcUrl = process.env.SOLANA_RPC || clusterApiUrl('mainnet-beta');
const heliusApiKey = process.env.HELIUS_API_KEY;
const connection = new Connection(rpcUrl, { commitment: 'confirmed' });

export const getConnection = () => connection;

export async function getTokenMetadata(mintAddress: string) {
  const mint = new PublicKey(mintAddress);
  const accountInfo = await connection.getParsedAccountInfo(mint);
  return {
    mintAddress,
    accountInfo: accountInfo.value?.data ?? null
  };
}

export async function queryHelius(path: string, body: any) {
  if (!heliusApiKey) {
    throw new Error('HELIUS_API_KEY is required');
  }

  const response = await fetch(`https://api.helius.xyz/v0/${path}?api-key=${heliusApiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    throw new Error(`Helius request failed ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

export async function fetchRecentTokenTransfers(limit = 100) {
  return queryHelius('token-metadata', { limit, page: 0 });
}

export async function fetchRecentTransactions(address: string, limit = 50) {
  return connection.getSignaturesForAddress(new PublicKey(address), { limit });
}
export * from './safety-guard';
