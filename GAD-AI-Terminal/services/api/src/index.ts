import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import dotenv from 'dotenv';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { query } from '@lib/db';
import { registerRoutes } from './routes';
import { registerSubscriptionRoutes } from './subscription.routes';
import { registerTgUserRoutes } from './tg-user.routes';
import { startLauncherPriceRefresh } from './launcher';

dotenv.config();

const app = express();
const port = Number(process.env.API_PORT || 4000);

app.use(cors());
app.use(bodyParser.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// FTE token metadata — static endpoint for pump.fun launch
app.get('/fte-metadata', (_req, res) => {
  res.json({
    name: 'First Trillionaire Ever',
    symbol: 'FTE',
    description: 'Not everyone will become a trillionaire. But everyone will know who got there first.\n\nThe race to become the First Trillionaire has already begun.\nSome are building companies. Some are building rockets. Some are building AI.\nWe are building the meme.\n\n$FTE — the meme behind that race. The game has started.\n\nAmbition. Wealth. Legacy.',
    image: 'https://gadai.shop/fte-logo.png',
    showName: true,
    createdOn: 'https://pump.fun',
    website: 'https://gadai.shop',
    twitter: '',
    telegram: '',
  });
});

registerRoutes(app);
registerSubscriptionRoutes(app);
registerTgUserRoutes(app);

// ─── Polymarket proxy ─────────────────────────────────────────────────────────
const POLY_URL = process.env.POLYMARKET_API_URL || 'http://polymarket-bot:4009';
app.use('/polymarket', async (req, res) => {
  try {
    const { data, status } = await (await import('axios')).default({
      method: req.method as any,
      url: `${POLY_URL}${req.path}`,
      params: req.query,
      data: req.body,
      timeout: 10000,
    });
    res.status(status).json(data);
  } catch (e: any) {
    res.status(e.response?.status ?? 502).json({ error: e.message });
  }
});

// ─── HTTP server + WebSocket ──────────────────────────────────────────────────

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

export function broadcastUpdate(event: string, data: unknown): void {
  const msg = JSON.stringify({ event, data, ts: Date.now() });
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  });
}

// Push live trade data to dashboard clients every 5 seconds
async function broadcastLiveState(): Promise<void> {
  if (wss.clients.size === 0) return;
  try {
    const [posRes, soldRes, statsRes] = await Promise.all([
      query<any>(`
        SELECT mint_address, label, amount_sol, bought_at, last_activity_at,
               total_spent_sol, total_sold_sol
        FROM autobuy_jobs
        WHERE active = true AND label LIKE 'auto:%'
        ORDER BY bought_at DESC LIMIT 20
      `),
      query<any>(`
        SELECT mint_address, label, total_spent_sol, total_sold_sol,
               bought_at, last_activity_at
        FROM autobuy_jobs
        WHERE active = false AND label LIKE 'auto:%'
          AND last_activity_at > now() - interval '24h'
        ORDER BY last_activity_at DESC LIMIT 10
      `),
      query<any>(`
        SELECT
          (SELECT COUNT(*) FROM tokens)::int AS total_tokens,
          (SELECT COUNT(*) FROM autobuy_jobs WHERE active=true)::int AS active_positions,
          (SELECT COALESCE(SUM(total_sold_sol),0) FROM autobuy_jobs
           WHERE bought_at >= CURRENT_DATE)::float AS pnl_today_sol,
          (SELECT COALESCE(SUM(total_spent_sol),0) FROM autobuy_jobs
           WHERE bought_at >= CURRENT_DATE)::float AS spent_today_sol
      `),
    ]);
    broadcastUpdate('live_state', {
      positions:  posRes.rows,
      recentSold: soldRes.rows,
      stats:      statsRes.rows[0] ?? {},
    });
  } catch { /* ignore — DB may be momentarily busy */ }
}

wss.on('connection', (ws) => {
  console.log('[api-ws] Client connected');
  // Send current state immediately on connect
  broadcastLiveState().catch(() => {});
  ws.on('close', () => console.log('[api-ws] Client disconnected'));
});

setInterval(() => broadcastLiveState().catch(() => {}), 5_000);

server.listen(port, () => {
  console.log(`GAD AI API listening on port ${port} (WS: ws://localhost:${port}/ws)`);
  startLauncherPriceRefresh();
});
