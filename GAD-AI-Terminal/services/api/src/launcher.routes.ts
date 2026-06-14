import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { launchToken, sellPosition, refreshPrice, listCoins } from './launcher';
import { query } from '@lib/db';

const router = Router();

const UPLOAD_DIR = path.join('/tmp', 'launcher_uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB max logo
  fileFilter: (_req, file, cb) => {
    if (/\.(png|jpg|jpeg|gif|webp)$/i.test(file.originalname)) cb(null, true);
    else cb(new Error('Only image files allowed'));
  },
});

// GET /launcher/coins — list all launched tokens
router.get('/coins', async (_req: Request, res: Response) => {
  try {
    const coins = await listCoins();
    res.json(coins);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /launcher/coins/:mint — single coin with events
router.get('/coins/:mint', async (req: Request, res: Response) => {
  try {
    const { mint } = req.params;
    const [coinRes, eventsRes] = await Promise.all([
      query<any>('SELECT * FROM launched_tokens WHERE mint_address = $1', [mint]),
      query<any>('SELECT * FROM launcher_events WHERE mint = $1 ORDER BY created_at DESC LIMIT 50', [mint]),
    ]);
    if (!coinRes.rows.length) return res.status(404).json({ error: 'Token not found' });
    res.json({ coin: coinRes.rows[0], events: eventsRes.rows });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /launcher/create — deploy new token on pump.fun
router.post('/create', upload.single('logo'), async (req: Request, res: Response) => {
  try {
    const { name, ticker, description, solBudget, website, twitter, telegram } = req.body;
    if (!name || !ticker || !description || !solBudget) {
      return res.status(400).json({ error: 'name, ticker, description, solBudget required' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'logo image required' });
    }

    const budget = parseFloat(solBudget);
    if (isNaN(budget) || budget < 0.05) {
      return res.status(400).json({ error: 'solBudget must be >= 0.05 SOL' });
    }

    const result = await launchToken({
      name: name.trim(),
      ticker: ticker.trim().toUpperCase(),
      description: description.trim(),
      logoPath: req.file.path,
      solBudget: budget,
      website: website?.trim(),
      twitter: twitter?.trim(),
      telegram: telegram?.trim(),
    });

    // Clean up temp file
    fs.unlink(req.file.path, () => {});

    if (!result.success) return res.status(400).json({ error: result.error });
    res.json({ mintAddress: result.mintAddress, txSignature: result.txSignature });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /launcher/coins/:mint/sell — sell owner's position
router.post('/coins/:mint/sell', async (req: Request, res: Response) => {
  try {
    const { mint } = req.params;
    const pct = parseInt(req.body.pct ?? '100', 10);
    if (pct < 1 || pct > 100) return res.status(400).json({ error: 'pct must be 1-100' });

    const result = await sellPosition(mint, pct);
    if (!result.success) return res.status(400).json({ error: result.error });
    res.json({ solReceived: result.solReceived });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /launcher/coins/:mint/refresh — update price from DexScreener
router.post('/coins/:mint/refresh', async (req: Request, res: Response) => {
  try {
    const price = await refreshPrice(req.params.mint);
    res.json({ priceSol: price });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /launcher/coins/:mint/events — event log for a token
router.get('/coins/:mint/events', async (req: Request, res: Response) => {
  try {
    const { rows } = await query<any>(
      'SELECT * FROM launcher_events WHERE mint = $1 ORDER BY created_at DESC LIMIT 100',
      [req.params.mint]
    );
    res.json(rows);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /launcher/submit — website form submission (JSON + base64 image)
// Creates a coin_idea in DB + notifies admin via Telegram
router.post('/submit', async (req: Request, res: Response) => {
  try {
    const { name, ticker, description, imageB64, imageName, imageType, devBuySol, w2BuySol, w3BuySol } = req.body;
    if (!name || !ticker || !description) {
      return res.status(400).json({ error: 'name, ticker, description required' });
    }
    if (!imageB64) {
      return res.status(400).json({ error: 'logo image required' });
    }
    if (ticker.length > 8) {
      return res.status(400).json({ error: 'ticker max 8 chars' });
    }

    // Save to coin_ideas table (pending review)
    const { rows } = await query<any>(`
      INSERT INTO coin_ideas (ticker, name, description, meme_angle, status, score)
      VALUES ($1, $2, $3, $4, 'pending', 50)
      RETURNING id
    `, [
      ticker.toUpperCase().slice(0, 8),
      name.slice(0, 100),
      description.slice(0, 500),
      JSON.stringify({ imageB64, imageName, imageType, devBuySol, w2BuySol, w3BuySol }),
    ]);

    const ideaId = rows[0].id;

    // Notify admin via Telegram
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const adminId  = process.env.TELEGRAM_ADMIN_CHAT_ID;
    if (botToken && adminId) {
      const msg =
        `🆕 *New Token Submission from Website*\n\n` +
        `*${ticker.toUpperCase()}* — ${name}\n` +
        `"${description.slice(0, 150)}..."\n\n` +
        `Dev: ${devBuySol} SOL | W2: ${w2BuySol} SOL | W3: ${w3BuySol} SOL\n\n` +
        `Launch: \`/auto_launch ${ideaId}\``;
      fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: adminId, text: msg, parse_mode: 'Markdown' }),
      }).catch(() => {});
    }

    console.info(`[launcher] New submission: ${ticker} — ${name} (id: ${ideaId})`);
    res.json({ ok: true, id: ideaId, message: 'Submitted! Admin will review and launch shortly.' });

  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
