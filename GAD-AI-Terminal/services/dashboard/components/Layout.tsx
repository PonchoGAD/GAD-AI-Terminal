import Link from 'next/link';
import { useRouter } from 'next/router';
import { ReactNode, useState } from 'react';

const NAV = [
  { href: '/',           label: 'Overview',    icon: '📊' },
  { href: '/trending',   label: 'Trending',    icon: '📈' },
  { href: '/new',        label: 'New Tokens',  icon: '🆕' },
  { href: '/highscore',  label: 'High Score',  icon: '🏆' },
  { href: '/highrisk',   label: 'High Risk',   icon: '⚠️' },
  { href: '/whales',     label: 'Whales',      icon: '🐋' },
  { href: '/smartmoney', label: 'Smart Money', icon: '🧠' },
  { href: '/alerts',     label: 'Alerts',      icon: '🚨' },
  { href: '/watchlist',  label: 'Watchlist',   icon: '📋' },
  { href: '/portfolio',  label: 'Portfolio',   icon: '💼' },
  { href: '/terminal',   label: 'AI Terminal', icon: '🤖' },
  { href: '/launcher',   label: 'Coin Launcher', icon: '🚀' },
  { href: '/unified',    label: 'All Chains',    icon: '🌐' },
];

export default function Layout({ children }: { children: ReactNode }) {
  const { pathname } = useRouter();
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className="flex min-h-screen bg-[#0f0f13]">
      {/* Sidebar */}
      <aside className={`${collapsed ? 'w-14' : 'w-52'} shrink-0 bg-[#18181f] border-r border-[#2a2a35] transition-all duration-200`}>
        <div className="flex items-center justify-between px-3 py-4 border-b border-[#2a2a35]">
          {!collapsed && <span className="font-bold text-purple-400 text-sm tracking-wide">GAD AI</span>}
          <button onClick={() => setCollapsed(!collapsed)} className="text-gray-500 hover:text-white">
            {collapsed ? '▶' : '◀'}
          </button>
        </div>
        <nav className="py-2">
          {NAV.map((item) => {
            const active = pathname === item.href;
            return (
              <Link key={item.href} href={item.href}
                className={`flex items-center gap-2 px-3 py-2 text-sm transition-colors ${
                  active
                    ? 'bg-purple-900/40 text-purple-300 border-r-2 border-purple-500'
                    : 'text-gray-400 hover:text-white hover:bg-white/5'
                }`}
              >
                <span className="text-base">{item.icon}</span>
                {!collapsed && <span>{item.label}</span>}
              </Link>
            );
          })}
        </nav>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-auto">
        <header className="sticky top-0 z-10 bg-[#0f0f13]/90 backdrop-blur border-b border-[#2a2a35] px-6 py-3 flex items-center justify-between">
          <h1 className="text-sm font-mono text-gray-400">GAD AI Terminal — Solana Analytics</h1>
          <span className="text-xs text-green-400 font-mono">● LIVE</span>
        </header>
        <div className="p-6">{children}</div>
      </main>
    </div>
  );
}
