import { useEffect, useState, useRef, useCallback } from 'react';
import Link from 'next/link';
import ScoreBadge from '../components/ScoreBadge';

const API    = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';
const WS_URL = API.replace(/^http/, 'ws') + '/ws';

function StatCard({ label, value, color = 'text-white' }: { label: string; value: string | number; color?: string }) {
  return (
    <div className="bg-[#18181f] border border-[#2a2a35] rounded-xl p-4">
      <p className="text-xs text-gray-500 mb-1">{label}</p>
      <p className={`text-2xl font-bold font-mono ${color}`}>{value}</p>
    </div>
  );
}

export default function Overview() {
  const [tokens, setTokens]         = useState<any[]>([]);
  const [alerts, setAlerts]         = useState<any[]>([]);
  const [highscore, setHighscore]   = useState<any[]>([]);
  const [positions, setPositions]   = useState<any[]>([]);
  const [wsLive, setWsLive]         = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  const load = useCallback(async () => {
    const [t, a, h] = await Promise.all([
      fetch(`${API}/tokens/trending`).then(r => r.json()).catch(() => ({ tokens: [] })),
      fetch(`${API}/alerts`).then(r => r.json()).catch(() => ({ alerts: [] })),
      fetch(`${API}/tokens/highscore?threshold=80`).then(r => r.json()).catch(() => ({ tokens: [] })),
    ]);
    setTokens(t.tokens ?? []);
    setAlerts(a.alerts ?? []);
    setHighscore(h.tokens ?? []);
  }, []);

  // WebSocket — real-time trade updates (5s push from server)
  useEffect(() => {
    let reconnectTimer: ReturnType<typeof setTimeout>;

    function connect() {
      try {
        const ws = new WebSocket(WS_URL);
        wsRef.current = ws;

        ws.onopen  = () => setWsLive(true);
        ws.onclose = () => {
          setWsLive(false);
          reconnectTimer = setTimeout(connect, 5_000); // auto-reconnect
        };
        ws.onerror = () => ws.close();

        ws.onmessage = (e) => {
          try {
            const msg = JSON.parse(e.data);
            if (msg.event === 'live_state') {
              setPositions(msg.data.positions ?? []);
            }
          } catch { /* ignore malformed */ }
        };
      } catch { /* WS not available — fallback to polling */ }
    }

    connect();
    return () => {
      clearTimeout(reconnectTimer);
      wsRef.current?.close();
    };
  }, []);

  // Polling fallback for tokens/alerts (30s; WS covers positions)
  useEffect(() => {
    load();
    const id = setInterval(load, 30_000);
    return () => clearInterval(id);
  }, [load]);

  return (
    <div className="space-y-6">
      <h2 className="text-xl font-bold text-white">Overview</h2>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard label="Tokens Tracked"   value={tokens.length} />
        <StatCard label="High Score (≥80)" value={highscore.length} color="text-green-400" />
        <StatCard label="Active Positions" value={positions.length} color="text-purple-400" />
        <StatCard label="Live" value={wsLive ? '● Connected' : '○ Polling'} color={wsLive ? 'text-green-400' : 'text-gray-500'} />
      </div>

      {positions.length > 0 && (
        <section>
          <h3 className="text-sm font-semibold text-gray-300 mb-2">⚡ Live Positions</h3>
          <div className="overflow-x-auto rounded-lg border border-[#2a2a35]">
            <table className="w-full text-xs">
              <thead className="bg-[#18181f] text-gray-500">
                <tr>
                  <th className="px-3 py-2 text-left">Token</th>
                  <th className="px-3 py-2 text-right">Spent</th>
                  <th className="px-3 py-2 text-right">Received</th>
                  <th className="px-3 py-2 text-right">P&L</th>
                  <th className="px-3 py-2 text-right">Age</th>
                </tr>
              </thead>
              <tbody>
                {positions.map((p: any) => {
                  const spent = Number(p.total_spent_sol ?? 0);
                  const recv  = Number(p.total_sold_sol ?? 0);
                  const pnl   = recv - spent;
                  const ageSec = Math.floor((Date.now() - new Date(p.bought_at).getTime()) / 1000);
                  const ageStr = ageSec < 60 ? `${ageSec}s` : `${Math.floor(ageSec / 60)}m`;
                  const labelParts = (p.label ?? '').split(':');
                  const symbol = labelParts[2] ?? p.mint_address?.slice(0, 8);
                  return (
                    <tr key={p.mint_address} className="border-t border-[#2a2a35] hover:bg-[#18181f]">
                      <td className="px-3 py-2 font-mono text-white">{symbol}</td>
                      <td className="px-3 py-2 text-right text-gray-300">{spent.toFixed(3)}</td>
                      <td className="px-3 py-2 text-right text-gray-300">{recv.toFixed(3)}</td>
                      <td className={`px-3 py-2 text-right font-bold ${pnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                        {pnl >= 0 ? '+' : ''}{pnl.toFixed(3)}
                      </td>
                      <td className="px-3 py-2 text-right text-gray-500">{ageStr}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-gray-300">📈 Trending Tokens</h3>
          <Link href="/trending" className="text-xs text-purple-400 hover:underline">View all →</Link>
        </div>
        <div className="overflow-x-auto rounded-lg border border-[#2a2a35]">
          <table className="w-full text-xs">
            <thead className="bg-[#18181f] text-gray-500">
              <tr>
                <th className="px-3 py-2 text-left">#</th>
                <th className="px-3 py-2 text-left">Symbol</th>
                <th className="px-3 py-2 text-right">AI</th>
                <th className="px-3 py-2 text-right">Risk</th>
                <th className="px-3 py-2 text-right">MC</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#2a2a35]">
              {tokens.slice(0, 8).map((t: any, i: number) => (
                <tr key={t.mint_address} className="hover:bg-white/2">
                  <td className="px-3 py-2 text-gray-500">{i + 1}</td>
                  <td className="px-3 py-2 font-semibold text-white">
                    <Link href={`/token/${t.mint_address}`} className="hover:text-purple-300">
                      {t.symbol ?? t.mint_address.slice(0, 6)}
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-right"><ScoreBadge score={t.ai_score}   type="ai"   size="sm" /></td>
                  <td className="px-3 py-2 text-right"><ScoreBadge score={t.risk_score} type="risk" size="sm" /></td>
                  <td className="px-3 py-2 text-right text-gray-400">
                    {t.market_cap ? `$${Number(t.market_cap / 1000).toFixed(0)}K` : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-gray-300">🚨 Recent Alerts</h3>
          <Link href="/alerts" className="text-xs text-purple-400 hover:underline">View all →</Link>
        </div>
        <div className="space-y-2">
          {alerts.slice(0, 5).map((a: any) => {
            const cls: Record<string, string> = {
              HIGH_RISK:       'border-red-500/30 bg-red-500/5 text-red-400',
              NEW_HIGH_SCORE:  'border-green-500/30 bg-green-500/5 text-green-400',
              VOLUME_SPIKE:    'border-yellow-500/30 bg-yellow-500/5 text-yellow-400',
              WHALE_ACTIVITY:  'border-blue-500/30 bg-blue-500/5 text-blue-400',
              LIQUIDITY_DROP:  'border-orange-500/30 bg-orange-500/5 text-orange-400',
            };
            const c = cls[a.type] ?? 'border-gray-700 bg-gray-800/30 text-gray-400';
            return (
              <div key={a.id} className={`flex items-center justify-between px-3 py-2 rounded-lg border text-xs ${c}`}>
                <div className="flex gap-2">
                  <span className="font-semibold">{a.type}</span>
                  <span className="text-gray-500 font-mono">{(a.subject ?? '').slice(0, 16)}…</span>
                </div>
                <span>score:{a.score ?? 0}</span>
              </div>
            );
          })}
          {!alerts.length && <p className="text-gray-500 text-sm">Нет активных алертов.</p>}
        </div>
      </section>
    </div>
  );
}
