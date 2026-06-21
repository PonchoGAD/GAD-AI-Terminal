import { Connection, Keypair } from '@solana/web3.js';
export interface BuyParams {
    mintAddress: string;
    amountSol: number;
    slippageBps?: number;
    priorityFeeMicroLamports?: number;
}
export interface BuyResult {
    success: boolean;
    txSignature?: string;
    inputAmountSol?: number;
    outputAmount?: string;
    outputAmountRaw?: bigint;
    entryPriceSol?: number;
    error?: string;
}
export interface SellParams {
    mintAddress: string;
    tokenAmount: bigint;
    slippageBps?: number;
    priorityFeeMicroLamports?: number;
}
export interface SellResult {
    success: boolean;
    txSignature?: string;
    tokensIn?: bigint;
    solReceived?: number;
    currentPriceSol?: number;
    error?: string;
}
export interface PriceResult {
    priceSol: number;
    rawQuote?: JupiterQuoteResponse;
}
export declare const SELL_STAGES: readonly [{
    readonly stage: 1;
    readonly multiplier: 1.05;
    readonly sellPct: 50;
}, {
    readonly stage: 2;
    readonly multiplier: 1.15;
    readonly sellPct: 50;
}, {
    readonly stage: 3;
    readonly multiplier: 3;
    readonly sellPct: 50;
}, {
    readonly stage: 4;
    readonly multiplier: 7;
    readonly sellPct: 50;
}, {
    readonly stage: 5;
    readonly multiplier: 15;
    readonly sellPct: 100;
}];
export declare function loadKeypairFromString(raw: string): Keypair;
export declare function getKeypairFromEnv(): Keypair | null;
export declare function getConnection(): Connection;
export interface JupiterQuoteResponse {
    inputMint: string;
    inAmount: string;
    outputMint: string;
    outAmount: string;
    otherAmountThreshold: string;
    swapMode: string;
    slippageBps: number;
    priceImpactPct: string;
    routePlan: unknown[];
}
export declare function getTokenPriceInSol(mintAddress: string, tokenAmount: bigint, slippageBps?: number): Promise<PriceResult>;
export declare function executeAutoBuy(params: BuyParams, connection: Connection, keypair: Keypair): Promise<BuyResult>;
export declare function executeAutoSell(params: SellParams, connection: Connection, keypair: Keypair): Promise<SellResult>;
