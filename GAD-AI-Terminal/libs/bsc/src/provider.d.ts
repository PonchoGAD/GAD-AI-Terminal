import { ethers } from 'ethers';
export declare function getProvider(): ethers.JsonRpcProvider;
export declare function getWallet(): ethers.Wallet;
export declare function withRetry<T>(fn: (p: ethers.JsonRpcProvider) => Promise<T>, attempts?: number): Promise<T>;
export declare function getBscStatus(): Promise<{
    connected: boolean;
    wallet_address: string;
    bnb_balance: number;
    network: string;
    block: number;
    rpc: string;
}>;
