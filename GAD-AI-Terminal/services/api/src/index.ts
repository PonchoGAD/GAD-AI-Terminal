import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import dotenv from 'dotenv';
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

app.listen(port, () => {
  console.log(`GAD AI API listening on port ${port}`);
  startLauncherPriceRefresh();
});
