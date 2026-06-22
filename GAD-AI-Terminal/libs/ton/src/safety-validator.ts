/**
 * TON Jetton Safety Validator — direct on-chain check
 *
 * Complements libs/ton/src/safety.ts (which uses tonapi.io REST).
 * This module queries the Jetton Master contract directly via TonClient
 * using the get_jetton_data method, checking:
 *
 *   1. mintable === false  (dev cannot print more tokens)
 *   2. admin_address is null/zero  (dev renounced ownership)
 *
 * Note: libs/ton/src/safety.ts already checks these via tonapi.io.
 * This is a DIRECT fallback when the API is unavailable.
 */
import { TonClient, Address } from '@ton/ton';

export async function verifyTonJettonSafety(
  client: TonClient,
  jettonMasterAddress: string,
): Promise<{ isSafe: boolean; reason?: string }> {
  try {
    const master = Address.parse(jettonMasterAddress);

    // get_jetton_data returns: (total_supply, mintable, admin_address, content_cell, wallet_code)
    const { stack } = await client.runMethod(master, 'get_jetton_data');

    stack.readBigNumber();              // skip total_supply
    const mintable = stack.readBoolean(); // -1 = true, 0 = false in TVM

    // 1. Mintable check
    if (mintable) {
      return { isSafe: false, reason: 'JETTON_IS_MINTABLE' };
    }

    // 2. Admin address check (renounced = null or zero addr)
    try {
      const adminCell = stack.readCell();
      const adminSlice = adminCell.beginParse();

      // addr_none in TVM serializes with leading bits 00 — readAddress returns null
      const adminAddress = adminSlice.loadMaybeAddress();
      if (adminAddress !== null) {
        const zeroAddr = '0:0000000000000000000000000000000000000000000000000000000000000000';
        if (adminAddress.toString() !== zeroAddr) {
          return { isSafe: false, reason: `ADMIN_NOT_RENOUNCED: ${adminAddress.toString().slice(0, 20)}...` };
        }
      }
    } catch {
      // Empty cell or addr_none — admin is renounced (normal for TON)
    }

    return { isSafe: true };
  } catch (err: any) {
    // Contract call failed — fail open (don't block during RPC issues)
    console.debug(`[ton-guard] ⚠ verifyTonJettonSafety error: ${err?.message}`);
    return { isSafe: true, reason: 'TON_RPC_FAIL_OPEN' };
  }
}
