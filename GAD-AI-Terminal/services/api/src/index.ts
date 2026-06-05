import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import dotenv from 'dotenv';
import { registerRoutes } from './routes';
import { registerSubscriptionRoutes } from './subscription.routes';
import { registerTgUserRoutes } from './tg-user.routes';

dotenv.config();

const app = express();
const port = Number(process.env.API_PORT || 4000);

app.use(cors());
app.use(bodyParser.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

registerRoutes(app);
registerSubscriptionRoutes(app);
registerTgUserRoutes(app);

app.listen(port, () => {
  console.log(`GAD AI API listening on port ${port}`);
});
