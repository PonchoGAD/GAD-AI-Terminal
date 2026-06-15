import axios from 'axios';

// Moralis Streams — WebSocket-based new pair detection for Base
// Activates only when MORALIS_API_KEY is set in .env
// Free tier: 40,000 events/month — https://moralis.io/streams/
// To get your key: moralis.io → Admin → Web3 APIs → Copy API Key

const MORALIS_API_KEY  = process.env.MORALIS_API_KEY ?? '';
// Moralis Streams REST API (api.moralis.io was deprecated — now api.moralis.com)
const MORALIS_BASE_URL = 'https://api.moralis.com';
// Moralis Web3 Data API — use for token metadata, holder data, etc.
export const MORALIS_DATA_URL = 'https://deep-index.moralis.io/api/v2.2';
// Stream webhook URL — must be publicly accessible on VPS
const WEBHOOK_URL      = process.env.MORALIS_WEBHOOK_URL ?? `http://${process.env.VPS_IP || '65.21.159.255'}:4005/base/moralis-hook`;

// New-pair callback type — same shape as BaseToken for compatibility
export interface MoralisNewPair {
  contract_address: string;
  symbol:           string;
  pair_address:     string;
  factory:          string;
  block_number:     number;
  tx_hash:          string;
}

let newPairCallback: ((pair: MoralisNewPair) => void) | null = null;

export function onNewBasePair(cb: (pair: MoralisNewPair) => void): void {
  newPairCallback = cb;
}

// Called by Express route POST /base/moralis-hook
export function handleMoralisWebhook(body: any): void {
  if (!newPairCallback) return;
  try {
    // Moralis Streams payload for PoolCreated events
    const events: any[] = body?.logs ?? [];
    for (const ev of events) {
      if (!ev.address) continue;
      const pair: MoralisNewPair = {
        contract_address: (ev.topic1 ?? '').replace('0x000000000000000000000000', '0x'),
        symbol:           'NEW',
        pair_address:     ev.address,
        factory:          ev.from ?? '',
        block_number:     Number(ev.blockNumber ?? 0),
        tx_hash:          ev.transactionHash ?? '',
      };
      if (pair.contract_address.length === 42) {
        console.info(`[moralis] New Base pair detected: ${pair.pair_address}`);
        newPairCallback(pair);
      }
    }
  } catch (e: any) {
    console.debug(`[moralis] Webhook parse error: ${e.message}`);
  }
}

// Register stream with Moralis — watches Uniswap V3 and Aerodrome PoolCreated events on Base
export async function registerMoralisStream(): Promise<void> {
  if (!MORALIS_API_KEY) {
    console.info('[moralis] MORALIS_API_KEY not set — stream disabled. Add to .env to enable real-time pair detection.');
    return;
  }

  try {
    // Check if stream already exists
    const existing = await axios.get(`${MORALIS_BASE_URL}/streams/evm`, {
      headers: { 'X-API-Key': MORALIS_API_KEY },
      timeout: 8000,
    });
    const streams: any[] = existing.data?.result ?? [];
    const alreadyExists = streams.some(s => s.webhookUrl === WEBHOOK_URL && s.chainIds?.includes('0x2105'));
    if (alreadyExists) {
      console.info('[moralis] Stream already registered — listening for new Base pairs');
      return;
    }

    // Create stream: watch Uniswap V3 Factory PoolCreated + Aerodrome Factory events
    await axios.put(
      `${MORALIS_BASE_URL}/streams/evm`,
      {
        webhookUrl:  WEBHOOK_URL,
        description: 'GAD Base new pairs',
        tag:         'gad-base-pairs',
        chainIds:    ['0x2105'], // Base mainnet
        includeNativeTxs: false,
        includeContractLogs: true,
        topic0: ['0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118'], // UniV3 PoolCreated
        address: [
          '0x33128a8fC17869897dcE68Ed026d694621f6FDfD', // Uniswap V3 Factory on Base
          '0x420DD381b31aEf6683db6B902084cB0FFECe40Da', // Aerodrome Factory
        ],
      },
      {
        headers: { 'X-API-Key': MORALIS_API_KEY, 'Content-Type': 'application/json' },
        timeout: 10000,
      }
    );
    console.info(`[moralis] ✅ Stream registered — webhook: ${WEBHOOK_URL}`);
  } catch (e: any) {
    console.warn(`[moralis] Stream registration failed: ${e.response?.data?.message ?? e.message}`);
  }
}
