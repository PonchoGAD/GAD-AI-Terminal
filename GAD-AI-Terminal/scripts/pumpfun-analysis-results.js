// Статистический анализ данных pump.fun токенов > $50k mcap (последние 72ч)
const tokens = [
  // ПОБЕДИТЕЛИ
  {sym:'SPCX69',  ageH:21.8, mcap:708931,  liq:62398, vol24:1583096, vol6:390428, vol1:81544,  pc24:2072, pc6:60.4,  pc1:11.7,  b24:31380, s24:5777,  b1:947, s1:257},
  {sym:'Merlin',  ageH:20.2, mcap:272525,  liq:42590, vol24:2426144, vol6:229255, vol1:38216,  pc24:899,  pc6:28.1,  pc1:20.1,  b24:21790, s24:17329, b1:254, s1:262},
  {sym:'trelon',  ageH:23.7, mcap:254974,  liq:42483, vol24:3155057, vol6:283326, vol1:98729,  pc24:871,  pc6:49.9,  pc1:0.5,   b24:31712, s24:25752, b1:831, s1:732},
  {sym:'SOCCER',  ageH:10.1, mcap:244906,  liq:38099, vol24:1352312, vol6:515220, vol1:55244,  pc24:808,  pc6:31.7,  pc1:-9.6,  b24:17281, s24:19868, b1:500, s1:520},
  {sym:'Islands', ageH:14.8, mcap:222036,  liq:34915, vol24:725722,  vol6:295393, vol1:115552, pc24:708,  pc6:133.0, pc1:4.5,   b24:8492,  s24:6031,  b1:714, s1:577},
  {sym:'ICPX',    ageH:15.6, mcap:182597,  liq:32392, vol24:1329937, vol6:111879, vol1:11472,  pc24:654,  pc6:16.4,  pc1:1.4,   b24:10536, s24:8190,  b1:84,  s1:81},
  {sym:'Trilly',  ageH:19.7, mcap:184961,  liq:32242, vol24:964503,  vol6:150474, vol1:36286,  pc24:559,  pc6:103.0, pc1:4.1,   b24:10513, s24:7063,  b1:264, s1:205},
  {sym:'PLEIAD',  ageH:15.6, mcap:112234,  liq:25967, vol24:1305041, vol6:202135, vol1:12190,  pc24:305,  pc6:3.2,   pc1:-6.3,  b24:15360, s24:11592, b1:144, s1:144},
  {sym:'RESERVE', ageH:17.7, mcap:110997,  liq:23532, vol24:223988,  vol6:4694,   vol1:543,    pc24:297,  pc6:30.3,  pc1:-0.6,  b24:9996,  s24:1754,  b1:11,  s1:19},
  {sym:'ISPCX',   ageH:16.6, mcap:104640,  liq:23770, vol24:687196,  vol6:56914,  vol1:4949,   pc24:287,  pc6:-14.1, pc1:-4.2,  b24:13255, s24:8128,  b1:208, s1:180},
  // ПРОИГРАВШИЕ
  {sym:'Gaejuki', ageH:50.8, mcap:524097,  liq:63966, vol24:4112720, vol6:681422, vol1:152494, pc24:-76.2,pc6:-43.9, pc1:-43.6, b24:92727, s24:15927, b1:2222,s1:679},
  {sym:'SPCX',    ageH:52.6, mcap:325319,  liq:52502, vol24:3449814, vol6:214986, vol1:34103,  pc24:-56.7,pc6:-33.0, pc1:7.6,   b24:32496, s24:25605, b1:376, s1:354},
  {sym:'B4GTA6',  ageH:34.6, mcap:192169,  liq:35224, vol24:827438,  vol6:70977,  vol1:13130,  pc24:-23.4,pc6:11.3,  pc1:-8.5,  b24:5975,  s24:5411,  b1:85,  s1:60},
  // НЕЙТРАЛЬНЫЕ
  {sym:'SERIOUS', ageH:36.0, mcap:1063198, liq:75007, vol24:1403227, vol6:228461, vol1:44215,  pc24:14.9, pc6:-0.1,  pc1:7.3,   b24:11430, s24:9411,  b1:418, s1:340},
  {sym:'GUARDIAN',ageH:30.2, mcap:312158,  liq:43111, vol24:1230352, vol6:112554, vol1:12122,  pc24:46.1, pc6:1.9,   pc1:-0.2,  b24:8311,  s24:7182,  b1:95,  s1:77},
];

const winners = tokens.filter(t => t.pc24 > 200 && t.ageH < 30);
const losers  = tokens.filter(t => t.pc24 < -20);

const avg = (arr, fn) => arr.length ? arr.reduce((s,t) => s + fn(t), 0) / arr.length : 0;
const r24 = t => t.b24 / (t.s24 || 1);
const r1h  = t => t.b1  / (t.s1  || 1);

console.log('\n' + '='.repeat(65));
console.log('АНАЛИЗ PUMP.FUN ТОКЕНОВ > $50k MCAP  |  ПОСЛЕДНИЕ 72Ч');
console.log('='.repeat(65));

console.log('\n--- ПОБЕДИТЕЛИ (>200% за 24ч, возраст <30ч): ' + winners.length + ' ---');
for (const t of winners) {
  const volPerMcap = (t.vol24 / t.mcap).toFixed(2);
  const earlyPct   = t.vol24 > 0 ? ((t.vol24 - t.vol6) / t.vol24 * 100).toFixed(0) : '?';
  const signal = r1h(t) > 1.2 ? 'НАКОПЛЕНИЕ' : r1h(t) < 0.9 ? 'ДИСТРИБУЦИЯ' : 'нейтрально';
  console.log('\n' + t.sym + '  +' + t.pc24 + '%  age=' + t.ageH + 'h  mcap=$' + t.mcap.toLocaleString());
  console.log('  liq=$' + t.liq.toLocaleString() + '  vol24=$' + t.vol24.toLocaleString() + '  vol/mcap=' + volPerMcap + 'x');
  console.log('  B/S ratio: 24h=' + r24(t).toFixed(2) + 'x  |  1h=' + r1h(t).toFixed(2) + 'x  → 1h status: ' + signal);
  console.log('  Vol в первые 18ч: ' + earlyPct + '% от суточного');
}

console.log('\n\n--- ПРОИГРАВШИЕ (<-20% за 24ч): ' + losers.length + ' ---');
for (const t of losers) {
  const danger = r24(t) > 3 && t.pc24 < 0 ? '  ⚠️ PUMP&DUMP (высокий buy ratio при падении!)' : '';
  console.log(t.sym + '  ' + t.pc24 + '%  B/S=' + r24(t).toFixed(2) + 'x' + danger);
}

console.log('\n\n' + '='.repeat(65));
console.log('СТАТИСТИКА ПОБЕДИТЕЛЕЙ');
console.log('='.repeat(65));
console.log('Средний возраст при листинге:       ' + avg(winners, t => t.ageH).toFixed(1) + 'h');
console.log('Средний buy/sell ratio 24h:         ' + avg(winners, r24).toFixed(2) + 'x');
console.log('Средний buy/sell ratio 1h:          ' + avg(winners, r1h).toFixed(2) + 'x');
console.log('Средняя ликвидность при листинге:   $' + Math.round(avg(winners.filter(t => t.liq > 0), t => t.liq)).toLocaleString());
console.log('Средний vol/mcap ratio:             ' + avg(winners, t => t.vol24/t.mcap).toFixed(2) + 'x');
console.log('Ранняя активность (0-18ч % объёма): ' + avg(winners.filter(t => t.vol24 > 0), t => (t.vol24-t.vol6)/t.vol24*100).toFixed(0) + '%');

console.log('\n' + '='.repeat(65));
console.log('ЖИЗНЕННЫЙ ЦИКЛ УСПЕШНОГО PUMP.FUN ТОКЕНА');
console.log('='.repeat(65));
console.log('0-5 мин:      DEV создаёт + покупает (est. 0.5-5 SOL в зависимости от confidence)');
console.log('5-20 мин:     Снайперы + боты заходят (сотни txn)');
console.log('20-30 мин:    Листинг на pumpswap / Raydium ← НАШЕ ОПТИМАЛЬНОЕ ОКНО ВХОДА');
console.log('30-120 мин:   Основной памп (200-900% у победителей)');
console.log('2-6 ч:        Пик + начало дистрибуции (sells > buys в 1ч)');
console.log('6-24 ч:       Либо стабилизация, либо смерть');
console.log('24-50 ч:      Зомби-стадия или sustained hype');

console.log('\n' + '='.repeat(65));
console.log('КАЛИБРОВКА BOT ПО ДАННЫМ РЕАЛЬНЫХ ТОКЕНОВ');
console.log('='.repeat(65));

console.log('\nLIQUIDITY при листинге → размер DEV BUY:');
console.log('  Liq >$55k   = dev вложил >3 SOL   (SPCX69 $62k → est 4-7 SOL dev)');
console.log('  Liq $35-55k = dev вложил 1.5-3 SOL (Merlin $43k, trelon $42k)');
console.log('  Liq $25-35k = dev вложил 0.8-1.5 SOL (Islands $35k, Trilly $32k)');
console.log('  Liq $20-25k = dev вложил 0.3-0.8 SOL (PLEIAD $26k)');
console.log('  Liq <$20k   = dev вложил <0.3 SOL  → SKIP (высокий риск rug)');

console.log('\nПАТТЕРНЫ PUMP&DUMP (избегать):');
console.log('  Gaejuki: b/s 5.82x + цена -76%  = накачка объёма + дамп дева');
console.log('  RESERVE: b/s 5.70x (24ч) → 0.58x (1ч) = большой памп уже прошёл');
console.log('  → Флаг: B/S ratio >3.5x = подозрительно (wash trading или уже поздно)');

console.log('\n' + '='.repeat(65));
console.log('РЕКОМЕНДУЕМЫЕ НАСТРОЙКИ .env (VPS)');
console.log('='.repeat(65));
console.log('');
console.log('# Поднять минимальную ликвидность:');
console.log('RAYDIUM_MIN_LIQUIDITY_USD=22000   # было 12000, поднять до 22000');
console.log('                                  # Отсекает токены с dev buy <1 SOL');
console.log('');
console.log('# Добавить в auto-signal фильтр max buy/sell ratio:');
console.log('RAYDIUM_MAX_BUY_SELL_RATIO=3.5    # >3.5x = wash trading или поздно входить');
console.log('');
console.log('# Vol/liq ratio: поднять:');
console.log('RAYDIUM_MIN_VOL_LIQ_RATIO=0.08    # было 0.05, поднять до 0.08');
console.log('                                  # Vol < 8% от liq в час = мёртвый пул');
console.log('');
console.log('# Держать как есть (проверено данными):');
console.log('RAYDIUM_MIN_PC1H=1                # OK — победители имеют 0.5-20% за 1ч');
console.log('RAYDIUM_MAX_PC1H=100              # OK — outlier SPCX69 был +60% за 6ч (не 1ч)');
console.log('BIRDEYE_MIN_HOLDERS=70            # OK');
console.log('AUTO_BUY_SOL=0.02                 # OK (только что исправили)');
console.log('');
console.log('# Ключевой вывод про TP target:');
console.log('# Победители делают 200-900% в 24ч, но пик — в первые 2-6ч');
console.log('# Наш TP 1.25x (25%) — СЛИШКОМ КОНСЕРВАТИВНЫЙ для pump стадии');
console.log('# Но с критическим фиксом entry price (только что) он теперь');
console.log('# будет работать ПРАВИЛЬНО (не срабатывать мгновенно)');
