import { Application, Request, Response } from 'express';
import { query, transaction } from '@lib/db';

// ─── helpers ──────────────────────────────────────────────────────────────────
function isValidMint(mint: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint);
}

async function safeRes<T>(res: Response, fn: () => Promise<T>) {
  try {
    await fn();
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    console.error('[api]', msg);
    res.status(500).json({ error: msg });
  }
}

const FREE_WALLETS = new Set(
  (process.env.FREE_WALLETS ?? '').split(',').map(w => w.trim()).filter(Boolean)
);

/** Returns true if wallet has an active subscription or is whitelisted */
async function hasActiveSubscription(walletAddress: string): Promise<boolean> {
  if (!walletAddress) return false;
  if (FREE_WALLETS.has(walletAddress)) return true;
  const { rows } = await query(
    `SELECT 1 FROM subscriptions
     WHERE wallet_address = $1 AND status = 'active' AND expires_at > now()
     LIMIT 1`,
    [walletAddress]
  );
  return rows.length > 0;
}

export function registerRoutes(app: Application) {

  // ═══════════════════════════════════════════════════════════════════════════
  // TOKENS
  // ═══════════════════════════════════════════════════════════════════════════

  app.get('/tokens', async (_req, res: Response) => {
    await safeRes(res, async () => {
      const { rows } = await query('SELECT * FROM tokens ORDER BY last_updated DESC LIMIT 100');
      res.json({ tokens: rows });
    });
  });

  /** Top 20 tokens by latest ai_score */
  app.get('/tokens/trending', async (_req, res: Response) => {
    await safeRes(res, async () => {
      const { rows } = await query(`
        SELECT t.*, s.ai_score, s.risk_score, s.growth_score, s.momentum_score
        FROM tokens t
        JOIN LATERAL (
          SELECT ai_score, risk_score, growth_score, momentum_score
          FROM score_history sh
          WHERE sh.token_id = t.id
          ORDER BY sh.created_at DESC LIMIT 1
        ) s ON true
        ORDER BY s.ai_score DESC
        LIMIT 20
      `);
      res.json({ tokens: rows });
    });
  });

  /** Tokens first seen in the last N minutes */
  app.get('/tokens/new', async (req: Request, res: Response) => {
    await safeRes(res, async () => {
      const minutes = Math.min(Number(req.query.minutes ?? 30), 1440);
      const { rows } = await query(
        `SELECT * FROM tokens WHERE first_seen > now() - ($1 || ' minutes')::interval ORDER BY first_seen DESC LIMIT 50`,
        [String(minutes)]
      );
      res.json({ tokens: rows });
    });
  });

  /** Tokens with ai_score >= threshold */
  app.get('/tokens/highscore', async (req: Request, res: Response) => {
    await safeRes(res, async () => {
      const threshold = Number(req.query.threshold ?? 80);
      const { rows } = await query(`
        SELECT DISTINCT ON (t.id) t.*, s.ai_score, s.risk_score, s.explanation
        FROM tokens t
        JOIN score_history s ON s.token_id = t.id
        WHERE s.ai_score >= $1
        ORDER BY t.id, s.created_at DESC
      `, [threshold]);
      res.json({ tokens: rows });
    });
  });

  /** Tokens with risk_score >= threshold */
  app.get('/tokens/highrisk', async (req: Request, res: Response) => {
    await safeRes(res, async () => {
      const threshold = Number(req.query.threshold ?? 70);
      const { rows } = await query(`
        SELECT DISTINCT ON (t.id) t.*, s.risk_score, s.ai_score, s.explanation
        FROM tokens t
        JOIN score_history s ON s.token_id = t.id
        WHERE s.risk_score >= $1
        ORDER BY t.id, s.created_at DESC
      `, [threshold]);
      res.json({ tokens: rows });
    });
  });

  app.get('/tokens/:mint', async (req: Request, res: Response) => {
    await safeRes(res, async () => {
      const { mint } = req.params;
      const token = await query('SELECT * FROM tokens WHERE mint_address = $1', [mint]);
      if (!token.rows.length) return res.status(404).json({ error: 'Token not found' });
      const metrics = await query('SELECT * FROM token_metrics WHERE token_id = $1 ORDER BY timestamp DESC LIMIT 10', [token.rows[0].id]);
      const scores = await query('SELECT * FROM score_history WHERE token_id = $1 ORDER BY created_at DESC LIMIT 5', [token.rows[0].id]);
      const alerts = await query('SELECT * FROM alerts WHERE subject = $1 ORDER BY created_at DESC LIMIT 10', [mint]);
      res.json({ token: token.rows[0], metrics: metrics.rows, scores: scores.rows, alerts: alerts.rows });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // WALLETS
  // ═══════════════════════════════════════════════════════════════════════════

  app.get('/wallets/:address', async (req: Request, res: Response) => {
    await safeRes(res, async () => {
      const { address } = req.params;
      const wallet = await query('SELECT * FROM wallets WHERE address = $1', [address]);
      if (!wallet.rows.length) return res.status(404).json({ error: 'Wallet not found' });
      const trades = await query('SELECT * FROM wallet_trades WHERE wallet_id = $1 ORDER BY executed_at DESC LIMIT 50', [wallet.rows[0].id]);
      const whaleScore = await query('SELECT * FROM whale_scores WHERE wallet_id = $1', [wallet.rows[0].id]);
      res.json({ wallet: wallet.rows[0], trades: trades.rows, whaleScore: whaleScore.rows[0] ?? null });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // WATCHLIST
  // ═══════════════════════════════════════════════════════════════════════════

  app.get('/watchlist', async (_req, res: Response) => {
    await safeRes(res, async () => {
      const tokens = await query(`SELECT t.* FROM tokens t JOIN watchlist_tokens w ON w.token_id = t.id ORDER BY w.added_at DESC`);
      const wallets = await query(`SELECT w.* FROM wallets w JOIN watchlist_wallets x ON x.wallet_id = w.id ORDER BY x.added_at DESC`);
      res.json({ tokens: tokens.rows, wallets: wallets.rows });
    });
  });

  app.post('/watchlist/token', async (req: Request, res: Response) => {
    await safeRes(res, async () => {
      const { mint, addedBy } = req.body;
      if (!mint) return res.status(400).json({ error: 'mint is required' });
      const tokenResult = await query('SELECT id FROM tokens WHERE mint_address = $1', [mint]);
      if (!tokenResult.rows.length) return res.status(404).json({ error: 'Token not found' });
      await query('INSERT INTO watchlist_tokens (token_id, added_by) VALUES ($1, $2) ON CONFLICT DO NOTHING', [tokenResult.rows[0].id, addedBy || 'user']);
      res.json({ success: true });
    });
  });

  app.delete('/watchlist/token/:mint', async (req: Request, res: Response) => {
    await safeRes(res, async () => {
      const { mint } = req.params;
      const tokenResult = await query('SELECT id FROM tokens WHERE mint_address = $1', [mint]);
      if (!tokenResult.rows.length) return res.status(404).json({ error: 'Token not found' });
      await query('DELETE FROM watchlist_tokens WHERE token_id = $1', [tokenResult.rows[0].id]);
      res.json({ success: true });
    });
  });

  app.post('/watchlist/wallet', async (req: Request, res: Response) => {
    await safeRes(res, async () => {
      const { address, addedBy } = req.body;
      if (!address) return res.status(400).json({ error: 'address is required' });
      const walletResult = await query('SELECT id FROM wallets WHERE address = $1', [address]);
      let walletId: string;
      if (!walletResult.rows.length) {
        const insert = await query('INSERT INTO wallets (address, last_activity) VALUES ($1, now()) RETURNING id', [address]);
        walletId = insert.rows[0].id;
      } else {
        walletId = walletResult.rows[0].id;
      }
      await query('INSERT INTO watchlist_wallets (wallet_id, added_by) VALUES ($1, $2) ON CONFLICT DO NOTHING', [walletId, addedBy || 'user']);
      res.json({ success: true });
    });
  });

  app.delete('/watchlist/wallet/:address', async (req: Request, res: Response) => {
    await safeRes(res, async () => {
      const { address } = req.params;
      const walletResult = await query('SELECT id FROM wallets WHERE address = $1', [address]);
      if (!walletResult.rows.length) return res.status(404).json({ error: 'Wallet not found' });
      await query('DELETE FROM watchlist_wallets WHERE wallet_id = $1', [walletResult.rows[0].id]);
      res.json({ success: true });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // PORTFOLIO (Sprint 9)
  // ═══════════════════════════════════════════════════════════════════════════

  app.get('/portfolio', async (_req, res: Response) => {
    await safeRes(res, async () => {
      const { rows } = await query(`
        SELECT pp.*, t.symbol, t.mint_address,
          CASE WHEN pp.current_price IS NOT NULL AND pp.entry_price > 0
               THEN ROUND(((pp.current_price - pp.entry_price) / pp.entry_price) * 100, 2)
               ELSE NULL
          END AS roi_pct,
          CASE WHEN pp.current_price IS NOT NULL
               THEN (pp.current_price - pp.entry_price) * pp.position_size
               ELSE NULL
          END AS unrealized_pnl
        FROM portfolio_positions pp
        LEFT JOIN tokens t ON t.id = pp.token_id
        ORDER BY pp.created_at DESC
      `);

      const stats = await query(`
        SELECT
          COUNT(*) FILTER (WHERE status = 'open')   AS open_count,
          COUNT(*) FILTER (WHERE status = 'closed') AS closed_count,
          SUM(CASE WHEN status = 'closed' AND current_price > entry_price
               THEN (current_price - entry_price) * position_size ELSE 0 END) AS realized_pnl,
          COUNT(*) FILTER (WHERE status = 'closed' AND current_price > entry_price) AS wins,
          COUNT(*) FILTER (WHERE status = 'closed' AND current_price <= entry_price) AS losses
        FROM portfolio_positions
      `);

      const s = stats.rows[0];
      const total = Number(s.wins ?? 0) + Number(s.losses ?? 0);
      res.json({
        positions: rows,
        stats: {
          open: Number(s.open_count),
          closed: Number(s.closed_count),
          realized_pnl: Number(s.realized_pnl ?? 0),
          win_rate: total > 0 ? Math.round((Number(s.wins) / total) * 100) : 0,
          wins: Number(s.wins ?? 0),
          losses: Number(s.losses ?? 0)
        }
      });
    });
  });

  app.post('/portfolio', async (req: Request, res: Response) => {
    await safeRes(res, async () => {
      const { mint, entry_price, take_profit_1, take_profit_2, stop_loss, position_size } = req.body;
      if (!mint || !entry_price || !position_size) return res.status(400).json({ error: 'mint, entry_price and position_size are required' });
      const token = await query('SELECT id FROM tokens WHERE mint_address = $1', [mint]);
      if (!token.rows.length) return res.status(404).json({ error: 'Token not found' });
      const position = await query(
        `INSERT INTO portfolio_positions (token_id, entry_price, take_profit_1, take_profit_2, stop_loss, position_size)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [token.rows[0].id, entry_price, take_profit_1 || null, take_profit_2 || null, stop_loss || null, position_size]
      );
      await query('INSERT INTO portfolio_logs (position_id, action, details) VALUES ($1, $2, $3)', [position.rows[0].id, 'created', JSON.stringify({ entry_price, position_size })]);
      res.json({ position: position.rows[0] });
    });
  });

  app.patch('/portfolio/:id', async (req: Request, res: Response) => {
    await safeRes(res, async () => {
      const { id } = req.params;
      const allowed = ['take_profit_1', 'take_profit_2', 'stop_loss', 'position_size', 'status', 'current_price'];
      const keys = Object.keys(req.body).filter((k) => allowed.includes(k));
      if (!keys.length) return res.status(400).json({ error: 'No valid fields to update' });
      const sets = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
      const values = [...keys.map((k) => req.body[k]), id];
      const result = await query(`UPDATE portfolio_positions SET ${sets}, updated_at = now() WHERE id = $${keys.length + 1} RETURNING *`, values);
      if (!result.rows.length) return res.status(404).json({ error: 'Position not found' });
      await query('INSERT INTO portfolio_logs (position_id, action, details) VALUES ($1,$2,$3)', [id, 'updated', JSON.stringify(req.body)]);
      res.json({ position: result.rows[0] });
    });
  });

  app.delete('/portfolio/:id', async (req: Request, res: Response) => {
    await safeRes(res, async () => {
      const { id } = req.params;
      const result = await query(`UPDATE portfolio_positions SET status = 'closed', updated_at = now() WHERE id = $1 RETURNING *`, [id]);
      if (!result.rows.length) return res.status(404).json({ error: 'Position not found' });
      await query('INSERT INTO portfolio_logs (position_id, action, details) VALUES ($1,$2,$3)', [id, 'closed', JSON.stringify({})]);
      res.json({ position: result.rows[0] });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // RISK / SIGNALS / ALERTS
  // ═══════════════════════════════════════════════════════════════════════════

  app.get('/risk/:mint', async (req: Request, res: Response) => {
    await safeRes(res, async () => {
      const { mint } = req.params;
      const token = await query('SELECT * FROM tokens WHERE mint_address = $1', [mint]);
      if (!token.rows.length) return res.status(404).json({ error: 'Token not found' });
      const history = await query('SELECT * FROM score_history WHERE token_id = $1 ORDER BY created_at DESC LIMIT 10', [token.rows[0].id]);
      res.json({ token: token.rows[0], riskHistory: history.rows });
    });
  });

  app.get('/signals', async (_req, res: Response) => {
    await safeRes(res, async () => {
      const { rows } = await query('SELECT * FROM alerts WHERE resolved = false ORDER BY created_at DESC LIMIT 50');
      res.json({ signals: rows });
    });
  });

  app.get('/alerts', async (req: Request, res: Response) => {
    await safeRes(res, async () => {
      const { type, mint, limit } = req.query;
      let sql = 'SELECT * FROM alerts';
      const params: unknown[] = [];
      const where: string[] = [];
      if (type) { params.push(type); where.push(`type = $${params.length}`); }
      if (mint) { params.push(mint); where.push(`subject = $${params.length}`); }
      if (where.length) sql += ' WHERE ' + where.join(' AND ');
      sql += ` ORDER BY created_at DESC LIMIT ${Math.min(Number(limit ?? 50), 200)}`;
      const { rows } = await query(sql, params);
      res.json({ alerts: rows });
    });
  });

  app.patch('/alerts/:id/resolve', async (req: Request, res: Response) => {
    await safeRes(res, async () => {
      const { id } = req.params;
      await query('UPDATE alerts SET resolved = true WHERE id = $1', [id]);
      res.json({ success: true });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // WHALE TRACKER (Sprint 6)
  // ═══════════════════════════════════════════════════════════════════════════

  app.get('/whales', async (req: Request, res: Response) => {
    await safeRes(res, async () => {
      const limit = Math.min(Number(req.query.limit ?? 20), 100);
      const { rows } = await query(`
        SELECT w.address, w.label, ws.whale_score, ws.buy_count, ws.sell_count,
               ws.win_rate, ws.roi, ws.pnl, ws.largest_trade, ws.last_scored
        FROM whale_scores ws
        JOIN wallets w ON w.id = ws.wallet_id
        ORDER BY ws.whale_score DESC
        LIMIT $1
      `, [limit]);
      res.json({ whales: rows });
    });
  });

  app.get('/whales/:address', async (req: Request, res: Response) => {
    await safeRes(res, async () => {
      const { address } = req.params;
      const { rows } = await query(`
        SELECT w.*, ws.whale_score, ws.buy_count, ws.sell_count, ws.win_rate,
               ws.roi, ws.pnl, ws.largest_trade
        FROM wallets w
        LEFT JOIN whale_scores ws ON ws.wallet_id = w.id
        WHERE w.address = $1
      `, [address]);
      if (!rows.length) return res.status(404).json({ error: 'Wallet not found' });
      const positions = await query(`
        SELECT wp.*, t.symbol, t.mint_address
        FROM wallet_positions wp
        LEFT JOIN tokens t ON t.id = wp.token_id
        JOIN wallets ww ON ww.id = wp.wallet_id
        WHERE ww.address = $1 ORDER BY wp.opened_at DESC LIMIT 20
      `, [address]);
      res.json({ wallet: rows[0], positions: positions.rows });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // SMART MONEY (Sprint 7)
  // ═══════════════════════════════════════════════════════════════════════════

  app.get('/smart-money', async (req: Request, res: Response) => {
    await safeRes(res, async () => {
      const limit = Math.min(Number(req.query.limit ?? 20), 100);
      const { rows } = await query(`
        SELECT w.address, w.label, sm.smart_money_score, sm.roi, sm.win_rate,
               sm.total_trades, sm.explanation, sm.qualified_at
        FROM smart_wallets sm
        JOIN wallets w ON w.id = sm.wallet_id
        ORDER BY sm.smart_money_score DESC
        LIMIT $1
      `, [limit]);
      res.json({ smartWallets: rows });
    });
  });

  app.get('/smart-money/signals/:mint', async (req: Request, res: Response) => {
    await safeRes(res, async () => {
      const { mint } = req.params;
      const { rows } = await query(`
        SELECT sms.*, w.address AS wallet_address
        FROM smart_money_token_signals sms
        JOIN smart_wallets sw ON sw.id = sms.smart_wallet_id
        JOIN wallets w ON w.id = sw.wallet_id
        JOIN tokens t ON t.id = sms.token_id
        WHERE t.mint_address = $1
        ORDER BY sms.created_at DESC LIMIT 20
      `, [mint]);
      res.json({ signals: rows });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // AUTO-BUY (Sprint 2 + improved ticker search)
  // ═══════════════════════════════════════════════════════════════════════════

  app.get('/autobuy', async (_req, res: Response) => {
    await safeRes(res, async () => {
      const { rows } = await query(`SELECT * FROM autobuy_jobs ORDER BY created_at DESC`);
      res.json({ jobs: rows });
    });
  });

  app.post('/autobuy', async (req: Request, res: Response) => {
    await safeRes(res, async () => {
      const { mint_address, ticker, amount_sol, interval_seconds, label, slippage_bps, wallet_address } = req.body;

      // Subscription gate — wallet_address required and must have active sub
      if (!wallet_address || typeof wallet_address !== 'string') {
        return res.status(400).json({ error: 'wallet_address is required' });
      }
      if (!isValidMint(wallet_address)) {
        return res.status(400).json({ error: 'Invalid wallet_address' });
      }
      const subscribed = await hasActiveSubscription(wallet_address);
      if (!subscribed) {
        return res.status(403).json({ error: 'Active subscription required to use autobuy' });
      }

      // Resolve mint from ticker if provided instead of address
      let resolvedMint = mint_address as string | undefined;
      if (!resolvedMint && ticker) {
        const found = await query<{ mint_address: string }>(
          `SELECT mint_address FROM tokens WHERE LOWER(symbol) = LOWER($1) ORDER BY last_updated DESC LIMIT 1`,
          [ticker]
        );
        if (found.rows.length) resolvedMint = found.rows[0].mint_address;
        else return res.status(404).json({ error: `Token with ticker "${ticker}" not found` });
      }

      if (!resolvedMint || !amount_sol || !interval_seconds) {
        return res.status(400).json({ error: 'mint_address (or ticker), amount_sol and interval_seconds are required' });
      }
      if (!isValidMint(resolvedMint)) return res.status(400).json({ error: 'Invalid mint_address' });
      if (Number(amount_sol) <= 0) return res.status(400).json({ error: 'amount_sol must be > 0' });
      if (Number(interval_seconds) < 60) return res.status(400).json({ error: 'interval_seconds must be >= 60' });

      const { rows } = await query(
        `INSERT INTO autobuy_jobs (mint_address, label, amount_sol, slippage_bps, interval_seconds, wallet_address)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [resolvedMint, label || null, Number(amount_sol), Number(slippage_bps ?? 100), Number(interval_seconds), wallet_address]
      );
      res.status(201).json({ job: rows[0] });
    });
  });

  app.patch('/autobuy/:id', async (req: Request, res: Response) => {
    await safeRes(res, async () => {
      const { id } = req.params;
      const allowed = ['amount_sol', 'interval_seconds', 'slippage_bps', 'active', 'label', 'next_run_at'];
      const keys = Object.keys(req.body).filter((k) => allowed.includes(k));
      if (!keys.length) return res.status(400).json({ error: 'No valid fields to update' });
      if (req.body.interval_seconds !== undefined && Number(req.body.interval_seconds) < 60) return res.status(400).json({ error: 'interval_seconds must be >= 60' });
      const sets = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
      const values = [...keys.map((k) => req.body[k]), id];
      const { rows } = await query(`UPDATE autobuy_jobs SET ${sets} WHERE id = $${keys.length + 1} RETURNING *`, values);
      if (!rows.length) return res.status(404).json({ error: 'Job not found' });
      res.json({ job: rows[0] });
    });
  });

  app.delete('/autobuy/:id', async (req: Request, res: Response) => {
    await safeRes(res, async () => {
      const { id } = req.params;
      const { rows } = await query(`UPDATE autobuy_jobs SET active = false WHERE id = $1 RETURNING id`, [id]);
      if (!rows.length) return res.status(404).json({ error: 'Job not found' });
      res.json({ success: true });
    });
  });

  app.get('/autobuy/:id', async (req: Request, res: Response) => {
    await safeRes(res, async () => {
      const { id } = req.params;
      const { rows } = await query(`SELECT * FROM autobuy_jobs WHERE id = $1`, [id]);
      if (!rows.length) return res.status(404).json({ error: 'Job not found' });
      res.json({ job: rows[0] });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // GAD AI TERMINAL (Sprint 10)
  // ═══════════════════════════════════════════════════════════════════════════

  /** Full AI analysis report for a token — no payment required for Telegram */
  app.get('/terminal/analyze/:mint', async (req: Request, res: Response) => {
    await safeRes(res, async () => {
      const { mint } = req.params;

      const tokenQ = await query(`SELECT * FROM tokens WHERE mint_address = $1`, [mint]);
      if (!tokenQ.rows.length) return res.status(404).json({ error: 'Token not found' });
      const token = tokenQ.rows[0];

      const [latestScore, metrics, activeAlerts, whales, smartSignals] = await Promise.all([
        query(`SELECT * FROM score_history WHERE token_id = $1 ORDER BY created_at DESC LIMIT 1`, [token.id]),
        query(`SELECT * FROM token_metrics WHERE token_id = $1 ORDER BY timestamp DESC LIMIT 1`, [token.id]),
        query(`SELECT * FROM alerts WHERE subject = $1 AND resolved = false ORDER BY created_at DESC LIMIT 5`, [mint]),
        query(`
          SELECT ws.whale_score, ws.buy_count, ws.sell_count, w.address
          FROM whale_scores ws JOIN wallets w ON w.id = ws.wallet_id
          WHERE ws.whale_score >= 60 ORDER BY ws.whale_score DESC LIMIT 5
        `),
        query(`
          SELECT sms.signal_type, sms.boost_applied, sms.explanation, w.address
          FROM smart_money_token_signals sms
          JOIN smart_wallets sw ON sw.id = sms.smart_wallet_id
          JOIN wallets w ON w.id = sw.wallet_id
          WHERE sms.token_id = $1 ORDER BY sms.created_at DESC LIMIT 5
        `, [token.id])
      ]);

      const score = latestScore.rows[0] ?? {};
      const metric = metrics.rows[0] ?? {};
      const aiScore = Number(score.ai_score ?? 0);
      const riskScore = Number(score.risk_score ?? 0);
      const growthScore = Number(score.growth_score ?? 0);
      const momentumScore = Number(score.momentum_score ?? 0);
      const liquidityScore = Number(score.liquidity_score ?? 0);

      // ─── Build narrative ────────────────────────────────────────────────
      const summary = buildSummary(aiScore, riskScore, token.symbol);
      const bullCase = buildBullCase({ aiScore, growthScore, momentumScore, liquidityScore, smartSignals: smartSignals.rows });
      const bearCase = buildBearCase({ riskScore, activeAlerts: activeAlerts.rows, metric });
      const riskLevel = riskScore >= 70 ? 'HIGH' : riskScore >= 40 ? 'MEDIUM' : 'LOW';
      const recommendation = buildRecommendation(aiScore, riskScore);

      res.json({
        token: { symbol: token.symbol, mint_address: token.mint_address, market_cap: token.market_cap, holder_count: token.holder_count },
        summary,
        bullCase,
        bearCase,
        riskLevel,
        aiScore,
        riskScore,
        scores: {
          growth: growthScore,
          liquidity: liquidityScore,
          momentum: momentumScore,
          volume: Number(score.volume_score ?? 0),
          holder: Number(score.holder_score ?? 0)
        },
        recommendation,
        activeAlerts: activeAlerts.rows.map((a: any) => ({ type: a.type, score: a.score })),
        smartMoneySignals: smartSignals.rows,
        whales: whales.rows
      });
    });
  });

  /** Verify SOL payment and create terminal session */
  app.post('/terminal/verify', async (req: Request, res: Response) => {
    await safeRes(res, async () => {
      const { payer_wallet, tx_signature } = req.body;
      if (!payer_wallet || !tx_signature) return res.status(400).json({ error: 'payer_wallet and tx_signature are required' });

      // For now, trust the tx signature (production: verify on-chain via Solana RPC)
      const { rows } = await query(
        `INSERT INTO terminal_sessions (payer_wallet, tx_signature, verified)
         VALUES ($1,$2,true) ON CONFLICT (tx_signature) DO UPDATE SET verified = true RETURNING *`,
        [payer_wallet, tx_signature]
      );
      res.json({ session: rows[0] });
    });
  });

  app.get('/health', (_req, res: Response) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // GAD INTELLIGENCE SCORES (Sprint 12)
  // ═══════════════════════════════════════════════════════════════════════════

  /** GET /gad/:mint — full GAD Score + all intelligence breakdown */
  app.get('/gad/:mint', async (req: Request, res: Response) => {
    await safeRes(res, async () => {
      const { mint } = req.params;
      const tokenQ = await query('SELECT * FROM tokens WHERE mint_address = $1', [mint]);
      if (!tokenQ.rows.length) return res.status(404).json({ error: 'Token not found' });
      const token = tokenQ.rows[0];

      const [gad, narrative, social, rug, survival, dnaBreakdown] = await Promise.all([
        query('SELECT * FROM gad_scores WHERE token_id = $1 ORDER BY computed_at DESC LIMIT 1', [token.id]),
        query('SELECT * FROM narrative_scores WHERE token_id = $1 ORDER BY created_at DESC LIMIT 1', [token.id]),
        query('SELECT * FROM social_metrics WHERE token_id = $1 ORDER BY snapshot_at DESC LIMIT 1', [token.id]),
        query('SELECT * FROM rug_scores WHERE token_id = $1 ORDER BY checked_at DESC LIMIT 1', [token.id]),
        query('SELECT * FROM survival_scores WHERE token_id = $1 ORDER BY computed_at DESC LIMIT 1', [token.id]),
        query('SELECT * FROM token_dna_breakdown WHERE token_id = $1 ORDER BY pct DESC', [token.id]),
      ]);

      res.json({
        token: { symbol: token.symbol, mint_address: token.mint_address },
        gadScore:      gad.rows[0] ?? null,
        narrative:     narrative.rows[0] ?? null,
        social:        social.rows[0] ?? null,
        rug:           rug.rows[0] ?? null,
        survival:      survival.rows[0] ?? null,
        dnaBreakdown:  dnaBreakdown.rows
      });
    });
  });

  /** GET /gad/leaderboard — top tokens by GAD Score */
  app.get('/gad-leaderboard', async (req: Request, res: Response) => {
    await safeRes(res, async () => {
      const limit = Math.min(Number(req.query.limit ?? 20), 100);
      const { rows } = await query(`
        SELECT t.symbol, t.mint_address, t.market_cap, t.holder_count,
               g.gad_score, g.ai_score, g.narrative_score, g.hype_score,
               g.whale_score, g.risk_score, g.survival_score, g.rug_probability,
               g.explanation, g.computed_at
        FROM gad_scores g
        JOIN tokens t ON t.id = g.token_id
        ORDER BY g.gad_score DESC
        LIMIT $1
      `, [limit]);
      res.json({ tokens: rows });
    });
  });

  /** GET /narratives — trending narratives */
  app.get('/narratives', async (_req, res: Response) => {
    await safeRes(res, async () => {
      const [trending, scores] = await Promise.all([
        query('SELECT * FROM trending_narratives ORDER BY strength DESC'),
        query(`
          SELECT n.narrative_tag, AVG(n.narrative_score) AS avg_score, COUNT(*) AS token_count
          FROM narrative_scores n
          GROUP BY n.narrative_tag ORDER BY avg_score DESC LIMIT 20
        `)
      ]);
      res.json({ trending: trending.rows, breakdown: scores.rows });
    });
  });
}

// ─── GAD AI narrative builders ────────────────────────────────────────────────

function buildSummary(aiScore: number, riskScore: number, symbol?: string): string {
  const tok = symbol ?? 'Token';
  if (aiScore >= 80 && riskScore < 40) return `${tok} shows strong fundamentals with high AI score (${aiScore}) and controlled risk. Excellent setup.`;
  if (aiScore >= 60 && riskScore < 60) return `${tok} has moderate positive signals. AI score ${aiScore} indicates growing momentum.`;
  if (riskScore >= 70) return `${tok} carries HIGH risk (${riskScore}). Whale exits and low liquidity detected. Proceed with caution.`;
  return `${tok} is neutral. AI score ${aiScore}, risk ${riskScore}. No strong directional signal yet.`;
}

function buildBullCase(ctx: { aiScore: number; growthScore: number; momentumScore: number; liquidityScore: number; smartSignals: any[] }): string[] {
  const points: string[] = [];
  if (ctx.aiScore >= 70) points.push(`AI Score ${ctx.aiScore}/100 — system rates this token highly.`);
  if (ctx.growthScore >= 60) points.push(`Growth score ${ctx.growthScore} — positive price trajectory.`);
  if (ctx.momentumScore >= 60) points.push(`Momentum score ${ctx.momentumScore} — buying pressure increasing.`);
  if (ctx.liquidityScore >= 60) points.push(`Healthy liquidity (${ctx.liquidityScore}) reduces slippage risk.`);
  if (ctx.smartSignals.length > 0) points.push(`${ctx.smartSignals.length} Smart Money wallet(s) entered this token recently.`);
  return points.length ? points : ['No strong bull signals detected at this time.'];
}

function buildBearCase(ctx: { riskScore: number; activeAlerts: any[]; metric: any }): string[] {
  const points: string[] = [];
  if (ctx.riskScore >= 70) points.push(`Risk score is CRITICAL (${ctx.riskScore}/100).`);
  else if (ctx.riskScore >= 40) points.push(`Risk score elevated (${ctx.riskScore}/100) — monitor closely.`);
  const liquidityAlert = ctx.activeAlerts.find((a: any) => a.type === 'LIQUIDITY_DROP');
  if (liquidityAlert) points.push(`Liquidity drop detected (alert score ${liquidityAlert.score}).`);
  const whaleAlert = ctx.activeAlerts.find((a: any) => a.type === 'WHALE_ACTIVITY');
  if (whaleAlert) points.push(`Whale activity alert triggered — large wallets may be exiting.`);
  const liqChange = Number(ctx.metric?.liquidity_change ?? 0);
  if (liqChange < -15) points.push(`Recent liquidity declined ${Math.abs(liqChange).toFixed(1)}%.`);
  return points.length ? points : ['No significant bear signals identified.'];
}

function buildRecommendation(aiScore: number, riskScore: number): string {
  if (aiScore >= 80 && riskScore < 40) return 'STRONG BUY — High AI score with manageable risk.';
  if (aiScore >= 65 && riskScore < 55) return 'BUY — Good signal with acceptable risk level.';
  if (aiScore >= 50 && riskScore < 70) return 'WATCH — Moderate signal. Wait for confirmation.';
  if (riskScore >= 70) return 'AVOID — Risk score too high. Possible rug or whale exit.';
  return 'NEUTRAL — Insufficient data for strong recommendation.';
}
