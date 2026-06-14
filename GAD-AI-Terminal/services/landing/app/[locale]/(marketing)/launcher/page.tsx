'use client';

import { useState, useRef } from 'react';

const API_BASE = '/api/proxy';
const TG_BOT   = 'https://t.me/gadai_sol_bot';

interface LaunchForm {
  name:        string;
  ticker:      string;
  description: string;
  devBuySol:   string;
  w2BuySol:    string;
  w3BuySol:    string;
}

const PRINCIPLES = [
  { icon: '🤖', text: 'GAD AI admin reviews & launches within minutes' },
  { icon: '📌', text: 'Logo uploaded to Pinata IPFS — permanent & public' },
  { icon: '⛓️',  text: 'Token deployed on pump.fun Solana blockchain' },
  { icon: '🐋', text: 'Staggered 3-wallet buy: organic & safe pattern' },
  { icon: '📡', text: 'Telegram notification on launch confirmation' },
  { icon: '✅', text: 'No fake volume, no coordinated insider buys' },
];

export default function LauncherPage() {
  const [form, setForm] = useState<LaunchForm>({
    name: '', ticker: '', description: '',
    devBuySol: '0.10', w2BuySol: '0.05', w3BuySol: '0.03',
  });
  const [image, setImage] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [error, setError] = useState('');
  const [submitId, setSubmitId] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  function handleField(k: keyof LaunchForm, v: string) {
    if (k === 'ticker') v = v.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
    setForm(f => ({ ...f, [k]: v }));
  }

  function handleImage(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) { setError('Image must be under 2MB'); return; }
    setImage(file);
    setImagePreview(URL.createObjectURL(file));
    setError('');
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name || !form.ticker || !form.description) {
      setError('Name, ticker, and description are required.'); return;
    }
    if (!image) { setError('Please upload a logo image.'); return; }

    setStatus('loading');
    setError('');

    try {
      // Convert image to base64
      const imgB64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve((reader.result as string).split(',')[1]);
        reader.onerror = reject;
        reader.readAsDataURL(image);
      });

      const res = await fetch(`${API_BASE}/launcher/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...form,
          imageName: image.name,
          imageType: image.type,
          imageB64: imgB64,
          devBuySol: Number(form.devBuySol),
          w2BuySol:  Number(form.w2BuySol),
          w3BuySol:  Number(form.w3BuySol),
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Submission failed');
      setStatus('success');
      setSubmitId(data.id ?? '');
    } catch (e: any) {
      setStatus('error');
      setError(e.message);
    }
  }

  if (status === 'success') {
    return (
      <main className="py-24 bg-[#0a0a0f] min-h-screen text-white flex items-center justify-center">
        <div className="max-w-lg text-center px-6">
          <div className="text-6xl mb-6">🚀</div>
          <h1 className="text-3xl font-bold mb-4">Submitted!</h1>
          <p className="text-gray-400 mb-6">
            Your token idea has been queued. The GAD AI team will review and launch within minutes.
            Watch <a href={TG_BOT} className="text-blue-400 underline">@gadai_sol_bot</a> for the launch confirmation.
          </p>
          {submitId && (
            <p className="text-xs text-gray-600 font-mono">
              ID: {submitId}
            </p>
          )}
          <button
            onClick={() => { setStatus('idle'); setImage(null); setImagePreview(null); setForm({ name: '', ticker: '', description: '', devBuySol: '0.10', w2BuySol: '0.05', w3BuySol: '0.03' }); }}
            className="mt-8 px-6 py-2 rounded-lg bg-[#18181f] border border-[#2a2a35] hover:border-blue-500/50 text-sm transition-colors"
          >
            Submit Another
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="py-24 bg-[#0a0a0f] min-h-screen text-white">
      {/* Hero */}
      <section className="mx-auto max-w-4xl px-6 text-center mb-16">
        <span className="inline-block px-3 py-1 rounded-full text-xs font-mono font-semibold bg-blue-900/40 text-blue-300 border border-blue-700/40 mb-6">
          PUMP.FUN LAUNCHER
        </span>
        <h1 className="text-4xl md:text-5xl font-bold tracking-tight mb-4">
          🚀 Launch Your Token
        </h1>
        <p className="text-lg text-gray-400 max-w-2xl mx-auto">
          Create your Solana meme token on pump.fun in minutes. Fill the form — GAD AI handles upload, deploy, and 3-wallet buy.
        </p>
      </section>

      <div className="mx-auto max-w-5xl px-6 grid lg:grid-cols-2 gap-12">

        {/* Left: Form */}
        <div>
          <h2 className="text-xl font-bold mb-6">Token Details</h2>
          <form onSubmit={handleSubmit} className="space-y-5">

            {/* Name */}
            <div>
              <label className="block text-sm text-gray-400 mb-1">Token Name *</label>
              <input
                type="text" maxLength={30} value={form.name}
                onChange={e => handleField('name', e.target.value)}
                placeholder="e.g. Moon Dog"
                className="w-full px-4 py-3 rounded-lg bg-[#18181f] border border-[#2a2a35] focus:border-blue-500 outline-none text-white placeholder-gray-600 transition-colors"
              />
            </div>

            {/* Ticker */}
            <div>
              <label className="block text-sm text-gray-400 mb-1">Ticker * (max 8 chars)</label>
              <div className="relative">
                <span className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-500">$</span>
                <input
                  type="text" maxLength={8} value={form.ticker}
                  onChange={e => handleField('ticker', e.target.value)}
                  placeholder="MOON"
                  className="w-full pl-8 pr-4 py-3 rounded-lg bg-[#18181f] border border-[#2a2a35] focus:border-blue-500 outline-none text-white font-mono placeholder-gray-600 transition-colors"
                />
              </div>
            </div>

            {/* Description */}
            <div>
              <label className="block text-sm text-gray-400 mb-1">Description *</label>
              <textarea
                rows={4} maxLength={500} value={form.description}
                onChange={e => handleField('description', e.target.value)}
                placeholder="The meme behind the next moonshot. Dogs going to the moon..."
                className="w-full px-4 py-3 rounded-lg bg-[#18181f] border border-[#2a2a35] focus:border-blue-500 outline-none text-white placeholder-gray-600 resize-none transition-colors"
              />
              <p className="text-xs text-gray-600 mt-1">{form.description.length}/500</p>
            </div>

            {/* Logo */}
            <div>
              <label className="block text-sm text-gray-400 mb-1">Logo Image * (PNG/JPG, max 2MB)</label>
              <div
                onClick={() => fileRef.current?.click()}
                className="border-2 border-dashed border-[#2a2a35] hover:border-blue-500/50 rounded-xl p-6 text-center cursor-pointer transition-colors"
              >
                {imagePreview ? (
                  <img src={imagePreview} alt="preview" className="h-24 w-24 object-cover rounded-lg mx-auto" />
                ) : (
                  <>
                    <div className="text-3xl mb-2">🖼️</div>
                    <p className="text-sm text-gray-500">Click to upload logo</p>
                  </>
                )}
                <input ref={fileRef} type="file" accept="image/*" onChange={handleImage} className="hidden" />
              </div>
            </div>

            {/* Buy amounts */}
            <div>
              <label className="block text-sm text-gray-400 mb-3">Dev Buy Strategy (SOL)</label>
              <div className="grid grid-cols-3 gap-3">
                {[
                  { label: 'W1 Dev', key: 'devBuySol' as const, hint: 'immediate' },
                  { label: 'W2 +12min', key: 'w2BuySol' as const, hint: 'organic' },
                  { label: 'W3 +28min', key: 'w3BuySol' as const, hint: 'organic' },
                ].map(({ label, key, hint }) => (
                  <div key={key}>
                    <label className="block text-xs text-gray-600 mb-1">{label}</label>
                    <input
                      type="number" step="0.01" min="0" max="10"
                      value={form[key]}
                      onChange={e => handleField(key, e.target.value)}
                      className="w-full px-3 py-2 rounded-lg bg-[#18181f] border border-[#2a2a35] focus:border-blue-500 outline-none text-white text-sm font-mono transition-colors"
                    />
                    <p className="text-xs text-gray-700 mt-1">{hint}</p>
                  </div>
                ))}
              </div>
              <p className="text-xs text-gray-600 mt-2">
                Total: ~{(Number(form.devBuySol) + Number(form.w2BuySol) + Number(form.w3BuySol)).toFixed(2)} SOL dev commitment
              </p>
            </div>

            {/* Error */}
            {error && (
              <div className="px-4 py-3 rounded-lg bg-red-900/30 border border-red-700/40 text-red-400 text-sm">
                {error}
              </div>
            )}

            {/* Submit */}
            <button
              type="submit" disabled={status === 'loading'}
              className="w-full py-3 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed font-semibold transition-colors"
            >
              {status === 'loading' ? '⏳ Submitting...' : '🚀 Submit for Launch'}
            </button>
            <p className="text-center text-xs text-gray-600">
              GAD AI team reviews and launches on pump.fun. You get Telegram notification.
            </p>
          </form>
        </div>

        {/* Right: Info */}
        <div>
          <h2 className="text-xl font-bold mb-6">How It Works</h2>
          <div className="space-y-4 mb-10">
            {[
              { n: '01', t: 'Fill the form', d: 'Name, ticker (max 8), description, logo. Choose dev buy amounts across 3 wallets.' },
              { n: '02', t: 'Submit', d: 'Your idea queues for review. GAD AI uploads logo to Pinata IPFS, creates metadata.' },
              { n: '03', t: 'Auto-Launch', d: 'Token deployed on pump.fun via SDK. All 3 wallet buys execute with staggered timing.' },
              { n: '04', t: 'Track & Sell', d: 'Monitor via /mycoins in Telegram. Sell your dev position when ready with /exitcoin.' },
            ].map(s => (
              <div key={s.n} className="bg-[#18181f] border border-[#2a2a35] rounded-xl p-4 flex gap-4">
                <span className="text-2xl font-bold font-mono text-blue-500 shrink-0">{s.n}</span>
                <div>
                  <h3 className="font-semibold text-white">{s.t}</h3>
                  <p className="mt-1 text-sm text-gray-400">{s.d}</p>
                </div>
              </div>
            ))}
          </div>

          <h2 className="text-xl font-bold mb-4">What You Get</h2>
          <div className="bg-[#18181f] border border-[#2a2a35] rounded-2xl p-6 space-y-3">
            {PRINCIPLES.map((p, i) => (
              <div key={i} className="flex items-center gap-3">
                <span className="text-lg">{p.icon}</span>
                <p className="text-sm text-gray-300">{p.text}</p>
              </div>
            ))}
          </div>

          <div className="mt-6 bg-blue-900/20 border border-blue-700/30 rounded-xl p-4">
            <p className="text-sm text-blue-300">
              📱 Track your launched tokens via <a href={TG_BOT} className="underline">@gadai_sol_bot</a>:<br />
              <code className="text-xs">/mycoins</code> — positions | <code className="text-xs">/exitcoin TICKER</code> — sell
            </p>
          </div>
        </div>
      </div>
    </main>
  );
}
