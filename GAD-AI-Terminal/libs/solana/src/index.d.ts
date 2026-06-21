import { Connection } from '@solana/web3.js';
export declare const getConnection: () => Connection;
export declare function getTokenMetadata(mintAddress: string): Promise<{
    mintAddress: string;
    accountInfo: Buffer<ArrayBufferLike> | import("@solana/web3.js").ParsedAccountData | null;
}>;
export declare function queryHelius(path: string, body: any): Promise<any>;
export declare function fetchRecentTokenTransfers(limit?: number): Promise<any>;
export declare function fetchRecentTransactions(address: string, limit?: number): Promise<import("@solana/web3.js").ConfirmedSignatureInfo[]>;
