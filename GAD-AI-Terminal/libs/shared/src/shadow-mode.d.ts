export interface ShadowTradeInput {
  chain:            string;
  strategy:         string;
  symbol:           string;
  contract_address: string;
  entry_price:      number;
  entry_mcap_usd?:  number;
  entry_liq_usd?:   number;
  entry_pc1h?:      number;
  filter_params?:   Record<string, any>;
  tp1_target?:      number;
  stop_pct?:        number;
}
export declare function recordShadowTrade(t: ShadowTradeInput): Promise<void>;
export declare function checkShadowTrades(): Promise<void>;
export declare function shadowReport(): Promise<string>;
