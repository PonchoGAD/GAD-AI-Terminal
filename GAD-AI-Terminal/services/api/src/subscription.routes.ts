import { Application, Request, Response } from 'express';
import { query } from '@lib/db';
import { Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';

const SOLANA_RPC      = process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com';
const TREASURY_WALLET = process.env.TREASURY_WALLET_ADDRESS;

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
}
