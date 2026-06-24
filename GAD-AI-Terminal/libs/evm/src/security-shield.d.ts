export interface SecurityResult {
    isSafe: boolean;
    reason?: string;
}
export declare function isTokenSafeToTrade(tokenAddress: string, chainId?: number, ageSec?: number): Promise<SecurityResult>;
