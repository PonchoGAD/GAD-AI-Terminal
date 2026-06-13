/**
 * Simple HTTP API for the futures service.
 * Exposed on FUTURES_API_PORT (default 4003).
 * Telegram bot calls these endpoints instead of direct imports.
 */

import express from 'express';
import { getMacroState, formatMacroReport } from './macro-monitor';
import { getSignal, formatSignalReport } from './entry-strategy';
import { getCapitalState, formatCapitalReport } from './capital-manager';
import { getOpenPositions, getRecentTrades, closePosition, LIVE_MODE } from './drift-trader';
import { query } from '@lib/db';
import axios from 'axios';

const app  = express();
const PORT = parseInt(process.env.FUTURES_API_PORT || '4003', 10);

app.use(express.json());

// GET /macro
app.get('/macro', async (_req, res) => {
  try {
    const macro = await getMacroState();
    res.json({ ...macro, formatted: formatMacroReport(macro) });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// GET /signal
app.get('/signal', async (_req, res) => {
  try {
    const signal = await getSignal();
    res.json({ ...signal, formatted: formatSignalReport(signal) });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// GET /capital
app.get('/capital', async (_req, res) => {
  try {
    const capital = await getCapitalState();
    res.json({ ...capital, formatted: formatCapitalReport(capital) });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// GET /positions
app.get('/positions', async (_req, res) => {
  try {
    const positions = await getOpenPositions();
    res.json({ positions, mode: LIVE_MODE });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// GET /trades?limit=10
app.get('/trades', async (req, res) => {
  try {
    const limit = parseInt(String(req.query.limit || '10'), 10);
    const trades = await getRecentTrades(limit);
    res.json({ trades });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// POST /close  { tradeId: string }
app.post('/close', async (req, res) => {
  try {
    const { tradeId } = req.body;
    if (!tradeId) { res.status(400).json({ error: 'tradeId required' }); return; }
    const priceRes = await axios.get('https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT', { timeout: 3_000 });
    const exitPrice = parseFloat(priceRes.data.price);
    const pnl = await closePosition(tradeId, exitPrice, 'MANUAL');
    res.json({ pnl, exitPrice });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// GET /dashboard — combined snapshot for Telegram /futures command
app.get('/dashboard', async (_req, res) => {
  try {
    const [macro, signal, capital, positions] = await Promise.all([
      getMacroState(), getSignal(), getCapitalState(), getOpenPositions()
    ]);
    res.json({ macro, signal, capital, positions, mode: LIVE_MODE });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export function startApi(): void {
  app.listen(PORT, () => {
    console.log(`[futures-api] listening on port ${PORT}`);
  });
}
