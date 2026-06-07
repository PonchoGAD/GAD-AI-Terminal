import dotenv from 'dotenv';
import { startAutobuyScheduler } from './scheduler';

dotenv.config();

startAutobuyScheduler().catch((err) => {
  console.error('[autobuy] Fatal error:', err);
  process.exit(1);
});
