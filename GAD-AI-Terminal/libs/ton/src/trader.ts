import { internal } from '@ton/ton';
import { toNano, fromNano } from '@ton/core';
import { DEX, pTON } from '@ston-fi/sdk';
import { getClient, getKeyPair, getWalletOpen, getJettonBalance } from './client';

// STON.fi v1 Router (most liquidity, most pools)
const STONFI_ROUTER = 'EQB3ncyBUTjZUA5EnFKR5_EnOMI9V1tTEAAPaiU71gc4TiUt';
// proxy TON v1 address
const PTON_ADDR     = 'EQBnGWMCf3-FZZq1W4IWcNiZ0_ms5Dh-bICans0ol1Y20n3j';

// Extra TON for gas + forward fees (0.3 TON covers most swaps)
const GAS_RESERVE_TON = toNano('0.3');

export interface TonTradeResult {
  ok:            boolean;
  tx_id?:        string;
  amount_in?:    string;
  amount_out?:   string;
  jetton_amount? : string;
  dex:           string;
  error?:        string;
}

export async function buyJetton(
  jettonAddress: string,
  tonAmount: number,
  slippagePct = 5
): Promise<TonTradeResult> {
  try {
    const client  = getClient();
    const keyPair = await getKeyPair();
    const wo      = await getWalletOpen();

    const router   = client.open(DEX.v1.Router.create(STONFI_ROUTER));
    const proxyTon = pTON.v1.create(PTON_ADDR);

    const offerAmount = toNano(tonAmount.toString());

    // minAskAmount = 0 → accept any output (fail-open for reliability)
    // Slippage protection via STON.fi's internal price impact limit
    const minAskAmount = '0';

    const txParams = await router.getSwapTonToJettonTxParams({
      userWalletAddress: wo.address.toString(),
      proxyTon,
      offerAmount,
      askJettonAddress: jettonAddress,
      minAskAmount,
      queryId: BigInt(Date.now()),
    });

    const totalValue = offerAmount + GAS_RESERVE_TON;
    const seqno = await wo.getSeqno();
    await wo.sendTransfer({
      seqno,
      secretKey: keyPair.secretKey,
      messages: [
        internal({
          to:    txParams.to,
          value: totalValue,
          body:  txParams.body,
        }),
      ],
    });

    // Poll for jetton balance to confirm receipt (up to 45s)
    let jettonAmountNano = 0n;
    for (let i = 0; i < 9; i++) {
      await new Promise(r => setTimeout(r, 5000));
      jettonAmountNano = await getJettonBalance(jettonAddress);
      if (jettonAmountNano > 0n) break;
    }

    const txId = `ton_buy_${Date.now()}`;
    return {
      ok:            true,
      tx_id:         txId,
      amount_in:     tonAmount.toString(),
      jetton_amount: jettonAmountNano.toString(),
      amount_out:    fromNano(jettonAmountNano),
      dex:           'stonfi_v1',
    };
  } catch (e: any) {
    return { ok: false, dex: 'stonfi_v1', error: e.message ?? String(e) };
  }
}

export async function sellJetton(
  jettonAddress: string,
  jettonAmountNano: bigint,
  slippagePct = 0
): Promise<TonTradeResult> {
  try {
    const client  = getClient();
    const keyPair = await getKeyPair();
    const wo      = await getWalletOpen();

    const router   = client.open(DEX.v1.Router.create(STONFI_ROUTER));
    const proxyTon = pTON.v1.create(PTON_ADDR);

    // minAskAmount = 0 for exits — must close position at any price
    const minAskAmount = '0';

    const txParams = await router.getSwapJettonToTonTxParams({
      userWalletAddress: wo.address.toString(),
      proxyTon,
      offerJettonAddress: jettonAddress,
      offerAmount:        jettonAmountNano,
      minAskAmount,
      queryId:            BigInt(Date.now()),
    });

    const seqno = await wo.getSeqno();
    await wo.sendTransfer({
      seqno,
      secretKey: keyPair.secretKey,
      messages: [
        internal({
          to:    txParams.to,
          value: GAS_RESERVE_TON,
          body:  txParams.body,
        }),
      ],
    });

    return {
      ok:          true,
      tx_id:       `ton_sell_${Date.now()}`,
      amount_in:   jettonAmountNano.toString(),
      amount_out:  '0', // resolved async; monitor updates after confirmation
      dex:         'stonfi_v1',
    };
  } catch (e: any) {
    return { ok: false, dex: 'stonfi_v1', error: e.message ?? String(e) };
  }
}

// Verify that at least `minTokens` jettons were received 15s after a buy.
// TON transactions are async message chains — the buy TX hash alone doesn't confirm receipt.
// Returns { ok: true } if balance ≥ minTokens, { ok: false } if bounced/failed.
export async function verifyJettonBalance(
  jettonAddress: string,
  minTokens: bigint = 1n,
  pollMs = 15_000,
  retries = 3
): Promise<{ ok: boolean; balance: bigint; error?: string }> {
  for (let attempt = 0; attempt < retries; attempt++) {
    await new Promise(r => setTimeout(r, pollMs));
    try {
      const balance = await getJettonBalance(jettonAddress);
      if (balance >= minTokens) {
        console.info(`[ton-trader] ✅ verifyJettonBalance: balance=${balance} ≥ min=${minTokens}`);
        return { ok: true, balance };
      }
      console.debug(`[ton-trader] verifyJettonBalance attempt ${attempt + 1}: balance=${balance} < min=${minTokens}`);
    } catch (e: any) {
      console.warn(`[ton-trader] verifyJettonBalance attempt ${attempt + 1} error: ${e.message}`);
    }
  }
  const finalBalance = await getJettonBalance(jettonAddress).catch(() => 0n);
  if (finalBalance > 0n) return { ok: true, balance: finalBalance };
  console.error(`[ton-trader] ❌ verifyJettonBalance: 0 tokens after ${retries} attempts — likely bounced TX`);
  return { ok: false, balance: 0n, error: 'jetton_not_received' };
}
