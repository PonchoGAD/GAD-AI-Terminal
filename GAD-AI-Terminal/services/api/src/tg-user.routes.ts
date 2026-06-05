import { Application, Request, Response } from 'express';
import { query } from '@lib/db';
import axios from 'axios';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

async function notifyTelegram(telegramId: string | number, text: string) {
  if (!BOT_TOKEN) return;
  await axios
    .post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      chat_id: telegramId,
      text,
      parse_mode: 'Markdown'
    })
    .catch(() => {});
}

export function registerTgUserRoutes(app: Application) {

  /**
   * POST /tg/link
   * Body: { telegram_id, wallet_address, username? }
   * Links a Solana wallet to a Telegram user.
   * Called by the payment page after the user connects their wallet.
   */
  app.post('/tg/link', async (req: Request, res: Response) => {
    try {
      const { telegram_id, wallet_address, username } = req.body;
      if (!telegram_id || !wallet_address) {
        return res.status(400).json({ error: 'telegram_id and wallet_address are required' });
      }

      await query(
        `INSERT INTO telegram_users (telegram_id, username, wallet_address, updated_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (telegram_id) DO UPDATE
           SET wallet_address = EXCLUDED.wallet_address,
               username       = COALESCE(EXCLUDED.username, telegram_users.username),
               updated_at     = now()`,
        [String(telegram_id), username ?? null, wallet_address]
      );

      res.json({ success: true, message: 'Wallet linked to Telegram user.' });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? String(err) });
    }
  });

  /**
   * GET /tg/status/:telegram_id
   * Returns the active subscription status for the Telegram user's linked wallet.
   */
  app.get('/tg/status/:telegram_id', async (req: Request, res: Response) => {
    try {
      const { telegram_id } = req.params;

      const userQ = await query<{ wallet_address: string; username: string }>(
        'SELECT wallet_address, username FROM telegram_users WHERE telegram_id = $1',
        [telegram_id]
      );

      if (!userQ.rows.length || !userQ.rows[0].wallet_address) {
        return res.json({ active: false, walletLinked: false });
      }

      const wallet = userQ.rows[0].wallet_address;

      const subQ = await query<{ plan_slug: string; expires_at: Date; status: string }>(
        `SELECT plan_slug, expires_at, status
         FROM subscriptions
         WHERE wallet_address = $1
           AND status = 'active'
           AND expires_at > now()
         ORDER BY expires_at DESC LIMIT 1`,
        [wallet]
      );

      if (!subQ.rows.length) {
        return res.json({ active: false, walletLinked: true, wallet });
      }

      const sub = subQ.rows[0];
      const remainingMs    = new Date(sub.expires_at).getTime() - Date.now();
      const remainingHours = Math.max(0, remainingMs / 3_600_000);

      res.json({
        active: true,
        walletLinked: true,
        wallet,
        plan: sub.plan_slug,
        expiresAt: sub.expires_at,
        remainingHours: Math.round(remainingHours * 10) / 10,
        isTrial: sub.plan_slug === 'trial_1d'
      });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? String(err) });
    }
  });

  /**
   * POST /tg/notify-payment
   * Body: { telegram_id, plan_slug, expires_at }
   * Called by the web payment page to notify the Telegram user after successful payment.
   */
  app.post('/tg/notify-payment', async (req: Request, res: Response) => {
    try {
      const { telegram_id, plan_slug, expires_at } = req.body;
      if (!telegram_id || !plan_slug) {
        return res.status(400).json({ error: 'telegram_id and plan_slug are required' });
      }

      const planNames: Record<string, string> = {
        trial_1d: '1-Day Trial (0.1 SOL)',
        monthly:  'Full Access — 1 Month (1 SOL)'
      };
      const expStr = expires_at
        ? new Date(expires_at).toLocaleString('en-US', { timeZone: 'UTC', dateStyle: 'medium', timeStyle: 'short' }) + ' UTC'
        : '—';

      await notifyTelegram(
        telegram_id,
        `✅ *Payment confirmed!*\n\nPlan: *${planNames[plan_slug] ?? plan_slug}*\nExpires: ${expStr}\n\n` +
        `You now have full access to *GAD AI Terminal*.\nType /help to see all commands. WAGMI 🚀`
      );

      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? String(err) });
    }
  });
}
