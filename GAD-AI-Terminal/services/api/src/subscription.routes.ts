import { Application, Request, Response } from 'express';
import { query } from '@lib/db';
import { Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import axios from 'axios';

const SOLANA_RPC      = process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com';
const TREASURY_WALLET = process.env.TREASURY_WALLET_ADDRESS;

// EVM/BSC USDT payment settings
const BSC_RPC         = process.env.BSC_RPC || 'https://bsc-dataseed1.binance.org';
const USDT_BSC        = (process.env.USDT_BSC_CONTRACT || '0x55d398326f99059fF775485246999027B3197955').toLowerCase();
const TREASURY_EVM    = (process.env.BSC_WALLET_PUBLIC_KEY || '').toLowerCase();
const TRANSFER_TOPIC  = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

// Owner wallets that bypass subscription checks (comma-separated in FREE_WALLETS env)
const FREE_WALLETS = new Set(
  (process.env.FREE_WALLETS ?? '').split(',').map(w => w.trim()).filter(Boolean)
);

const PLAN_PRICES: Record<string, number> = {
  trial_1d: 0.05,
  trial_3d: 0.1,
  monthly:  1.0,
};

const connection = new Connection(SOLANA_RPC, { commitment: 'confirmed' });

// ─── BSC RPC helper ───────────────────────────────────────────────────────────
async function bscRpc(method: string, params: any[]): Promise<any> {
  const { data } = await axios.post(BSC_RPC,
    { jsonrpc: '2.0', method, params, id: 1 },
    { timeout: 15000 }
  );
  return data.result ?? null;
}

// ─── Verify USDT (BEP-20) transfer on BSC ────────────────────────────────────
// BSC USDT (0x55d398...) has 18 decimals (NOT 6 like Ethereum USDT)
async function verifyUsdtTx(
  txHash: string,
  expectedAmountUsd: number
): Promise<{ ok: boolean; detail?: string; actualAmount?: number }> {
  const DELAYS = [2000, 4000, 8000, 12000, 16000];

  for (let i = 0; i <= DELAYS.length; i++) {
    if (i > 0) await new Promise(r => setTimeout(r, DELAYS[i - 1]));

    try {
      const receipt = await bscRpc('eth_getTransactionReceipt', [txHash]);

      if (!receipt) {
        if (i < DELAYS.length) continue;
        return { ok: false, detail: 'Transaction not found. Wait 30s and retry.' };
      }

      if (receipt.status !== '0x1') {
        return { ok: false, detail: 'Transaction failed on BSC.' };
      }

      // Find USDT Transfer log: address=USDT contract, topic[2]=treasury wallet
      const treasuryPadded = TREASURY_EVM.replace('0x', '').padStart(64, '0');
      const log = (receipt.logs ?? []).find((l: any) =>
        l.address?.toLowerCase() === USDT_BSC &&
        l.topics?.[0] === TRANSFER_TOPIC &&
        l.topics?.[2]?.toLowerCase() === '0x' + treasuryPadded
      );

      if (!log) {
        return { ok: false, detail: 'No USDT transfer to treasury found in this transaction.' };
      }

      // Amount is in log.data as uint256 with 18 decimals
      const amountWei = BigInt(log.data);
      const actualAmount = Number(amountWei) / 1e18;

      if (actualAmount < expectedAmountUsd * 0.99) {
        return {
          ok: false,
          actualAmount,
          detail: `Received $${actualAmount.toFixed(2)} USDT, expected $${expectedAmountUsd.toFixed(2)}.`
        };
      }

      return { ok: true, actualAmount };

    } catch (e: any) {
      if (i < DELAYS.length) continue;
      return { ok: false, detail: `BSC RPC error: ${e.message}` };
    }
  }

  return { ok: false, detail: 'Max retries exceeded.' };
}

async function safeRes<T>(res: Response, fn: () => Promise<T>) {
  try { await fn(); }
  catch (err: any) { res.status(500).json({ error: err?.message ?? String(err) }); }
}

// ─── Verify Solana payment on-chain ──────────────────────────────────────────
async function verifyPaymentTx(
  txSignature: string,
  expectedRecipient: string,
  minSol: number
): Promise<{ ok: boolean; actualSol?: number; from?: string; detail?: string }> {
  // Retry with exponential backoff — TX may not be confirmed yet when frontend submits
  const RETRIES = 6;
  const DELAYS  = [1000, 2000, 4000, 8000, 12000, 16000];

  for (let attempt = 0; attempt < RETRIES; attempt++) {
    try {
      const tx = await connection.getParsedTransaction(txSignature, {
        maxSupportedTransactionVersion: 0,
        commitment: attempt < 4 ? 'confirmed' : 'finalized',
      });

      if (!tx) {
        // TX not found yet — wait and retry
        if (attempt < RETRIES - 1) {
          console.info(`[sub] TX ${txSignature.slice(0, 12)}... not found (attempt ${attempt + 1}/${RETRIES}), retrying in ${DELAYS[attempt]}ms`);
          await new Promise(r => setTimeout(r, DELAYS[attempt]));
          continue;
        }
        return { ok: false, detail: 'Transaction not found after 6 attempts. Please wait 30s and try again.' };
      }

      const preBalances  = tx.meta?.preBalances  ?? [];
      const postBalances = tx.meta?.postBalances ?? [];
      const accounts     = tx.transaction.message.accountKeys;

      const recipientIdx = accounts.findIndex(
        (a: any) => (a.pubkey ?? a).toString() === expectedRecipient
      );
      if (recipientIdx < 0) return { ok: false, detail: 'Treasury wallet not found in transaction.' };

      if (recipientIdx >= postBalances.length || recipientIdx >= preBalances.length) {
        return { ok: false, detail: 'Balance metadata missing.' };
      }

      const received = (postBalances[recipientIdx] - preBalances[recipientIdx]) / LAMPORTS_PER_SOL;
      if (received <= 0 || received < minSol * 0.99) {
        return { ok: false, actualSol: received, detail: `Received ${received.toFixed(4)} SOL, expected ${minSol} SOL.` };
      }

      const from = (accounts[0]?.pubkey ?? accounts[0])?.toString();
      console.info(`[sub] ✅ Payment verified: ${received.toFixed(4)} SOL from ${from?.slice(0, 8)}...`);
      return { ok: true, actualSol: received, from };

    } catch (err: any) {
      if (attempt < RETRIES - 1) {
        await new Promise(r => setTimeout(r, DELAYS[attempt]));
        continue;
      }
      return { ok: false, detail: `RPC error: ${err.message}` };
    }
  }
  return { ok: false, detail: 'Max retries exceeded.' };
}

export function registerSubscriptionRoutes(app: Application) {

  /** GET /subscription/plans — list plans */
  app.get('/subscription/plans', async (_req, res: Response) => {
    await safeRes(res, async () => {
      const { rows } = await query('SELECT * FROM subscription_plans WHERE active = true ORDER BY price_sol ASC');
      res.json({
        plans: rows,
        treasury: TREASURY_WALLET ?? null
      });
    });
  });

  /** GET /subscription/status?wallet=<address> */
  app.get('/subscription/status', async (req: Request, res: Response) => {
    await safeRes(res, async () => {
      const { wallet } = req.query;
      if (!wallet) return res.status(400).json({ error: 'wallet is required' });

      // Owner wallets bypass subscription requirement
      if (FREE_WALLETS.has(String(wallet))) {
        return res.json({
          active: true,
          plan: 'owner',
          expiresAt: null,
          remainingHours: null,
          isTrial: false,
          trialAvailable: false,
          isFree: true
        });
      }

      const { rows } = await query<{
        plan_slug: string;
        expires_at: Date;
        status: string;
        trial_used: boolean;
      }>(
        `SELECT plan_slug, expires_at, status, trial_used
         FROM subscriptions
         WHERE wallet_address = $1
           AND status = 'active'
           AND expires_at > now()
         ORDER BY expires_at DESC LIMIT 1`,
        [String(wallet)]
      );

      const trialUsed = await query<{ cnt: string }>(
        `SELECT COUNT(*) AS cnt FROM subscriptions WHERE wallet_address = $1 AND plan_slug LIKE 'trial_%'`,
        [String(wallet)]
      );

      if (!rows.length) {
        return res.json({
          active: false,
          plan: null,
          expiresAt: null,
          trialAvailable: Number(trialUsed.rows[0]?.cnt ?? 0) === 0
        });
      }

      const sub = rows[0];
      const remainingMs = new Date(sub.expires_at).getTime() - Date.now();
      const remainingHours = Math.max(0, remainingMs / 3_600_000);

      res.json({
        active: true,
        plan: sub.plan_slug,
        expiresAt: sub.expires_at,
        remainingHours: Math.round(remainingHours * 10) / 10,
        isTrial: sub.plan_slug === 'trial_1d',
        trialAvailable: false
      });
    });
  });

  /** POST /subscription/verify — verify on-chain tx and activate subscription */
  app.post('/subscription/verify', async (req: Request, res: Response) => {
    await safeRes(res, async () => {
      const { wallet_address, tx_signature, plan_slug } = req.body;
      if (!wallet_address || !tx_signature || !plan_slug) {
        return res.status(400).json({ error: 'wallet_address, tx_signature and plan_slug are required' });
      }

      // Check plan
      const planQ = await query('SELECT * FROM subscription_plans WHERE slug = $1 AND active = true', [plan_slug]);
      if (!planQ.rows.length) return res.status(404).json({ error: 'Plan not found' });
      const plan = planQ.rows[0];

      // Prevent trial reuse (each trial slug can only be purchased once per wallet)
      if (plan_slug.startsWith('trial_')) {
        const used = await query(
          'SELECT id FROM subscriptions WHERE wallet_address = $1 AND plan_slug = $2',
          [wallet_address, plan_slug]
        );
        if (used.rows.length) return res.status(409).json({ error: `Trial plan "${plan_slug}" already used for this wallet.` });
      }

      // Prevent tx reuse
      const txExists = await query('SELECT id FROM subscriptions WHERE tx_signature = $1', [tx_signature]);
      if (txExists.rows.length) return res.status(409).json({ error: 'Transaction already used.' });

      // Verify on-chain
      if (!TREASURY_WALLET) {
        return res.status(500).json({ error: 'TREASURY_WALLET_ADDRESS not configured on server.' });
      }

      const verification = await verifyPaymentTx(
        tx_signature,
        TREASURY_WALLET,
        Number(plan.price_sol)
      );

      if (!verification.ok) {
        return res.status(402).json({
          error: verification.detail ?? 'Payment verification failed. Transaction not found or insufficient amount.',
          expected: `${plan.price_sol} SOL to ${TREASURY_WALLET}`,
          actualSol: verification.actualSol,
          hint: 'Wait 30 seconds after sending SOL, then try again. If the problem persists, contact support.'
        });
      }

      // Activate subscription
      const startedAt  = new Date();
      const expiresAt  = new Date(startedAt.getTime() + plan.duration_hours * 3_600_000);

      const { rows } = await query(
        `INSERT INTO subscriptions
           (wallet_address, plan_slug, tx_signature, amount_sol, status, started_at, expires_at, verified_at)
         VALUES ($1,$2,$3,$4,'active',now(),$5,now())
         RETURNING *`,
        [wallet_address, plan_slug, tx_signature, verification.actualSol ?? plan.price_sol, expiresAt]
      );

      res.json({
        success: true,
        subscription: rows[0],
        message: `Subscription activated: ${plan.name}. Expires ${expiresAt.toISOString()}`
      });
    });
  });

  /** POST /subscription/mock-verify — DEV ONLY: activate without real payment */
  app.post('/subscription/mock-verify', async (req: Request, res: Response) => {
    if (process.env.NODE_ENV === 'production') {
      return res.status(403).json({ error: 'Not available in production.' });
    }
    await safeRes(res, async () => {
      const { wallet_address, plan_slug } = req.body;
      if (!wallet_address || !plan_slug) return res.status(400).json({ error: 'wallet_address and plan_slug required' });

      const planQ = await query('SELECT * FROM subscription_plans WHERE slug = $1', [plan_slug]);
      if (!planQ.rows.length) return res.status(404).json({ error: 'Plan not found' });
      const plan = planQ.rows[0];

      const expiresAt = new Date(Date.now() + plan.duration_hours * 3_600_000);
      const fakeTx    = `mock_${Date.now()}_${wallet_address.slice(0, 8)}`;

      const { rows } = await query(
        `INSERT INTO subscriptions
           (wallet_address, plan_slug, tx_signature, amount_sol, status, started_at, expires_at, verified_at)
         VALUES ($1,$2,$3,$4,'active',now(),$5,now())
         ON CONFLICT DO NOTHING
         RETURNING *`,
        [wallet_address, plan_slug, fakeTx, plan.price_sol, expiresAt]
      );

      res.json({ success: true, subscription: rows[0] ?? { wallet_address, plan_slug, expires_at: expiresAt } });
    });
  });

  /** POST /subscription/verify-usdt — verify BSC USDT transfer and activate subscription */
  app.post('/subscription/verify-usdt', async (req: Request, res: Response) => {
    await safeRes(res, async () => {
      const { tx_hash, tg_user_id, plan_slug } = req.body;
      if (!tx_hash || !tg_user_id || !plan_slug) {
        return res.status(400).json({ error: 'tx_hash, tg_user_id and plan_slug are required' });
      }
      if (!TREASURY_EVM) {
        return res.status(500).json({ error: 'BSC_WALLET_PUBLIC_KEY not configured on server.' });
      }

      const planQ = await query('SELECT * FROM subscription_plans WHERE slug = $1 AND active = true', [plan_slug]);
      if (!planQ.rows.length) return res.status(404).json({ error: 'Plan not found' });
      const plan = planQ.rows[0];
      const priceUsd = Number(plan.price_usd ?? 0);
      if (!priceUsd) return res.status(500).json({ error: 'Plan has no USD price configured.' });

      // Prevent tx reuse
      const txExists = await query('SELECT id FROM subscriptions WHERE tx_signature = $1', [tx_hash]);
      if (txExists.rows.length) return res.status(409).json({ error: 'Transaction already used.' });

      // Virtual wallet for TG-based subscriptions
      const virtualWallet = `tg_${tg_user_id}`;

      // Prevent trial reuse
      if (plan_slug.startsWith('trial_')) {
        const used = await query(
          'SELECT id FROM subscriptions WHERE wallet_address = $1 AND plan_slug = $2',
          [virtualWallet, plan_slug]
        );
        if (used.rows.length) return res.status(409).json({ error: `Trial "${plan_slug}" already used for this account.` });
      }

      // Verify on BSC
      const verification = await verifyUsdtTx(tx_hash, priceUsd);
      if (!verification.ok) {
        return res.status(402).json({
          error: verification.detail ?? 'USDT payment verification failed.',
          expected: `$${priceUsd} USDT to ${TREASURY_EVM}`,
          actualAmount: verification.actualAmount,
          hint: 'Wait 30 seconds after sending USDT, then retry. Ensure you sent on BNB Smart Chain (BSC).'
        });
      }

      const expiresAt = new Date(Date.now() + Number(plan.duration_hours) * 3_600_000);

      const { rows } = await query(
        `INSERT INTO subscriptions
           (wallet_address, plan_slug, tx_signature, amount_sol, payment_type, status, started_at, expires_at, verified_at)
         VALUES ($1,$2,$3,0,'usdt_bsc','active',now(),$4,now())
         RETURNING *`,
        [virtualWallet, plan_slug, tx_hash, expiresAt]
      );

      res.json({
        success: true,
        subscription: rows[0],
        message: `Subscription activated: ${plan.name}. Expires ${expiresAt.toISOString()}`
      });
    });
  });

  /** POST /subscription/activate-stars — activate subscription after successful Telegram Stars payment */
  app.post('/subscription/activate-stars', async (req: Request, res: Response) => {
    await safeRes(res, async () => {
      const { tg_user_id, plan_slug, telegram_charge_id, total_amount } = req.body;
      if (!tg_user_id || !plan_slug || !telegram_charge_id) {
        return res.status(400).json({ error: 'tg_user_id, plan_slug and telegram_charge_id are required' });
      }

      const planQ = await query('SELECT * FROM subscription_plans WHERE slug = $1 AND active = true', [plan_slug]);
      if (!planQ.rows.length) return res.status(404).json({ error: 'Plan not found' });
      const plan = planQ.rows[0];

      // Prevent duplicate charge
      const txExists = await query('SELECT id FROM subscriptions WHERE tx_signature = $1', [telegram_charge_id]);
      if (txExists.rows.length) return res.status(409).json({ error: 'Stars payment already processed.' });

      // Verify Stars amount matches plan
      const expectedStars = Number(plan.price_stars ?? 0);
      if (expectedStars > 0 && Number(total_amount) < expectedStars) {
        return res.status(402).json({
          error: `Expected ${expectedStars} Stars, received ${total_amount}.`,
          expected: expectedStars,
          received: total_amount
        });
      }

      const virtualWallet = `tg_${tg_user_id}`;
      const expiresAt = new Date(Date.now() + Number(plan.duration_hours) * 3_600_000);

      const { rows } = await query(
        `INSERT INTO subscriptions
           (wallet_address, plan_slug, tx_signature, amount_sol, payment_type, status, started_at, expires_at, verified_at)
         VALUES ($1,$2,$3,0,'stars','active',now(),$4,now())
         RETURNING *`,
        [virtualWallet, plan_slug, telegram_charge_id, expiresAt]
      );

      console.info(`[sub] ⭐ Stars payment: tg_${tg_user_id} → ${plan_slug} | ${total_amount} stars | expires ${expiresAt.toISOString()}`);

      res.json({
        success: true,
        subscription: rows[0],
        message: `Subscription activated: ${plan.name}. Expires ${expiresAt.toISOString()}`
      });
    });
  });
}
