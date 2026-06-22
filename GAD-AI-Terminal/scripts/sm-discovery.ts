/**
 * Dolphin Smart Money Discovery Script
 *
 * Standalone runner for CrossChainDolphinEngine.
 * Intended for cron execution every 12 hours on VPS.
 *
 * Usage (on VPS inside autobuy container):
 *   docker compose exec -T autobuy npx ts-node scripts/sm-discovery.ts
 *
 * Or via cron:
 *   0 *\/12 * * * cd /opt/gad-ai-terminal/GAD-AI-Terminal && \
 *     docker compose exec -T autobuy npx ts-node scripts/sm-discovery.ts \
 *     >> /var/log/dolphin-discovery.log 2>&1
 */
import 'dotenv/config';
import { CrossChainDolphinEngine } from '../libs/shared/src/cross-chain-dolphin';

(async () => {
  console.info(`[dolphin] Started at ${new Date().toISOString()}`);
  const engine = new CrossChainDolphinEngine();
  await engine.runFullDiscoveryCycle();
  console.info(`[dolphin] Finished at ${new Date().toISOString()}`);
  process.exit(0);
})().catch(err => {
  console.error('[dolphin] Fatal error:', err.message ?? err);
  process.exit(1);
});
