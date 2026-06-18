import { useEffect, useState, useCallback } from 'react';

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

// ─── Types ───────────────────────────────────────────────────────────────────

type Chain = 'solana' | 'base' | 'bsc' | 'ton';

interface Position {
  id: string;
  chain: Chain;
  symbol: string;
  amountNative: number;
  soldNative: number;
  entryPrice: number;
  pnlNative: number;
  pnlPct: number;
  isActive: boolean;
  sellStage: number;
  exitReason: string | null;
  openedAt: string;
  closedAt: string | null;
}

interface ChainSummary {
  chain: Chain;
  total: number;
  active: number;
  closed: number;
  wins: number;
  winRate: number;
  pnlNative: number;
  totalIn: number;
}

interface PortfolioData {
  positions: Position[];
  chainSummary: ChainSummary[];
  globalPnlNative: number;
  updatedAt: string;
}

// ─── Chain meta ──────────────────────────────────────────────────────────────

const CHAIN_META: Record<Chain, { label: string; color: string; bg: string; border: string; icon: string; native: string }> = {
  solana: { label: 'Solana',  color: 'text-purple-400', bg: 'bg-purple-500/10', border: 'border-purple-500/30', icon: '🟣', native: 'SOL' },
  base:   { label: 'Base',    color: 'text-blue-400',   bg: 'bg-blue-500/10',   border: 'border-blue-500/30',   icon: '🔵', native: 'ETH' },
  bsc:    { label: 'BSC',     color: 'text-yellow-400', bg: 'bg-yellow-500/10', border: 'border-yellow-500/30', icon: '🟡', native: 'BNB' },
  ton:    { label: 'TON',     color: 'text-cyan-400',   bg: 'bg-cyan-500/10',   border: 'border-cyan-500/30',   icon: '💎', native: 'TON' },
};

// ─── Sub-components ───────────────────────────────────────────────────────────

function ChainCard({ s, onClick, active }: { s: ChainSummary; onClick: () => void; active: boolean }) {
  const m = CHAIN_META[s.chain];
  const pnlSign = s.pnlNative >= 0 ? '+' : '';
  return (
    <button
      onClick={onClick}
      className={`rounded-xl p-4 border text-left w-full transition-all ${active ? `${m.bg} ${m.border}` : 'bg-[#18181f] border-[#2a2a35] hover:border-[#444]'}`}
    >
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-semibold text-white">{m.icon} {m.label}</span>
        <span className={`text-xs font-mono ${s.pnlNative >= 0 ? 'text-green-400' : 'text-red-400'}`}>
          {pnlSign}{s.pnlNative.toFixed(4)} {m.native}
        </span>
      </div>
      <div className="grid grid-cols-3 gap-1 text-xs">
        <div>
          <p className="text-gray-500">Trades</p>
          <p className="font-mono text-white">{s.total}</p>
        </div>
        <div>
          <p className="text-gray-500">Active</p>
          <p className={`font-mono ${s.active > 0 ? 'text-green-400' : 'text-gray-400'}`}>{s.active}</p>
        </div>
        <div>
          <p className="text-gray-500">Win%</p>
          <p className={`font-mono ${s.winRate >= 50 ? 'text-green-400' : s.winRate >= 25 ? 'text-yellow-400' : 'text-red-400'}`}>
            {s.winRate}%
          </p>
        </div>
      </div>
    </button>
  );
}

function PnlBadge({ pct, native, nativeLabel }: { pct: number; native: number; nativeLabel: string }) {
  const color = pct >= 0 ? 'text-green-400' : 'text-red-400';
  const sign  = pct >= 0 ? '+' : '';
  return (
    <div className="text-right">
      <p className={`font-mono text-sm font-bold ${color}`}>{sign}{pct.toFixed(1)}%</p>
      <p className={`font-mono text-xs ${color} opacity-70`}>{sign}{native.toFixed(4)} {nativeLabel}</p>
    </div>
  );
}

function StatusBadge({ pos }: { pos: Position }) {
  if (pos.isActive) return <span className="px-2 py-0.5 rounded text-xs bg-green-500/15 text-green-400 font-semibold">ACTIVE</span>;
  if (pos.exitReason) return <span className="px-2 py-0.5 rounded text-xs bg-[#2a2a35] text-gray-400">{pos.exitReason}</span>;
  return <span className="px-2 py-0.5 rounded text-xs bg-[#2a2a35] text-gray-500">CLOSED</span>;
}

function PositionRow({ pos }: { pos: Position }) {
  const m   = CHAIN_META[pos.chain];
  const won = !pos.isActive && pos.pnlNative > 0;
  const fmt = (n: number) => n.toFixed(4);
  const age = (() => {
    const ms = Date.now() - new Date(pos.openedAt).getTime();
    const h  = Math.floor(ms / 3600000);
    const m2 = Math.floor((ms % 3600000) / 60000);
    if (h > 24) return `${Math.floor(h / 24)}d`;
    if (h > 0) return `${h}h ${m2}m`;
    return `${m2}m`;
  })();

  return (
    <tr className={`border-b border-[#1e1e2a] hover:bg-white/[0.02] transition-colors ${won ? 'bg-green-500/[0.03]' : ''}`}>
      <td className="px-3 py-3">
        <div className="flex items-center gap-2">
          <span className="text-base">{m.icon}</span>
          <div>
            <p className="font-semibold text-white text-sm">{pos.symbol}</p>
            <p className="text-xs text-gray-500">{m.label}</p>
          </div>
        </div>
      </td>
      <td className="px-3 py-3 text-right">
        <p className="font-mono text-sm text-gray-300">{fmt(pos.amountNative)}</p>
        <p className="font-mono text-xs text-gray-500">{m.native}</p>
      </td>
      <td className="px-3 py-3 text-right">
        {!pos.isActive
          ? <PnlBadge pct={pos.pnlPct} native={pos.pnlNative} nativeLabel={m.native} />
          : <span className="text-xs text-gray-500">open</span>
        }
      </td>
      <td className="px-3 py-3">
        <StatusBadge pos={pos} />
      </td>
      <td className="px-3 py-3 text-right">
        <p className="text-xs text-gray-400 font-mono">{age}</p>
      </td>
    </tr>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function Unified() {
  const [data, setData]         = useState<PortfolioData | null>(null);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState<string | null>(null);
  const [chainFilter, setChain] = useState<Chain | 'all'>('all');
  const [statusFilter, setStatus] = useState<'all' | 'active' | 'closed'>('all');
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date());

  const load = useCallback(async () => {
    try {
      const r = await fetch(`${API}/unified-portfolio`);
      if (!r.ok) throw new Error(`API ${r.status}`);
      const json = await r.json();
      setData(json);
      setLastRefresh(new Date());
      setError(null);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 10_000); // auto-refresh every 10s
    return () => clearInterval(id);
  }, [load]);

  // ─── Derived data ──────────────────────────────────────────────────────────

  const positions = (data?.positions ?? []).filter(p => {
    if (chainFilter !== 'all' && p.chain !== chainFilter) return false;
    if (statusFilter === 'active' && !p.isActive) return false;
    if (statusFilter === 'closed' && p.isActive) return false;
    return true;
  });

  const activeCount = (data?.positions ?? []).filter(p => p.isActive).length;
  const closedCount = (data?.positions ?? []).filter(p => !p.isActive).length;
  const winsCount   = (data?.positions ?? []).filter(p => !p.isActive && p.pnlNative > 0).length;
  const globalWinR  = closedCount ? Math.round(winsCount * 100 / closedCount) : 0;

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-5 p-1">

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-white">🌐 Unified Portfolio</h2>
          <p className="text-xs text-gray-500 mt-0.5">All chains — SOL · ETH · BNB · TON</p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-gray-500 font-mono">{lastRefresh.toLocaleTimeString()}</span>
          <button
            onClick={() => { setLoading(true); load(); }}
            className="px-3 py-1.5 text-xs rounded-lg bg-[#2a2a35] hover:bg-[#333] text-gray-300 transition-colors"
          >
            ↺ Refresh
          </button>
        </div>
      </div>

      {/* Global summary strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          { label: 'Total Trades', value: (data?.positions.length ?? 0).toString(), color: 'text-white' },
          { label: 'Active Now',   value: activeCount.toString(),     color: activeCount > 0 ? 'text-green-400' : 'text-gray-400' },
          { label: 'Win Rate',     value: `${globalWinR}%`,           color: globalWinR >= 50 ? 'text-green-400' : globalWinR >= 25 ? 'text-yellow-400' : 'text-red-400' },
          { label: 'Chains',       value: '4',                        color: 'text-purple-400' },
        ].map(c => (
          <div key={c.label} className="bg-[#18181f] border border-[#2a2a35] rounded-xl p-4">
            <p className="text-xs text-gray-500">{c.label}</p>
            <p className={`text-2xl font-bold font-mono mt-1 ${c.color}`}>{c.value}</p>
          </div>
        ))}
      </div>

      {/* Chain cards (filter by chain) */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {(data?.chainSummary ?? (Object.keys(CHAIN_META) as Chain[]).map(c => ({
          chain: c, total: 0, active: 0, closed: 0, wins: 0, winRate: 0, pnlNative: 0, totalIn: 0
        }))).map(s => (
          <ChainCard
            key={s.chain}
            s={s}
            onClick={() => setChain(chainFilter === s.chain ? 'all' : s.chain)}
            active={chainFilter === s.chain}
          />
        ))}
      </div>

      {/* Filters row */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex rounded-lg overflow-hidden border border-[#2a2a35]">
          {(['all', 'active', 'closed'] as const).map(f => (
            <button
              key={f}
              onClick={() => setStatus(f)}
              className={`px-4 py-1.5 text-xs capitalize transition-colors ${statusFilter === f ? 'bg-[#2a2a35] text-white' : 'bg-[#18181f] text-gray-500 hover:text-gray-300'}`}
            >
              {f} {f === 'active' ? `(${activeCount})` : f === 'closed' ? `(${closedCount})` : `(${(data?.positions.length ?? 0)})`}
            </button>
          ))}
        </div>
        {chainFilter !== 'all' && (
          <button
            onClick={() => setChain('all')}
            className="px-3 py-1.5 text-xs rounded-lg bg-[#2a2a35] text-gray-400 hover:text-white transition-colors"
          >
            {CHAIN_META[chainFilter].icon} {CHAIN_META[chainFilter].label} ✕
          </button>
        )}
        <span className="text-xs text-gray-500 ml-auto">{positions.length} positions shown</span>
      </div>

      {/* Position table */}
      {loading && !data ? (
        <div className="flex items-center justify-center h-32">
          <div className="text-gray-500 animate-pulse">Loading multi-chain data…</div>
        </div>
      ) : error ? (
        <div className="rounded-xl border border-red-500/20 bg-red-500/5 p-4 text-sm text-red-400">
          Error: {error}
        </div>
      ) : positions.length === 0 ? (
        <div className="rounded-xl border border-[#2a2a35] p-8 text-center text-gray-500">
          No positions match the current filter.
        </div>
      ) : (
        <div className="rounded-xl border border-[#2a2a35] overflow-hidden">
          <table className="w-full text-xs">
            <thead className="bg-[#18181f] border-b border-[#2a2a35]">
              <tr className="text-gray-500 uppercase tracking-wider">
                <th className="px-3 py-3 text-left">Token</th>
                <th className="px-3 py-3 text-right">Invested</th>
                <th className="px-3 py-3 text-right">P&L</th>
                <th className="px-3 py-3 text-left">Status</th>
                <th className="px-3 py-3 text-right">Age</th>
              </tr>
            </thead>
            <tbody>
              {positions.map(p => <PositionRow key={p.id} pos={p} />)}
            </tbody>
          </table>
        </div>
      )}

      {/* Live feed placeholder */}
      <div className="rounded-xl border border-[#2a2a35] bg-[#18181f] p-4">
        <div className="flex items-center justify-between mb-3">
          <p className="text-sm font-semibold text-white">📡 Live Feed</p>
          <span className="flex items-center gap-1.5 text-xs text-green-400">
            <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse inline-block" />
            Auto-refresh every 10s
          </span>
        </div>
        {positions.filter(p => !p.isActive).slice(0, 8).map(p => {
          const m   = CHAIN_META[p.chain];
          const won = p.pnlNative > 0;
          return (
            <div key={p.id} className="flex items-center gap-2 py-1.5 border-b border-[#1e1e2a] last:border-0 text-xs">
              <span className={won ? 'text-green-400' : 'text-red-400'}>{won ? '🟢' : '🔴'}</span>
              <span className="text-gray-500 font-mono w-24 flex-shrink-0">
                {new Date(p.openedAt).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' })}
              </span>
              <span className="text-gray-400">
                {m.icon} {won ? 'SOLD' : 'CLOSED'}{' '}
                <span className="text-white font-semibold">${p.symbol}</span>
                {' '}{p.exitReason && <span className="text-gray-500">({p.exitReason})</span>}
              </span>
              <span className={`ml-auto font-mono font-bold ${won ? 'text-green-400' : 'text-red-400'}`}>
                {p.pnlNative >= 0 ? '+' : ''}{p.pnlPct.toFixed(1)}%
              </span>
            </div>
          );
        })}
      </div>

    </div>
  );
}
