'use client';

import { useEffect, useState, useRef } from 'react';

const TG_BOT     = 'https://t.me/gadai_sol_bot';
const TG_CHANNEL = 'https://t.me/gadai_sol';

const TERMINAL_LINES = [
  '> Scanning 14,293 tokens...',
  '> [REGIME] SIDEWAYS — wait for breakouts 📊',
  '> [WHALE] BONK: wallet 7xKp bought $420K 🐳',
  '> [LIFECYCLE] WIF: HYPE stage → distribution risk ⚠️',
  '> [OPPORTUNITY] $MOON — early window, score 87/100 🎯',
  '> [ALPHA] 82% similar to 5 previous 50x winners 🧠',
  '> [RUG] ALERT dev wallet moving — caution ⚠️',
  '> [REPUTATION] Buyer: LEGEND wallet (72% win rate) 👑',
  '> [SAFE] PEPE: risk score 94/100 ✅',
  '> [SOCIAL] KOL @murad mentioned $BONK 🔥 engagement 9.2',
  '> AI analysis: BULLISH signal detected',
  '> Rug probability: 3% — you might survive',
  '> Portfolio P&L today: +69% 📈',
];

const TICKER = [
  '🔥 BONK +420%', '💎 WIF +69%', '🌙 PEPE +1337%',
  '🚀 MOON +228%', '💀 RUGGED x0', '🐋 WHALE ALERT',
  '📊 AI SCAN LIVE', '⚡ SOLANA SPEED', '🎯 NGMI → WAGMI',
  '🔫 RUG DETECTED', '🌡️ REGIME: SIDEWAYS', '🧠 ALPHA MEMORY',
  '🔄 LIFECYCLE: BIRTH', '👑 LEGEND WALLET', '📡 KOL SIGNAL',
];

const FEATURES = [
  { icon: '📡', title: 'REAL-TIME SCANNER', desc: 'Scans 14K+ tokens every second across pump.fun, GMGN, Helius. Know about new gems before CT does.' },
  { icon: '🐋', title: 'WHALE TRACKER',     desc: 'Big wallets move, you know instantly. Ape alongside the smart money. $5K+ moves tracked.' },
  { icon: '🤖', title: 'AI RISK SCORE',     desc: 'GAD Score 0–100. 6 weighted factors: momentum, liquidity, rug risk, narrative, social, survival.' },
  { icon: '🔫', title: 'RUG DETECTOR',      desc: '9-flag rug probability engine. Checks liquidity locks, dev wallets, honeypots. Saves your bags.' },
  { icon: '📊', title: 'PORTFOLIO P&L',     desc: 'Track all your positions in one terminal. See your gains. Accept your losses. Repeat.' },
  { icon: '🚨', title: 'INSTANT ALERTS',    desc: 'Price pumps, whale buys, rug signals straight to Telegram. Sub-second delivery.' },
];

const ALPHA_FEATURES = [
  {
    icon: '🌡️',
    title: 'MARKET REGIME ENGINE',
    desc: 'Auto-detects BULL / BEAR / SIDEWAYS / EUPHORIA / PANIC from CoinGecko + Fear&Greed Index. AI scores adapt to market context.',
    tag: 'NEW',
  },
  {
    icon: '🔄',
    title: 'MEME LIFECYCLE TRACKER',
    desc: 'Every token has a lifecycle: BIRTH → ACCUMULATION → BREAKOUT → HYPE → DISTRIBUTION → DEATH. Know exactly where a coin is.',
    tag: 'NEW',
  },
  {
    icon: '🎯',
    title: 'OPPORTUNITY ENGINE',
    desc: 'Finds tokens BEFORE they move. Narrative momentum + pre-breakout volume + whale accumulation = early alpha window.',
    tag: 'NEW',
  },
  {
    icon: '🧠',
    title: 'ALPHA MEMORY',
    desc: 'Compares every new token to historical 100x winners using cosine similarity. "This token is 82% similar to 5 previous 50x gems."',
    tag: 'NEW',
  },
  {
    icon: '👑',
    title: 'WALLET REPUTATION',
    desc: 'Classifies wallets as LEGEND / SMART / AVERAGE / TOURIST / EXIT_LIQUIDITY. Know if whales buying are actually smart money.',
    tag: 'NEW',
  },
  {
    icon: '📡',
    title: 'SOCIAL MONITOR',
    desc: 'Real-time KOL tracking on Twitter/X + Telegram channels. Detects when influencers mention tokens before the herd arrives.',
    tag: 'NEW',
  },
];

const STEPS = [
  { num: '01', title: 'OPEN THE BOT',      desc: 'Hit /start in @gadai_sol_bot. Takes 10 seconds. Less time than your last rug.' },
  { num: '02', title: 'LINK YOUR WALLET',  desc: 'Use /link to connect your Solana wallet. Unlock subscription and wallet reputation tracking.' },
  { num: '03', title: 'PROFIT (hopefully)', desc: 'Get regime-aware alerts, scan lifecycle stages, track KOL signals. WAGMI. (results not guaranteed, degen)' },
];

const STATS = [
  { value: '14,293',  label: 'Tokens Scanned' },
  { value: '$2.4B',   label: 'Volume Tracked' },
  { value: '847',     label: 'Rugs Avoided' },
  { value: '6',       label: 'Alpha Engines' },
];

function seededRand(seed: number) {
  const x = Math.sin(seed) * 10000;
  return x - Math.floor(x);
}

function MatrixBg() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;

  return (
    <div className="matrix-bg" aria-hidden>
      {Array.from({ length: 20 }).map((_, i) => (
        <div
          key={i}
          className="matrix-col"
          style={{
            left: `${i * 5 + 2}%`,
            animationDuration: `${6 + (i % 7)}s`,
            animationDelay: `${(i * 0.7) % 5}s`,
          }}
        >
          {Array.from({ length: 30 }).map((_, j) => (
            <div key={j}>{seededRand(i * 30 + j) > 0.5 ? '1' : '0'}</div>
          ))}
        </div>
      ))}
    </div>
  );
}

export default function HomePage() {
  const [termLines, setTermLines] = useState([TERMINAL_LINES[0]]);
  const termRef = useRef<HTMLDivElement>(null);
  const idxRef  = useRef(0);

  useEffect(() => {
    const t = setInterval(() => {
      idxRef.current = (idxRef.current + 1) % TERMINAL_LINES.length;
      setTermLines(prev => [...prev, TERMINAL_LINES[idxRef.current]].slice(-8));
    }, 1200);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (termRef.current) termRef.current.scrollTop = termRef.current.scrollHeight;
  }, [termLines]);

  const tickerDouble = [...TICKER, ...TICKER];

  return (
    <>
      <MatrixBg />

      {/* NAV */}
      <nav className="nav">
        <div className="nav-logo">GAD<span>AI</span> TERMINAL</div>
        <div className="nav-links">
          <a href="#features" className="nav-link">FEATURES</a>
          <a href="#alpha"    className="nav-link">ALPHA ENGINE</a>
          <a href="#pricing"  className="nav-link">PRICING</a>
        </div>
        <a href={TG_BOT} target="_blank" rel="noopener noreferrer" className="nav-cta">
          ▶ OPEN BOT
        </a>
      </nav>

      {/* HERO */}
      <section className="hero">
        <div style={{ position: 'relative', zIndex: 1 }}>
          <div className="hero-badge">⚡ LIVE ON SOLANA — ALPHA ENGINE v2 ONLINE</div>
          <div className="pixel-bot">🤖</div>
          <h1 className="hero-title">
            THE <span className="accent">SOLANA</span><br />
            DEGEN <span className="accent2">TERMINAL</span>
          </h1>
          <p className="hero-sub">
            Scan meme coins. Track <strong>whale wallets</strong>. Get AI risk scores.<br />
            Detect rugs before they rekt you. Know the regime, track the lifecycle.<br />
            <strong>All in your Telegram. All for free to start.</strong>
          </p>
          <div className="hero-btns">
            <a href={TG_BOT}     target="_blank" rel="noopener noreferrer" className="btn-primary">
              🚀 OPEN @gadai_sol_bot
            </a>
            <a href={TG_CHANNEL} target="_blank" rel="noopener noreferrer" className="btn-secondary">
              📢 JOIN CHANNEL
            </a>
          </div>

          {/* TERMINAL DEMO */}
          <div className="terminal-wrap">
            <div className="terminal-bar">
              <div className="t-dot t-red" /><div className="t-dot t-yellow" /><div className="t-dot t-green" />
              <span style={{ marginLeft: 8 }}>gadai_sol_bot — alpha engine live</span>
            </div>
            <div className="terminal" ref={termRef}>
              {termLines.map((line, i) => <div key={i} className="t-line">{line}</div>)}
              <div className="t-line"><span className="t-cursor" /></div>
            </div>
          </div>
        </div>
      </section>

      {/* TICKER */}
      <div className="ticker-wrap">
        <div className="ticker-track">
          {tickerDouble.map((item, i) => <span key={i} className="ticker-item">{item}</span>)}
        </div>
      </div>

      {/* CORE FEATURES */}
      <section className="section" id="features" style={{ background: 'rgba(153,69,255,.03)' }}>
        <div className="container">
          <h2 className="section-title">WHAT THE BOT DOES</h2>
          <p className="section-sub">
            Six core tools that would have saved your bags last bull run. Not financial advice. Just vibes and algorithms.
          </p>
          <div className="features-grid">
            {FEATURES.map(f => (
              <div key={f.title} className="feature-card">
                <span className="feature-icon">{f.icon}</span>
                <div className="feature-title">{f.title}</div>
                <p className="feature-desc">{f.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* STATS */}
      <section className="stats-section">
        <div className="container">
          <div className="stats-grid">
            {STATS.map(s => (
              <div key={s.label} className="stat-box">
                <div className="stat-value">{s.value}</div>
                <div className="stat-label">{s.label}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ALPHA ENGINE — NEW Sprint 13 */}
      <section className="section" id="alpha" style={{ background: 'rgba(20,241,149,.03)' }}>
        <div className="container">
          <div style={{ textAlign: 'center', marginBottom: 8 }}>
            <span style={{
              display: 'inline-block',
              background: 'rgba(20,241,149,0.15)',
              color: 'var(--green)',
              border: '1px solid var(--green)',
              borderRadius: 4,
              padding: '4px 12px',
              fontSize: 10,
              fontFamily: 'var(--font-pixel)',
              letterSpacing: 2,
            }}>ALPHA ENGINE v2 — JUST SHIPPED</span>
          </div>
          <h2 className="section-title">THE ALPHA ENGINE</h2>
          <p className="section-sub">
            Six new intelligence modules. The same tools hedge funds use. Now in your Telegram.
          </p>
          <div className="features-grid">
            {ALPHA_FEATURES.map(f => (
              <div key={f.title} className="feature-card" style={{ border: '1px solid rgba(20,241,149,0.3)', position: 'relative' }}>
                <span style={{
                  position: 'absolute', top: 12, right: 12,
                  background: 'var(--green)', color: '#000',
                  fontSize: 9, padding: '2px 6px', borderRadius: 3,
                  fontFamily: 'var(--font-pixel)',
                }}>{f.tag}</span>
                <span className="feature-icon">{f.icon}</span>
                <div className="feature-title">{f.title}</div>
                <p className="feature-desc">{f.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* HOW IT WORKS */}
      <section className="section" id="how">
        <div className="container">
          <h2 className="section-title">HOW IT WORKS</h2>
          <p className="section-sub">
            Three steps. Less effort than explaining to your parents what a meme coin is.
          </p>
          <div className="steps">
            {STEPS.map(s => (
              <div key={s.num} className="step">
                <div className="step-num">{s.num}</div>
                <div>
                  <div className="step-title">{s.title}</div>
                  <p className="step-desc">{s.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* PRICING */}
      <section className="section" id="pricing" style={{ background: 'rgba(153,69,255,.03)' }}>
        <div className="container">
          <h2 className="section-title">PRICING</h2>
          <p className="section-sub">Paid in SOL, on-chain, no middleman. Cancel anytime by just not renewing.</p>
          <div className="pricing-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', maxWidth: 900, margin: '0 auto' }}>

            {/* FREE */}
            <div className="price-card">
              <div className="price-tier">FREE DEGEN</div>
              <div className="price-amount">0 SOL</div>
              <p className="price-period">forever (we&apos;re not monsters)</p>
              <ul className="price-features">
                <li><span className="check">✓</span> Basic token scanner</li>
                <li><span className="check">✓</span> 3 whale alerts/day</li>
                <li><span className="check">✓</span> AI risk scores</li>
                <li><span className="check">✓</span> GAD Score 0–100</li>
                <li style={{ opacity: .4 }}><span>✗</span> Alpha Engine</li>
                <li style={{ opacity: .4 }}><span>✗</span> Market Regime</li>
                <li style={{ opacity: .4 }}><span>✗</span> Lifecycle Tracker</li>
                <li style={{ opacity: .4 }}><span>✗</span> Wallet Reputation</li>
              </ul>
              <a href={TG_BOT} target="_blank" rel="noopener noreferrer" className="price-btn secondary">
                START FREE
              </a>
            </div>

            {/* TRIAL */}
            <div className="price-card">
              <div className="price-badge" style={{ background: 'rgba(20,241,149,0.15)', color: 'var(--green)', border: '1px solid var(--green)' }}>🧪 TRY FIRST</div>
              <div className="price-tier">TRIAL</div>
              <div className="price-amount">0.1 SOL</div>
              <p className="price-period">/ 24 hours · full access</p>
              <ul className="price-features">
                <li><span className="check">✓</span> Everything in Free</li>
                <li><span className="check">✓</span> 🌡️ Market Regime Engine</li>
                <li><span className="check">✓</span> 🔄 Meme Lifecycle Tracker</li>
                <li><span className="check">✓</span> 🎯 Opportunity Engine</li>
                <li><span className="check">✓</span> 🧠 Alpha Memory</li>
                <li><span className="check">✓</span> 👑 Wallet Reputation</li>
                <li><span className="check">✓</span> 📡 Social KOL Monitor</li>
                <li><span className="check">✓</span> Unlimited whale alerts</li>
              </ul>
              <a href="/pay?plan=trial_1d" className="price-btn secondary" style={{ borderColor: 'var(--green)', color: 'var(--green)' }}>
                TRY FOR 0.1 SOL
              </a>
            </div>

            {/* PRO */}
            <div className="price-card featured">
              <div className="price-badge">🔥 MOST BASED</div>
              <div className="price-tier">PRO CHAD</div>
              <div className="price-amount">1.0 SOL</div>
              <p className="price-period">/ 30 days · paid on-chain</p>
              <ul className="price-features">
                <li><span className="check">✓</span> Everything in Trial</li>
                <li><span className="check">✓</span> Auto-buy via Jupiter DEX</li>
                <li><span className="check">✓</span> Custom alert thresholds</li>
                <li><span className="check">✓</span> Portfolio P&amp;L tracking</li>
                <li><span className="check">✓</span> Priority alpha channel</li>
                <li><span className="check">✓</span> Real-time scanner (30s)</li>
                <li><span className="check">✓</span> Smart money signals</li>
                <li><span className="check">✓</span> Direct on-chain payment</li>
              </ul>
              <a href="/pay?plan=monthly" className="price-btn">
                GO PRO 🚀
              </a>
            </div>

          </div>
          <p style={{ textAlign: 'center', marginTop: 32, fontSize: 11, color: 'var(--muted)' }}>
            💳 Payment via Phantom / Solflare wallet. On-chain verification. No accounts, no KYC.
          </p>
        </div>
      </section>

      {/* FINAL CTA */}
      <section className="cta-section">
        <div style={{ position: 'relative', zIndex: 1 }}>
          <div style={{ fontSize: 64, marginBottom: 24, display: 'block', animation: 'float 3s ease-in-out infinite' }}>🚀</div>
          <h2 className="cta-title">
            STOP MISSING <span className="accent">100X GEMS</span><br />
            NGMI → WAGMI
          </h2>
          <p className="cta-sub">
            Join degens already using GAD AI Terminal to scan, track, and ape smarter on Solana.<br />
            <strong>Alpha Engine v2 is live.</strong> Market Regime. Lifecycle. Opportunity. Memory.
          </p>
          <div style={{ display: 'flex', gap: 16, justifyContent: 'center', flexWrap: 'wrap' }}>
            <a href={TG_BOT}     target="_blank" rel="noopener noreferrer" className="btn-primary" style={{ fontSize: 13 }}>
              ⚡ OPEN BOT NOW — IT&apos;S FREE
            </a>
            <a href={TG_CHANNEL} target="_blank" rel="noopener noreferrer" className="btn-secondary">
              📢 JOIN CHANNEL
            </a>
          </div>
          <p className="cta-disclaimer">
            Not financial advice. Past performance ≠ future results. DYOR. We are all gonna make it (statistically unlikely but emotionally necessary).
          </p>
        </div>
      </section>

      {/* FOOTER */}
      <footer className="footer">
        <div className="footer-logo">GAD AI TERMINAL</div>
        <div className="footer-links">
          <a href={TG_BOT}     target="_blank" rel="noopener noreferrer" className="footer-link">Telegram Bot</a>
          <a href={TG_CHANNEL} target="_blank" rel="noopener noreferrer" className="footer-link">Channel</a>
          <a href="#features"  className="footer-link">Features</a>
          <a href="#alpha"     className="footer-link">Alpha Engine</a>
          <a href="#pricing"   className="footer-link">Pricing</a>
          <a href="/pay"       className="footer-link">Subscribe</a>
        </div>
        <div className="footer-copy" suppressHydrationWarning>
          © {new Date().getFullYear()} GAD AI · WAGMI
        </div>
      </footer>
    </>
  );
}
