export interface TokenSafetyResult {
    is_verified: boolean;
    is_renounced: boolean;
    lp_locked: boolean;
    top10_pct: number;
    safe_score: number;
    flags: string[];
}
export declare function checkTokenSafety(address: string): Promise<TokenSafetyResult>;
export declare function checkTokenSniffer(address: string): Promise<{
    score: number;
    flags: string[];
}>;
