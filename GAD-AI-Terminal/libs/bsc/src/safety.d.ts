export interface BscSafetyResult {
    is_honeypot: boolean;
    buy_tax: number;
    sell_tax: number;
    safe_score: number;
    flags: string[];
    risk_level: 'SAFE' | 'CAUTION' | 'HONEYPOT';
}
export declare function checkBscTokenSafety(address: string): Promise<BscSafetyResult>;
export declare function checkBscTopHolder(address: string): Promise<number>;
