// Dynamic slippage for Base Network token buys.
// High vol/liq ratio means price is moving fast — wider slippage prevents failed TXs.
export function calculateDynamicSlippage(vol5mUsd: number, liquidityUsd: number): number {
  if (liquidityUsd <= 0) return 5.0;
  const ratio = vol5mUsd / liquidityUsd;
  if (ratio >= 0.15) {
    console.info(`[base-slippage] high vol/liq ${(ratio * 100).toFixed(1)}% → slippage 5%`);
    return 5.0;
  }
  return 3.0;
}
