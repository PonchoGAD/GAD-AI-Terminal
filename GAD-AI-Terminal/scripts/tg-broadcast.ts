/**
 * Telegram broadcast script — posts to @gadfamilytg via @gadai_sol_bot
 * Usage: BROADCAST_MSG="your text" npx ts-node scripts/tg-broadcast.ts
 *    OR: edit MESSAGE below and run directly
 *
 * Bot must be admin in @gadfamilytg for this to work.
 */
import dotenv from 'dotenv';
import axios from 'axios';
dotenv.config();

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;
const CHANNEL   = process.env.TG_CHANNEL ?? '@gadfamilytg';

// ── Edit this message or pass BROADCAST_MSG env var ──────────────────────────
const MESSAGE = process.env.BROADCAST_MSG ?? `🚀 <b>$ELONWON — Elon Won</b>

SpaceX IPO запустился сегодня на Nasdaq под тикером SPCX.
$135 → $150 (+11%) в первый день. Оценка: <b>$1.75 ТРИЛЛИОНА</b>.
Самый большой IPO в истории. Elon официально стал первым триллионером планеты.

Мы запустили <b>$ELONWON</b> — первый Solana-мемкоин на этом событии.

🔗 pump.fun: <b>MINT_ADDRESS_HERE</b>
📊 DexScreener: будет через 5 минут

#ELONWON #SpaceX #Solana #pumpfun`;

async function broadcast() {
  if (!BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN not set in .env');

  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const res = await axios.post(url, {
    chat_id: CHANNEL,
    text: MESSAGE,
    parse_mode: 'HTML',
    disable_web_page_preview: false,
  });

  if (res.data.ok) {
    console.log('✅ Posted to', CHANNEL);
    console.log('   Message ID:', res.data.result.message_id);
    console.log('   Chat:', res.data.result.chat.title);
  } else {
    throw new Error('Telegram error: ' + JSON.stringify(res.data));
  }
}

broadcast().catch(e => {
  console.error('FAILED:', e.response?.data ?? e.message);
  process.exit(1);
});
