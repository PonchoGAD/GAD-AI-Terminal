/**
 * Anti-Impersonator Guard for Base Network
 *
 * Problem: Scammers create tokens named SOL, BNB, cbSOL, cbXRP, wSOL.base, etc.
 * to appear in DexScreener/aggregator searches. These are honeypots 99.9% of the time.
 *
 * Root cause of missed detections: `/\bXRP\b/` does NOT match "cbXRP" because
 * there is no word boundary between 'b' and 'X' in "cbXRP" — both are word chars.
 * Fix: Add explicit `/\bCB[A-Z]{2,8}\b/` pattern to catch ALL cb-prefixed tokens
 * (cbXRP, cbADA, cbDOT, cbETH, cbNEAR, cbSUI, ...).
 *
 * Solution: Two-layer defense:
 *   Layer 1 (fast): Symbol pattern matching — catches exact, variant, and prefix matches
 *     - Standalone:  XRP, SOL, BNB, ETH, BTC ...
 *     - cb-prefix:   cbXRP, cbSOL, cbBTC, cbETH, cbADA ... ← key fix
 *     - w-prefix:    wSOL, wBTC, wBNB, wXRP, wETH ...
 *     - st-prefix:   stETH, stSOL (liquid staking scams)
 *   Layer 2 (precise): If symbol matches AND address IS an official bridge → block (bridge asset)
 *
 * Known incidents:
 *   SOL  (June 2026): missed by old hardcoded Set, lost ~$12.50 × 3
 *   cbXRP (June 2026): missed by /\bXRP\b/ — word boundary gap. Lost ETH.
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
//
// CRITICAL: Use explicit prefixed variants (cbXXX, wXXX) because \bXRP\b does NOT
// match "cbXRP" — 'b' before 'X' is a word char → no word boundary → pattern miss.
// Added generic /\bCB[A-Z]{2,8}\b/ as a catch-all for Coinbase-style prefix scams.
const IMPERSONATOR_PATTERNS: RegExp[] = [
  // ── Generic prefix catch-alls (added June 2026 — cbXRP incident) ─────────────
  // Catches cbXRP, cbADA, cbDOT, cbETH, cbNEAR, cbSUI, cbATOM, cbMATIC...
  // Word boundary works at string start/end and space boundaries.
  /\bCB[A-Z]{2,8}\b/,
  // Catches stETH, stSOL, stMATIC, stBTC (liquid staking scams)
  /\bST(ETH|SOL|BTC|MATIC|AVAX|BNB|NEAR|XRP)\b/,

  // ── Bitcoin variants ──────────────────────────────────────────────────────────
  /\bBTC\b/, /\bWBTC\b/, /\bCBBTC\b/, /\bBITCOIN\b/, /\bRENBTC\b/,

  // ── Ethereum variants (MISSING before — key addition) ────────────────────────
  // ETH itself is native on Base, but scammer tokens named ETH/WETH/cbETH are common
  /\bWETH\b/, /\bCBETH\b/, /\bRETH\b/, /\bSTETH\b/, /\bSETH\b/, /\bETHEREUM\b/,
  // Note: plain /\bETH\b/ is intentionally omitted — many meme tokens legitimately
  //       use ETH in name (e.g. "ETHCAT", "BABYETH"). cbETH is covered by CB prefix.

  // ── Solana variants ───────────────────────────────────────────────────────────
  /\bSOL\b/, /\bWSOL\b/, /\bCBSOL\b/, /\bSOLANA\b/, /\bSOLETH\b/,

  // ── BNB / Binance ─────────────────────────────────────────────────────────────
  /\bBNB\b/, /\bWBNB\b/, /\bBINANCE\b/,

  // ── Avalanche ─────────────────────────────────────────────────────────────────
  /\bAVAX\b/, /\bWAVAX\b/, /\bAVALANCHE\b/,

  // ── Polygon ───────────────────────────────────────────────────────────────────
  /\bMATIC\b/, /\bWMATIC\b/, /\bPOLYGON\b/,
  // Note: /\bPOL\b/ removed — too broad (hits POLLY, POLAR, etc.)

  // ── XRP ── (the cbXRP incident: \bXRP\b missed cbXRP — now covered by CB prefix)
  /\bXRP\b/, /\bWXRP\b/, /\bRIPPLE\b/,

  // ── Cardano ───────────────────────────────────────────────────────────────────
  /\bADA\b/, /\bCARDANO\b/, /\bWADA\b/,

  // ── Polkadot ──────────────────────────────────────────────────────────────────
  /\bDOT\b/, /\bPOLKADOT\b/,
  // Note: /\bDOT\b/ kept despite possible false positives — no common meme uses it

  // ── Tron ──────────────────────────────────────────────────────────────────────
  /\bTRX\b/, /\bTRON\b/,

  // ── Near ──────────────────────────────────────────────────────────────────────
  /\bNEAR\b/, /\bWNEAR\b/,

  // ── Sui / Aptos ───────────────────────────────────────────────────────────────
  /\bSUI\b/, /\bAPTOS\b/,
  // Note: /\bAPT\b/ removed — too short, catches legitimate tokens (APES, APT as abbreviation)

  // ── Fantom ────────────────────────────────────────────────────────────────────
  /\bFTM\b/, /\bFANTOM\b/, /\bWFTM\b/,

  // ── Cosmos ────────────────────────────────────────────────────────────────────
  /\bATOM\b/, /\bCOSMOS\b/, /\bWATOM\b/,

  // ── ICP ───────────────────────────────────────────────────────────────────────
  /\bICPT\b/, /\bINTERNETCOMPUTER\b/,
  // Note: /\bICP\b/ removed — 3-letter acronym too risky for false positives

  // ── Algorand ──────────────────────────────────────────────────────────────────
  /\bALGO\b/, /\bALGORAND\b/,

  // ── Stellar ───────────────────────────────────────────────────────────────────
  /\bXLM\b/, /\bSTELLAR\b/,

  // ── VeChain ───────────────────────────────────────────────────────────────────
  /\bVECHAIN\b/, /\bVETH\b/,
  // Note: /\bVET\b/ removed — catches VET (any 3-letter ending in VET)

  // ── Egld / MultiversX ─────────────────────────────────────────────────────────
  /\bEGLD\b/, /\bMULTIVERSX\b/,

  // ── Major DeFi protocols (commonly impersonated on Base) ─────────────────────
  /\bCHAINLINK\b/, /\bUNISWAP\b/, /\bAAVE\b/, /\bCURVE\b/, /\bCOMPOUND\b/,
  /\bMAKER\b/, /\bMKR\b/, /\bSNX\b/, /\bSYNTHETIX\b/, /\bYEARN\b/,
  /\bLIDO\b/, /\bRPL\b/, /\bROCKETPOOL\b/,
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
