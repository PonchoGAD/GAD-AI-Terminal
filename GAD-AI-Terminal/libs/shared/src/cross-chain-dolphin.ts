/**
 * Cross-Chain Dolphin Engine
 *
 * Automatically discovers and ranks profitable "smart money" sniper wallets
 * across Solana, Base, BSC, and TON by:
 *   1. Finding recently successful tokens on each chain (via GeckoTerminal)
 *   2. Extracting the wallets of early buyers from those tokens
 *   3. Auditing each wallet's historical P&L
 *   4. Persisting profitable wallets to smart_money_wallets with tier/weight
 *   5. Purging dormant wallets (no activity > 5 days)
 *
 * PRODUCTION NOTE: auditSolanaWallet / auditEvmWallet / auditTonWallet are
 * currently scaffolds that return placeholder data. Implement real on-chain
 * balance parsing before enabling live copy-trading signals.
 *
 * Run schedule: every 12h via cron or ts-node scripts/sm-discovery.ts
 */
import { Connection, PublicKey } from '@solana/web3.js';
import { ethers } from 'ethers';
import axios from 'axios';
import { query } from '@lib/db';

const solanaConnection = new Connection(
  process.env.SOLANA_RPC ?? 'https://api.mainnet-beta.solana.com',
);
const baseProvider = new ethers.JsonRpcProvider(
  process.env.BASE_RPC_URL ?? 'https://mainnet.base.org',
);
const bscProvider = new ethers.JsonRpcProvider(
  process.env.BSC_RPC_URL ?? 'https://bsc-dataseed1.binance.org',
);

interface SniperProfile {
  address:       string;
  winRate:       number;   // 0.0–1.0
  netProfitUsd:  number;
  lastActiveAt:  Date;
}

export class CrossChainDolphinEngine {
  private readonly tonapiKey: string;

  constructor() {
    this.tonapiKey = process.env.TON_API_KEY ?? '';
  }

  public async runFullDiscoveryCycle(): Promise<void> {
    console.info('[dolphin] 🐬 Starting global cross-chain rotation cycle...');

    await Promise.allSettled([
      this.discoverSolanaSnipers()  .catch(e => console.error('[dolphin-sol] ', e.message)),
      this.discoverEvmSnipers('BASE', baseProvider, 'base').catch(e => console.error('[dolphin-base]', e.message)),
      this.discoverEvmSnipers('BSC',  bscProvider,  'bsc') .catch(e => console.error('[dolphin-bsc] ', e.message)),
      this.discoverTonSnipers()     .catch(e => console.error('[dolphin-ton] ', e.message)),
    ]);

    await this.purgeDormantWallets();
    console.info('[dolphin] ✅ Global rotation cycle complete.');
  }

  // ── Solana: find early buyers of recent pump.fun graduates ──────────────────

  private async discoverSolanaSnipers(): Promise<void> {
    const response = await axios.get(
      'https://api.geckoterminal.com/api/v2/networks/solana/new_pools?page=1',
      { timeout: 10_000 },
    );
    const pools: any[] = response.data?.data ?? [];

    // Focus on pump.fun-graduated tokens (pool id contains 'pump')
    const pumpPools = pools
      .filter((p: any) => (p.id ?? '').includes('pump') || (p.attributes?.name ?? '').includes('/'))
      .map((p: any) => p.attributes?.address)
      .filter(Boolean)
      .slice(0, 5);

    console.info(`[dolphin-sol] Analyzing ${pumpPools.length} graduated tokens`);
    const candidates = new Set<string>();

    for (const poolAddr of pumpPools) {
      try {
        const sigs = await solanaConnection.getSignaturesForAddress(
          new PublicKey(poolAddr), { limit: 50 },
        );
        // Oldest first — earliest buyers at pool creation = best snipers
        for (const sig of sigs.reverse().slice(0, 20)) {
          const tx = await solanaConnection.getParsedTransaction(sig.signature, {
            maxSupportedTransactionVersion: 0,
          });
          const signer = tx?.transaction.message.accountKeys
            .find((acc: any) => acc.signer)?.pubkey?.toBase58();
          if (signer && signer !== poolAddr) candidates.add(signer);
        }
      } catch { /* skip unreadable pool */ }
    }

    console.info(`[dolphin-sol] Auditing ${candidates.size} candidate wallets`);
    for (const addr of candidates) {
      const audit = await this.auditSolanaWallet(addr);
      if (audit) await this.saveWalletToDb('SOLANA', audit);
    }
  }

  // ── EVM (Base / BSC): find early swap traders in new pools ─────────────────

  private async discoverEvmSnipers(
    chain: 'BASE' | 'BSC',
    provider: ethers.JsonRpcProvider,
    networkSlug: string,
  ): Promise<void> {
    const response = await axios.get(
      `https://api.geckoterminal.com/api/v2/networks/${networkSlug}/new_pools?page=1`,
      { timeout: 10_000 },
    );
    const pools: any[] = response.data?.data ?? [];
    const targetPools = pools.slice(0, 3).map((p: any) => p.attributes?.address).filter(Boolean);

    const swapAbi = [
      'event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)',
    ];

    const candidates = new Set<string>();
    const latestBlock = await provider.getBlockNumber();

    for (const poolAddress of targetPools) {
      try {
        const contract = new ethers.Contract(poolAddress, swapAbi, provider);
        const logs = await contract.queryFilter(
          contract.filters.Swap(), latestBlock - 500, latestBlock,
        );
        for (const log of logs.slice(0, 20)) {
          const recipient = (log as any).args?.recipient;
          if (recipient) candidates.add(recipient.toLowerCase());
        }
      } catch { /* skip unparseable pool */ }
    }

    console.info(`[dolphin-${networkSlug}] Auditing ${candidates.size} candidate wallets`);
    for (const addr of candidates) {
      const audit = await this.auditEvmWallet(chain, provider, addr);
      if (audit) await this.saveWalletToDb(chain, audit);
    }
  }

  // ── TON: find early traders via TonAPI ──────────────────────────────────────

  private async discoverTonSnipers(): Promise<void> {
    if (!this.tonapiKey) {
      console.info('[dolphin-ton] TON_API_KEY not set — skip');
      return;
    }
    const response = await axios.get(
      'https://api.geckoterminal.com/api/v2/networks/ton/new_pools?page=1',
      { timeout: 10_000 },
    );
    const pools: any[] = response.data?.data ?? [];
    const targetPools = pools.slice(0, 3).map((p: any) => p.attributes?.address).filter(Boolean);

    const candidates = new Set<string>();
    for (const pool of targetPools) {
      try {
        const r = await axios.get(
          `https://tonapi.io/v2/blockchain/accounts/${pool}/transactions?limit=30`,
          { headers: { Authorization: `Bearer ${this.tonapiKey}` }, timeout: 6_000 },
        );
        for (const tx of r.data?.transactions ?? []) {
          const sender = tx.in_msg?.source?.address;
          if (sender) candidates.add(sender);
        }
      } catch { /* skip */ }
    }

    console.info(`[dolphin-ton] Auditing ${candidates.size} candidate wallets`);
    for (const addr of candidates) {
      const audit = await this.auditTonWallet(addr);
      if (audit) await this.saveWalletToDb('TON', audit);
    }
  }

  // ── Audit stubs ── TODO: replace with real on-chain P&L parsing ─────────────
  // Currently returns placeholder data so every wallet passes the filter.
  // In production: parse token balance deltas across last 30 txs.

  private async auditSolanaWallet(address: string): Promise<SniperProfile | null> {
    try {
      const sigs = await solanaConnection.getSignaturesForAddress(
        new PublicKey(address), { limit: 30 },
      );
      if (sigs.length < 5) return null; // too few txs — skip

      const lastActive = sigs[0]?.blockTime
        ? new Date(sigs[0].blockTime * 1000)
        : new Date();

      // TODO: parse actual win rate and profit from token balance changes
      return { address, winRate: 0.48, netProfitUsd: 1800, lastActiveAt: lastActive };
    } catch {
      return null;
    }
  }

  private async auditEvmWallet(
    _chain: string,
    provider: ethers.JsonRpcProvider,
    address: string,
  ): Promise<SniperProfile | null> {
    try {
      const txCount = await provider.getTransactionCount(address);
      if (txCount < 5) return null;

      // TODO: parse ERC-20 Transfer events and compute P&L
      return { address, winRate: 0.50, netProfitUsd: 2200, lastActiveAt: new Date() };
    } catch {
      return null;
    }
  }

  private async auditTonWallet(address: string): Promise<SniperProfile | null> {
    if (!this.tonapiKey) return null;
    try {
      const r = await axios.get(
        `https://tonapi.io/v2/accounts/${address}/events?limit=10`,
        { headers: { Authorization: `Bearer ${this.tonapiKey}` }, timeout: 5_000 },
      );
      if (!r.data?.events?.length) return null;

      // TODO: parse jetton transfer events and compute P&L
      return { address, winRate: 0.46, netProfitUsd: 1300, lastActiveAt: new Date() };
    } catch {
      return null;
    }
  }

  // ── Persist wallet to DB ─────────────────────────────────────────────────────

  private async saveWalletToDb(chain: string, profile: SniperProfile): Promise<void> {
    let rank   = 'STANDARD';
    let weight = 1.0;

    if (profile.winRate >= 0.55 && profile.netProfitUsd >= 5000) {
      rank = 'ELITE';   weight = 3.0;
    } else if (profile.winRate >= 0.45 && profile.netProfitUsd >= 2000) {
      rank = 'PROVEN';  weight = 1.5;
    }

    await query(
      `INSERT INTO smart_money_wallets
         (chain, wallet_address, wallet_rank, reliability_weight, win_rate, net_profit_usd, last_active_at, active)
       VALUES ($1, $2, $3, $4, $5, $6, NOW(), true)
       ON CONFLICT (chain, LOWER(wallet_address))
       DO UPDATE SET
         wallet_rank = EXCLUDED.wallet_rank,
         reliability_weight = EXCLUDED.reliability_weight,
         win_rate = EXCLUDED.win_rate,
         net_profit_usd = EXCLUDED.net_profit_usd,
         active = true,
         updated_at = NOW()`,
      [chain, profile.address.toLowerCase(), rank, weight, profile.winRate, profile.netProfitUsd],
    );
  }

  // ── Purge wallets with no activity in last 5 days ───────────────────────────

  private async purgeDormantWallets(): Promise<void> {
    const result = await query(
      `UPDATE smart_money_wallets
       SET active = false
       WHERE active = true AND last_active_at < NOW() - INTERVAL '5 days'`,
    );
    if ((result.rowCount ?? 0) > 0) {
      console.info(`[dolphin-purge] Deactivated ${result.rowCount} dormant wallets`);
    }
  }
}
