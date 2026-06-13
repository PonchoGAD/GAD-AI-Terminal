// Type stub for @drift-labs/sdk (optional dependency, only used in LIVE mode)
// Prevents TypeScript compile errors when the package is not installed.
declare module '@drift-labs/sdk' {
  export const DriftClient: any;
  export const User: any;
  export const BulkAccountLoader: any;
  export const PerpMarkets: any;
  export const OrderType: any;
  export const PositionDirection: any;
  export const BASE_PRECISION: bigint;
  export const PRICE_PRECISION: bigint;
  export const MarketType: any;
  export function getMarketsAndOraclesForSubscription(types: any[]): any;
}
