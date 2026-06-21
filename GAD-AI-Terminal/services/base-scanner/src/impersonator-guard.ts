/**
 * Anti-Impersonator Guard for Base Network
 *
 * Problem: Scammers create tokens named SOL, BNB, cbSOL, wSOL.base, etc.
 * to appear in DexScreener/aggregator searches. These are honeypots 99.9% of the time.
 *
 * Solution: Two-layer defense:
 *   Layer 1 (fast): Symbol pattern matching — catches exact and variant matches (wSOL, cbSOL, SOL-wrapped)
 *   Layer 2 (precise): If the symbol matches a known cross-chain asset but the contract
 *                      address is NOT the official bridge address → confirmed impersonator
 *
 * Why not just block all matching symbols?
 *   The real cbBTC (Coinbase BTC) and real cbSOL ARE legitimate Base tokens with known addresses.
 *   We still don't want to trade them (they're bridge assets, not meme tokens), but the
 *   address check gives us ground truth for future use cases.
 */

// Official bridge/wrapped token addresses on Base (lowercase)
// Source: official bridge docs, Coinbase, Wormhole portal
const VERIFIED_BRIDGE_ADDRESSES = new Set<string>([
  // ── BTC ──────────────────────────────────────────────────────────────────────
  '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf', // cbBTC — Coinbase Wrapped BTC
  '0x1c03d3609b2d64fae1dd60a6bf36a044e64be1f5', // WBTC (Wormhole)

  // ── SOL ──────────────────────────────────────────────────────────────────────
  '0x22ec7a40b95880c45d35a3973c73e04e1358b387', // SOL (Wormhole bridged)
  '0xcb1c1df9b7e21e13fd93cc1394f995cc79133887', // cbSOL — Coinbase Wrapped Staked SOL

  // ── BNB ──────────────────────────────────────────────────────────────────────
  '0xd722e55c1d9d9fa0021a5215cbb904b92b3dc5d4', // BNB (Wormhole)

  // ── AVAX ─────────────────────────────────────────────────────────────────────
  '0x0e91f814f25aad86c7af7001f0e26f02ac729c7d', // AVAX (Wormhole)

  // ── MATIC / POL ──────────────────────────────────────────────────────────────
  '0x3033f0d01e21d8c6aa8d82b3b6fd65b8b4d14ec3', // MATIC (Wormhole)

  // ── ADA ──────────────────────────────────────────────────────────────────────
  '0x1829de17b91a1cce3af558fe399dbb7c9d36cfae', // ADA (Wormhole)

  // ── XRP ──────────────────────────────────────────────────────────────────────
  '0x6b175474e89094c44da98b954eedeac495271d0f', // placeholder — no official XRP bridge on Base yet

  // ── Stablecoins (also filtered — not memes) ──────────────────────────────────
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', // USDC (native Circle)
  '0xfde4c96c8593536e31f229ea8f37b2ada2699bb2', // USDT (bridged)
  '0x50c5725949a6f0c72e6c4a641f24049a917db0cb', // DAI
]);

// Symbol patterns that indicate a cross-chain impersonation or bridge asset.
// Tested against symbol.toUpperCase().
const IMPERSONATOR_PATTERNS: RegExp[] = [
  // Bitcoin variants
  /\bBTC\b/, /\bWBTC\b/, /\bCBBTC\b/, /\bBITCOIN\b/,
  // Solana variants
  /\bSOL\b/, /\bWSOL\b/, /\bCBSOL\b/, /\bSOLANA\b/,
  // BNB / Binance
  /\bBNB\b/, /\bWBNB\b/, /\bBINANCE\b/,
  // Avalanche
  /\bAVAX\b/, /\bWAVAX\b/, /\bAVALANCHE\b/,
  // Polygon
  /\bMATIC\b/, /\bWMATIC\b/, /\bPOL\b/, /\bPOLYGON\b/,
  // Cardano
  /\bADA\b/, /\bCARDANO\b/,
  // Polkadot
  /\bDOT\b/, /\bPOLKADOT\b/,
  // Tron
  /\bTRX\b/, /\bTRON\b/,
  // XRP
  /\bXRP\b/, /\bRIPPLE\b/,
  // Near
  /\bNEAR\b/,
  // Sui / Aptos
  /\bSUI\b/, /\bAPT\b/, /\bAPTOS\b/,
  // Fantom
  /\bFTM\b/, /\bFANTOM\b/,
  // Cosmos
  /\bATOM\b/, /\bCOSMOS\b/,
  // ICP
  /\bICP\b/,
  // Algorand
  /\bALGO\b/, /\bALGORAND\b/,
  // Stellar
  /\bXLM\b/, /\bSTELLAR\b/,
  // VeChain
  /\bVET\b/,
  // Egld
  /\bEGLD\b/, /\bMULTIVERSX\b/,
];

// Cache checked addresses to avoid redundant logging
const _warnedOnce = new Set<string>();

/**
 * Returns true if the token is a cross-chain impersonator that should be rejected.
 *
 * Logic:
 *   1. If symbol matches a known cross-chain pattern AND address is NOT an official bridge → impersonator
 *   2. If address is in the verified bridge set → legitimate bridge asset (still reject — not a meme)
 *      (callsite can distinguish via `isVerifiedBridgeAsset()` if needed)
 */
export function isBaseTokenImpersonator(symbol: string, contractAddress: string): boolean {
  const sym  = symbol.toUpperCase().trim();
  const addr = contractAddress.toLowerCase().trim();

  // Layer 2: known official bridge address → legitimate but not a meme token, still block
  if (VERIFIED_BRIDGE_ADDRESSES.has(addr)) {
    return true;
  }

  // Layer 1: symbol pattern match
  const patternHit = IMPERSONATOR_PATTERNS.some(p => p.test(sym));
  if (!patternHit) return false;

  // Symbol looks like a cross-chain asset but address is NOT a known official bridge.
  // This is a scammer token trying to ride the name recognition.
  if (!_warnedOnce.has(addr)) {
    _warnedOnce.add(addr);
    console.warn(
      `[anti-impersonator] 🚨 IMPERSONATOR: symbol="${symbol}" addr=${contractAddress} ` +
      `— not an official bridge address, blocking`
    );
  }
  return true;
}

/** Convenience: is this a known, legitimate official bridge token (cbBTC, cbSOL, etc.) */
export function isVerifiedBridgeAsset(contractAddress: string): boolean {
  return VERIFIED_BRIDGE_ADDRESSES.has(contractAddress.toLowerCase().trim());
}
