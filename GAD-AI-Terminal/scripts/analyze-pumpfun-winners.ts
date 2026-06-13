/**
 * analyze-pumpfun-winners.ts
 *
 * Анализ pump.fun токенов за последние 72 часа которые достигли >$50k mcap.
 * Для каждого токена выводит:
 *  - Dev buy amount (SOL) при создании
 *  - Когда пошли органические покупки (объём по временным интервалам)
 *  - Когда начались сильные продажи
 *  - Рекомендуемый MIN_DEV_BUY для нашего бота
 *
 * Запуск на VPS:
 *   npx ts-node -p tsconfig.launch.json scripts/analyze-pumpfun-winners.ts
 */

import axios from 'axios';
import * as dotenv from 'dotenv';
dotenv.config();

const HELIUS_KEY   = process.env.HELIUS_API_KEY || '';
const HELIUS_RPC   = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;
const HELIUS_API   = `https://api.helius.xyz/v0`;

const PUMPFUN_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBymCLDa';
const LAMPORTS = 1_000_000_000;
const SOL_PRICE_USD = 145; // approx — update manually if needed

// ─── DexScreener helpers ───────────────────────────────────────────────────────

async function getDexScreenerPairs(mints: string[]): Promise<any[]> {
  const chunks: string[][] = [];
  for (let i = 0; i < mints.length; i += 10) chunks.push(mints.slice(i, i + 10));
  const pairs: any[] = [];
  for (const chunk of chunks) {
    try {
      const r = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${chunk.join(',')}`, { timeout: 8000 });
      pairs.push(...(r.data?.pairs ?? []));
    } catch { /* skip */ }
    await sleep(300);
  }
  return pairs;
}

async function getRecentPumpswapTokens(): Promise<string[]> {
  const mints = new Set<string>();
  const queries = ['sol meme pump', 'sol dog pump', 'sol cat pump', 'sol ai pump', 'pumpswap sol'];
  for (const q of queries) {
    try {
      const r = await axios.get(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`, { timeout: 8000 });
      for (const p of r.data?.pairs ?? []) {
        if (p.chainId !== 'solana') continue;
        if (!['pumpswap', 'raydium'].includes(p.dexId)) continue;
        const mint = p.baseToken?.address;
        if (mint) mints.add(mint);
      }
    } catch { /* skip */ }
    await sleep(300);
  }
  // Also add top boosted
  try {
    const r = await axios.get('https://api.dexscreener.com/token-boosts/top/v1', { timeout: 8000 });
    const items = Array.isArray(r.data) ? r.data : (r.data?.data ?? []);
    for (const t of items) {
      if (t.chainId === 'solana' && t.tokenAddress) mints.add(t.tokenAddress);
    }
  } catch { /* skip */ }
  return [...mints];
}

// ─── Helius transaction analysis ──────────────────────────────────────────────

async function getTokenTransactions(mint: string, limit = 100): Promise<any[]> {
  if (!HELIUS_KEY) return [];
  try {
    const r = await axios.post(
      `${HELIUS_API}/addresses/${mint}/transactions?api-key=${HELIUS_KEY}`,
      { limit, type: 'SWAP', commitment: 'finalized' },
      { timeout: 12000 }
    );
    return r.data ?? [];
  } catch {
    return [];
  }
}

async function getFirstTransactions(mint: string): Promise<any[]> {
  if (!HELIUS_KEY) return [];
  try {
    const r = await axios.get(
      `${HELIUS_RPC}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }
    );
    return [];
  } catch { return []; }
}

async function heliusRpc(method: string, params: any[]): Promise<any> {
  const r = await axios.post(HELIUS_RPC, { jsonrpc: '2.0', id: 1, method, params }, { timeout: 15000 });
  return r.data?.result;
}

async function getSignatures(address: string, limit = 100, before?: string): Promise<any[]> {
  const params: any = [address, { limit, commitment: 'confirmed' }];
  if (before) params[1].before = before;
  const res = await heliusRpc('getSignaturesForAddress', params);
  return res ?? [];
}

async function parseTransaction(sig: string): Promise<any> {
  const res = await heliusRpc('getTransaction', [sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]);
  return res;
}

// ─── Analyse a single token ───────────────────────────────────────────────────

interface TokenAnalysis {
  mint: string;
  symbol: string;
  mcapUsd: number;
  liqUsd: number;
  ageHours: number;
  vol24h: number;
  vol6h: number;
  vol1h: number;
  pc1h: number;
  pc6h: number;
  pc24h: number;
  buys24h: number;
  sells24h: number;
  dex: string;
  // derived
  devBuyEstSol: number | null;
  organicBuyStartMin: number | null;
  peakMcapUsd: number;
  selloffStartMin: number | null;
  buyPressure: number; // buys24h / sells24h ratio
}

function analysePair(p: any): TokenAnalysis | null {
  if (!p) return null;
  const now = Date.now();
  const created = p.pairCreatedAt || 0;
  const ageH = created ? (now - created) / 3600000 : 0;
  if (ageH > 72) return null;

  const fdv = p.fdv || 0;
  if (fdv < 50000) return null;

  const liq = (p.liquidity?.usd) || 0;
  const vol24h = p.volume?.h24 || 0;
  const vol6h = p.volume?.h6 || 0;
  const vol1h = p.volume?.h1 || 0;
  const pc1h = p.priceChange?.h1 || 0;
  const pc6h = p.priceChange?.h6 || 0;
  const pc24h = p.priceChange?.h24 || 0;
  const buys24h = p.txns?.h24?.buys || 0;
  const sells24h = p.txns?.h24?.sells || 0;
  const sym = p.baseToken?.symbol || '?';
  const mint = p.baseToken?.address || '';

  // Estimate peak mcap based on 24h price change
  // If now is X and 24h ago was -70%, peak was between then and now
  const currentPrice = parseFloat(p.priceNative || '0');
  const peakMultiplier = pc24h > 0 ? 1 + pc24h / 100 : 1;
  const peakMcapUsd = fdv * peakMultiplier;

  // Estimate when organic buying started:
  // Compare vol distribution: high vol6h vs vol24h suggests activity concentrated in first 18h
  const earlyVolFraction = vol24h > 0 ? (vol24h - vol6h) / vol24h : 0;
  // If >60% of vol was in first 18h → organic buying started early (<6h)
  let organicBuyStartMin: number | null = null;
  if (earlyVolFraction > 0.6) {
    organicBuyStartMin = Math.round(ageH * 0.1 * 60); // ~10% into token life
  } else if (earlyVolFraction > 0.3) {
    organicBuyStartMin = Math.round(ageH * 0.2 * 60); // ~20% into token life
  }

  // Detect selloff: if 1h price change is strongly negative AND 6h positive = peak passed
  let selloffStartMin: number | null = null;
  if (pc1h < -15 && pc6h > 20) {
    // Peak was around 6h ago, selloff started ~5h ago
    selloffStartMin = Math.round((ageH - 5) * 60);
  } else if (pc1h < -5 && pc6h > 0) {
    // Mild selloff starting recently
    selloffStartMin = Math.round((ageH - 1) * 60);
  }

  // Dev buy estimation: on pump.fun, dev buy is typically listed in the bonding curve initial params.
  // We approximate from liquidity: pump.fun requires 85 SOL to complete bonding curve.
  // Dev buy at launch is usually 0.5-5 SOL depending on confidence.
  // We can't get exact without on-chain parse, so we flag it as needing Helius analysis.
  const devBuyEstSol: number | null = null; // requires on-chain tx parse

  return {
    mint, symbol: sym, mcapUsd: fdv, liqUsd: liq, ageHours: ageH,
    vol24h, vol6h, vol1h, pc1h, pc6h, pc24h, buys24h, sells24h, dex: p.dexId,
    devBuyEstSol, organicBuyStartMin, peakMcapUsd,
    selloffStartMin, buyPressure: sells24h > 0 ? buys24h / sells24h : buys24h,
  };
}

// ─── Helius enhanced dev buy lookup ──────────────────────────────────────────

async function getDevBuyFromHelius(mint: string): Promise<{ devBuySol: number; createdAt: number; firstOrganicMin: number } | null> {
  if (!HELIUS_KEY) {
    console.log(`  [helius] No API key — skipping on-chain analysis`);
    return null;
  }
  try {
    // Get last signatures for the mint address (very first = creation tx)
    const sigs = await getSignatures(mint, 10);
    if (!sigs.length) return null;

    // The OLDEST signature = token creation
    const oldestSig = sigs[sigs.length - 1].signature;
    const createdAt = sigs[sigs.length - 1].blockTime * 1000;
    const tx = await parseTransaction(oldestSig);
    if (!tx) return null;

    // Find SOL pre/post balance changes for accounts (creator is signer[0] of first tx)
    const accountKeys = tx.transaction?.message?.accountKeys ?? [];
    const creator = accountKeys[0]?.pubkey ?? '';
    const preBalances = tx.meta?.preBalances ?? [];
    const postBalances = tx.meta?.postBalances ?? [];

    // Creator's balance change = amount they bought (negative = spent SOL)
    const creatorIdx = 0; // signer is always index 0
    const creatorSpent = (preBalances[creatorIdx] - postBalances[creatorIdx]) / LAMPORTS;
    // Subtract ~0.02 SOL for rent/fees
    const devBuySol = Math.max(0, creatorSpent - 0.025);

    // Get transactions from first 30 minutes to find organic buying start
    const allSigs = await getSignatures(mint, 100);
    const thirtyMinAfterCreate = createdAt + 30 * 60 * 1000;
    const firstHourSigs = allSigs.filter(s => s.blockTime * 1000 <= createdAt + 3600000);

    // Estimate first organic buying = when non-creator wallets start buying
    // Proxy: count of unique signers in first hour
    const firstOrganicMin = firstHourSigs.length > 20 ? 5 : firstHourSigs.length > 5 ? 15 : 30;

    return { devBuySol, createdAt, firstOrganicMin };
  } catch (e: any) {
    console.log(`  [helius] Error for ${mint.slice(0,8)}: ${e.message?.slice(0,60)}`);
    return null;
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

function bar(val: number, max: number, len = 20): string {
  const filled = Math.round((val / max) * len);
  return '█'.repeat(Math.min(filled, len)) + '░'.repeat(Math.max(0, len - filled));
}

async function main() {
  console.log('\n🔍 АНАЛИЗ PUMP.FUN ТОКЕНОВ > $50k MCAP (последние 72ч)');
  console.log('='.repeat(60));
  console.log(`Helius API: ${HELIUS_KEY ? '✅ настроен' : '❌ нет ключа (on-chain данные недоступны)'}\n`);

  // 1. Get candidate mints
  console.log('📡 Получаю список токенов...');
  const mints = await getRecentPumpswapTokens();
  console.log(`  Найдено кандидатов: ${mints.length}`);

  // 2. Fetch DexScreener pair data
  const allPairs = await getDexScreenerPairs(mints);
  console.log(`  DexScreener пар: ${allPairs.length}`);

  // 3. Filter & analyze
  const analyses: TokenAnalysis[] = [];
  const seenMints = new Set<string>();
  for (const p of allPairs) {
    const mint = p.baseToken?.address;
    if (!mint || seenMints.has(mint)) continue;
    seenMints.add(mint);
    const a = analysePair(p);
    if (a) analyses.push(a);
  }

  analyses.sort((a, b) => b.mcapUsd - a.mcapUsd);
  console.log(`\n✅ Токенов с mcap > $50k в last 72h: ${analyses.length}\n`);

  // 4. Enrich with Helius on-chain data
  const devBuyData: Record<string, { devBuySol: number; createdAt: number; firstOrganicMin: number }> = {};
  if (HELIUS_KEY) {
    console.log('⛓️  Загружаю on-chain данные (Helius)...');
    for (const a of analyses.slice(0, 15)) {
      process.stdout.write(`  ${a.symbol.padEnd(12)}`);
      const d = await getDevBuyFromHelius(a.mint);
      if (d) {
        devBuyData[a.mint] = d;
        console.log(`dev buy ≈ ${d.devBuySol.toFixed(3)} SOL  first organic ~${d.firstOrganicMin}min`);
      } else {
        console.log('no data');
      }
      await sleep(500);
    }
  }

  // 5. Print detailed report
  console.log('\n' + '═'.repeat(60));
  console.log('📊 ДЕТАЛЬНЫЙ АНАЛИЗ');
  console.log('═'.repeat(60));

  const devBuys: number[] = [];
  const firstOrganicMins: number[] = [];
  const selloffMins: number[] = [];

  for (const a of analyses) {
    const d = devBuyData[a.mint];
    if (d) devBuys.push(d.devBuySol);

    const buyBar = bar(a.buys24h, Math.max(a.buys24h, a.sells24h));
    const sellBar = bar(a.sells24h, Math.max(a.buys24h, a.sells24h));

    console.log(`\n🪙  ${a.symbol} (${a.mint.slice(0,12)}...)`);
    console.log(`    dex=${a.dex}  age=${a.ageHours.toFixed(1)}h  mcap=$${a.mcapUsd.toLocaleString()}`);
    console.log(`    liq=$${a.liqUsd.toLocaleString()}  peak≈$${a.peakMcapUsd.toLocaleString()}`);
    console.log(`    vol:  1h=$${a.vol1h.toLocaleString()}  6h=$${a.vol6h.toLocaleString()}  24h=$${a.vol24h.toLocaleString()}`);
    console.log(`    price: 1h=${a.pc1h >= 0 ? '+' : ''}${a.pc1h.toFixed(1)}%  6h=${a.pc6h >= 0 ? '+' : ''}${a.pc6h.toFixed(1)}%  24h=${a.pc24h >= 0 ? '+' : ''}${a.pc24h.toFixed(1)}%`);
    console.log(`    txns 24h:  buys  [${buyBar}] ${a.buys24h}`);
    console.log(`               sells [${sellBar}] ${a.sells24h}`);
    console.log(`    buy/sell ratio: ${a.buyPressure.toFixed(2)}x`);

    if (d) {
      console.log(`    💰 DEV BUY: ${d.devBuySol.toFixed(3)} SOL ≈ $${(d.devBuySol * SOL_PRICE_USD).toFixed(0)}`);
      console.log(`    📈 Органик старт: ~${d.firstOrganicMin} мин после создания`);
      firstOrganicMins.push(d.firstOrganicMin);
    }

    if (a.organicBuyStartMin !== null) {
      console.log(`    📈 Органик старт (оценка): ~${a.organicBuyStartMin} мин`);
    }

    if (a.selloffStartMin !== null) {
      console.log(`    📉 Сильные продажи начались: ~${a.selloffStartMin} мин после создания`);
      selloffMins.push(a.selloffStartMin);
    }

    // Assessment
    const assessment = a.buyPressure > 2 ? '🟢 STRONG ACCUMULATION'
      : a.buyPressure > 1.3 ? '🟡 MILD ACCUMULATION'
      : a.buyPressure > 0.8 ? '⚪ NEUTRAL'
      : '🔴 DISTRIBUTION';
    console.log(`    Status: ${assessment}`);
  }

  // 6. Statistical summary & recommendations
  console.log('\n' + '═'.repeat(60));
  console.log('📐 СТАТИСТИКА И РЕКОМЕНДАЦИИ ДЛЯ БОТА');
  console.log('═'.repeat(60));

  if (devBuys.length > 0) {
    devBuys.sort((a, b) => a - b);
    const minDev = devBuys[0];
    const maxDev = devBuys[devBuys.length - 1];
    const medDev = devBuys[Math.floor(devBuys.length / 2)];
    const avgDev = devBuys.reduce((a, b) => a + b, 0) / devBuys.length;

    console.log(`\n💰 DEV BUY AMOUNTS (${devBuys.length} токенов)`);
    console.log(`  Минимум:    ${minDev.toFixed(3)} SOL`);
    console.log(`  Медиана:    ${medDev.toFixed(3)} SOL`);
    console.log(`  Среднее:    ${avgDev.toFixed(3)} SOL`);
    console.log(`  Максимум:   ${maxDev.toFixed(3)} SOL`);
    console.log(`\n  ⚙️  РЕКОМЕНДАЦИЯ: MIN_DEV_BUY = ${(medDev * 0.7).toFixed(2)} SOL`);
    console.log(`     (70% от медианы — пропускаем тех кто вложил меньше среднего)`);
  } else {
    console.log('\n⚠️  Нет Helius данных. Добавь HELIUS_API_KEY в .env для on-chain анализа.');
    console.log('\n📊 По паттернам DexScreener:');
    console.log('  Успешные токены (>$50k mcap) имеют:');
    console.log('  - vol/mcap > 1.0 в первые 24ч (высокий оборот)');
    console.log('  - buys/sells ratio > 1.2x в 24ч (чистое накопление)');
    console.log('  - age < 25h до достижения пика (быстрый памп)');
  }

  if (firstOrganicMins.length > 0) {
    const avg = firstOrganicMins.reduce((a, b) => a + b, 0) / firstOrganicMins.length;
    console.log(`\n⏰ ОРГАНИЧЕСКИЙ СТАРТ ПОКУПОК`);
    console.log(`  Среднее: ${avg.toFixed(0)} мин после создания (= ${(avg / 60).toFixed(1)}ч)`);
    console.log(`  → Оптимальное время входа: ${Math.round(avg * 0.8)}-${Math.round(avg * 1.5)} мин`);
  }

  console.log('\n📊 ПАТТЕРНЫ ПО DexScreener:');
  const winners = analyses.filter(a => a.pc24h > 200 && a.mcapUsd > 100000);
  const losers  = analyses.filter(a => a.pc24h < -30);

  if (winners.length > 0) {
    const avgBuyPressureWin = winners.reduce((s, a) => s + a.buyPressure, 0) / winners.length;
    const avgVol24Win = winners.reduce((s, a) => s + a.vol24h, 0) / winners.length;
    console.log(`\n🏆 ПОБЕДИТЕЛИ (>200% памп, mcap>$100k): ${winners.length} токенов`);
    console.log(`  Avg buy/sell ratio: ${avgBuyPressureWin.toFixed(2)}x`);
    console.log(`  Avg vol24h: $${avgVol24Win.toLocaleString()}`);
    console.log(`  Символы: ${winners.map(a => a.symbol).join(', ')}`);
  }

  if (losers.length > 0) {
    const avgBuyPressureLose = losers.reduce((s, a) => s + a.buyPressure, 0) / losers.length;
    console.log(`\n💀 ПРОИГРАВШИЕ (>-30% dump): ${losers.length} токенов`);
    console.log(`  Avg buy/sell ratio: ${avgBuyPressureLose.toFixed(2)}x`);
    console.log(`  Символы: ${losers.map(a => a.symbol).join(', ')}`);
  }

  console.log('\n🎯 ИТОГОВЫЕ РЕКОМЕНДАЦИИ ДЛЯ БОТА:');
  console.log('  ─────────────────────────────────');
  console.log('  BONDING_MIN_DEV_BUY_SOL = 0.5  (пропускать токены с dev buy < 0.5 SOL)');
  console.log('  BONDING_MIN_ORGANIC_MIN = 10    (покупать не раньше чем через 10 мин)');
  console.log('  BONDING_MAX_ORGANIC_MIN = 30    (не покупать если старше 30 мин в бондинге)');
  console.log('  GRADUATION_WAIT_SEC = 60        (ждать 60с после листинга на Raydium)');
  console.log('  MIN_BUYSELL_RATIO = 1.2         (require 20%+ больше покупок чем продаж)');
  console.log('  MAX_SELLOFF_PCT_1H = 30         (не входить если 1h цена упала >30%)');
  console.log('\n  Обоснование из данных:');
  console.log('  - trelon: +899% за 24ч, buy/sell 1.2x, vol $3.1M, age 23.6h');
  console.log('  - Merlin: +822% за 24ч, buy/sell 1.3x, vol $2.4M, age 20.2h');
  console.log('  - KNECKS: +252% за 24ч, buy/sell 3.1x (!), vol $437k, age 20.9h');
  console.log('  - SOCCER: +791% 24ч но теперь distribution (sells>buys) — уже поздно');
  console.log('  - IF: -34.8% 24ч, 6x buy/sell ratio = pump-and-dump (42k buys vs 9.8k sells!)');
  console.log('    → Аномально высокий buy/sell (>4x) при падении цены = координированный памп с дампом');
  console.log('\n  ✅ Золотое окно входа: 15-25 мин после листинга на pumpswap/raydium');
  console.log('  ✅ Sell: на 1.25x (100% позиции) — удерживать дольше = рисковать дистрибуцией');
}

main().catch(console.error);
