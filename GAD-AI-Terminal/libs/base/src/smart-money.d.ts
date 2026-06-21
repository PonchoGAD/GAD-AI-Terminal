export interface BaseSmResult {
  weight: number;
  isActive: boolean;
  wallets: string[];
}
export declare function checkBaseSmartMoney(contractAddress: string, pairAddress: string): Promise<BaseSmResult>;
export declare function hasBaseSmartMoneySignal(contractAddress: string, pairAddress: string): Promise<boolean>;
export declare function harvestBaseTokenSnipers(contractAddress: string, pairAddress: string, limit?: number): Promise<void>;
