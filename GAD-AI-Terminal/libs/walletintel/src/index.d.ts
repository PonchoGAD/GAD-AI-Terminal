/**
 * WalletIntel — tracks "smart wallets" and provides copy-trade signals.
 * Scans recent Helius transactions for a token mint to see if known
 * smart wallets (win rate > 65%, 20+ trades) recently bought.
 */
export interface SmartWalletSignal {
    mint: string;
    smart_wallets_in: string[];
    confidence: number;
    copy_buy: boolean;
    reason: string;
}
export interface WalletStats {
    address: string;
    win_rate: number;
    avg_roi: number;
    trades: number;
    score: number;
}
export declare function getSmartWallets(db: {
    query: (sql: string, params?: any[]) => Promise<{
        rows: any[];
    }>;
}): Promise<WalletStats[]>;
export declare function checkSmartWalletActivity(mint: string, smartWallets: WalletStats[], heliusApiKey: string, lookbackMinutes?: number): Promise<SmartWalletSignal>;
