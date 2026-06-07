import { Collector, runCollectors } from './scanner';
import { discoverPumpTokens, fetchPumpMetrics } from './pump.collector';
import { discoverGmgnTokens, fetchGmgnMetrics } from './gmgn.collector';
import { discoverAxiomTokens, fetchAxiomMetrics } from './axiom.collector';
import { discoverHeliusTokens, fetchHeliusMetrics } from './helius.collector';
import { discoverDexScreenerTokens, fetchDexScreenerMetrics } from './dexscreener.collector';
import { discoverGeckoTerminalTokens, fetchGeckoTerminalMetrics } from './geckoterminal.collector';
import {
  discoverPumpPortalTokens,
  fetchPumpPortalMetrics,
  getPumpPortalMetadata,
  startPumpPortalListener
} from './pumpportal.collector';
import { updateMarketRegime } from './regime.updater';
import { processToken } from './scanner';

const intervalMs = Number(process.env.SCANNER_INTERVAL_SECONDS || '30') * 1000;
const REGIME_INTERVAL_MS = 5 * 60 * 1000;

// ─── Circuit Breaker ─────────────────────────────────────────────────────────
const CIRCUIT_FAIL_THRESHOLD = 3;
const CIRCUIT_COOLDOWN_MS    = 10 * 60 * 1000; // 10 minutes
const BLOCKED_STATUS_CODES   = new Set([403, 429, 530]);

interface CircuitState {
  failures:     number;
  disabledUntil: number; // epoch ms, 0 = enabled
}

const circuitBreakers = new Map<string, CircuitState>();

function getCircuit(source: string): CircuitState {
  if (!circuitBreakers.has(source)) circuitBreakers.set(source, { failures: 0, disabledUntil: 0 });
  return circuitBreakers.get(source)!;
}

function isCircuitOpen(source: string): boolean {
  const c = getCircuit(source);
  if (c.disabledUntil > Date.now()) return true;
  if (c.disabledUntil > 0) {
    // cooldown expired — reset
    c.failures = 0;
    c.disabledUntil = 0;
    console.info(`[circuit] ${source} re-enabled after cooldown`);
  }
  return false;
}

function recordFailure(source: string, statusCode?: number): void {
  if (!statusCode || !BLOCKED_STATUS_CODES.has(statusCode)) return;
  const c = getCircuit(source);
  c.failures += 1;
  if (c.failures >= CIRCUIT_FAIL_THRESHOLD) {
    c.disabledUntil = Date.now() + CIRCUIT_COOLDOWN_MS;
    console.warn(`[circuit] ${source} DISABLED for 10min (${statusCode} ×${c.failures})`);
  }
}

function recordSuccess(source: string): void {
  const c = getCircuit(source);
  if (c.failures > 0) c.failures = 0;
}

/** Wraps a collector's discoverNewTokens with circuit breaker logic */
function withCircuitBreaker<T extends string>(
  source: T,
  fn: () => Promise<string[]>
): () => Promise<string[]> {
  return async () => {
    if (isCircuitOpen(source)) {
      const c = getCircuit(source);
      const remaining = Math.ceil((c.disabledUntil - Date.now()) / 60_000);
      console.info(`[circuit] ${source} skipped — disabled for ${remaining}min`);
      return [];
    }
    try {
      const result = await fn();
      recordSuccess(source);
      return result;
    } catch (err: any) {
      const msgMatch = String(err?.message ?? '').match(/\b(403|429|530)\b/);
      const code = err?.response?.status ?? err?.status ?? (msgMatch ? Number(msgMatch[1]) : undefined);
      recordFailure(source, code);
      throw err;
    }
  };
}

// Primary collectors (reliable, always on)
const primaryCollectors: Collector[] = [
  {
    source: 'geckoterminal',
    discoverNewTokens: withCircuitBreaker('geckoterminal', discoverGeckoTerminalTokens),
    fetchTokenMetrics: fetchGeckoTerminalMetrics,
  },
  {
    source: 'dexscreener',
    discoverNewTokens: withCircuitBreaker('dexscreener', discoverDexScreenerTokens),
    fetchTokenMetrics: fetchDexScreenerMetrics,
  },
  {
    source: 'helius',
    discoverNewTokens: withCircuitBreaker('helius', discoverHeliusTokens),
    fetchTokenMetrics: fetchHeliusMetrics,
  },
];

// Optional collectors — blocked frequently, run only if not circuit-tripped
const optionalCollectors: Collector[] = [
  {
    source: 'pump.fun',
    discoverNewTokens: withCircuitBreaker('pump.fun', discoverPumpTokens),
    fetchTokenMetrics: fetchPumpMetrics,
  },
  ...(process.env.GMGN_API_KEY ? [{
    source: 'gmgn',
    discoverNewTokens: withCircuitBreaker('gmgn', discoverGmgnTokens),
    fetchTokenMetrics: fetchGmgnMetrics,
  }] : []),
  {
    source: 'axiom',
    discoverNewTokens: withCircuitBreaker('axiom', discoverAxiomTokens),
    fetchTokenMetrics: fetchAxiomMetrics,
  },
];

// All secondary collectors combined
const secondaryCollectors: Collector[] = [...primaryCollectors, ...optionalCollectors];

/** Process PumpPortal tokens first — they come with name/symbol/metadata */
async function runPumpPortalCycle(): Promise<void> {
  try {
    const mints = await discoverPumpPortalTokens();
    if (!mints.length) return;
    console.info(`[pumpportal] Processing ${mints.length} new pump.fun tokens`);
    for (const mint of mints) {
      try {
        const meta = getPumpPortalMetadata(mint);
        const metrics = await fetchPumpPortalMetrics(mint);
        await processToken('pumpportal', mint, metrics, {
          name:   meta.name,
          symbol: meta.symbol,
        });
      } catch (err: any) {
        console.warn(`[pumpportal] token ${mint} failed:`, err.message);
      }
    }
  } catch (err: any) {
    console.warn('[pumpportal] cycle error:', err.message);
  }
}

export async function startScanner() {
  console.info(`Scanner started. Running every ${intervalMs / 1000}s.`);

  // Start PumpPortal WebSocket (persistent connection for real-time pump.fun feed)
  startPumpPortalListener();

  let shouldStop = false;
  process.on('SIGINT',  () => { shouldStop = true; });
  process.on('SIGTERM', () => { shouldStop = true; });

  updateMarketRegime().catch(err => console.error('[regime] Initial update failed:', err));
  const regimeTimer = setInterval(() => {
    updateMarketRegime().catch(err => console.error('[regime] Update failed:', err));
  }, REGIME_INTERVAL_MS);

  while (!shouldStop) {
    try {
      // 1. PumpPortal first — real-time new launches with metadata
      await runPumpPortalCycle();
      // 2. Secondary collectors — trending/aggregated data
      await runCollectors(secondaryCollectors);
    } catch (error) {
      console.error('Scanner cycle failed:', error);
    }
    if (shouldStop) break;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  clearInterval(regimeTimer);
  console.info('Scanner shutdown complete.');
}
