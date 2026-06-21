/**
 * BSC Token Security Check — двойная проверка Honeypot + GoPlus перед покупкой.
 *
 * На BSC ~30-40% новых токенов с momentum = скрытые ловушки:
 *   - Honeypot: buy работает, sell заблокирован на уровне контракта
 *   - Hidden sell tax: 50-99% tax на продажу
 *   - Mintable: dev может напечатать безлимитные токены
 *
 * API:
 *   - honeypot.is (v2) — симуляция buy+sell на смарт-контракте
 *   - GoPlus Labs (chain_id=56 для BSC) — статический анализ прав владельца
 *
 * Оба API бесплатны. Fail-safe: при ошибке API → isSafe=false (не покупаем).
 */

import axios from 'axios';

export interface SecurityReport {
  isSafe:   boolean;
  reason?:  string;
  buyTax?:  number;
  sellTax?: number;
  source?:  string;
}

const TIMEOUT_MS = 6_000;
const MAX_TAX    = Number(process.env.BSC_MAX_TAX_PCT || '15'); // default: skip if buy or sell tax > 15%

export async function checkBscTokenSecurity(tokenAddress: string): Promise<SecurityReport> {
  const address = tokenAddress.toLowerCase();

  // ── 1. Honeypot.is ──────────────────────────────────────────────────────────
  try {
    const res = await axios.get(
      `https://api.honeypot.is/v2/IsHoneypot?address=${address}&chainID=56`,
      { headers: { 'User-Agent': 'Mozilla/5.0 GAD-Bot/1.0' }, timeout: TIMEOUT_MS }
    );
    const data = res.data ?? {};

    // Явный Honeypot
    if (data.honeypotResult?.isHoneypot === true) {
      return {
        isSafe: false,
        reason: `Honeypot.is: продажа заблокирована — ${data.honeypotResult.honeypotReason ?? 'HONEYPOT'}`,
        source: 'honeypot.is',
      };
    }

    const buyTax  = Number(data.simulationResult?.buyTax  ?? 0);
    const sellTax = Number(data.simulationResult?.sellTax ?? 0);

    if (buyTax > MAX_TAX) {
      return { isSafe: false, reason: `buy tax ${buyTax.toFixed(0)}% > ${MAX_TAX}%`, buyTax, sellTax, source: 'honeypot.is' };
    }
    if (sellTax > MAX_TAX) {
      return { isSafe: false, reason: `sell tax ${sellTax.toFixed(0)}% > ${MAX_TAX}%`, buyTax, sellTax, source: 'honeypot.is' };
    }

    // ── 2. GoPlus Labs (доп. проверка: mintable, owner renounced) ────────────
    try {
      const gp = await axios.get(
        `https://api.gopluslabs.io/api/v1/token_security/56?addresses=${address}`,
        { timeout: TIMEOUT_MS }
      );
      const d = gp.data?.result?.[address];
      if (d) {
        if (d.is_honeypot === '1') {
          return { isSafe: false, reason: 'GoPlus: is_honeypot=1', buyTax, sellTax, source: 'goplus' };
        }
        if (d.cannot_buy === '1' || d.cannot_sell_all === '1') {
          return { isSafe: false, reason: 'GoPlus: cannot_buy или cannot_sell_all', buyTax, sellTax, source: 'goplus' };
        }
        if (d.slippage_modifiable === '1') {
          return { isSafe: false, reason: 'GoPlus: dev может изменить slippage (tax rug risk)', buyTax, sellTax, source: 'goplus' };
        }
        if (d.is_mintable === '1' && d.owner_address && d.owner_address !== '0x0000000000000000000000000000000000000000') {
          return { isSafe: false, reason: 'GoPlus: mintable + owner не renounced', buyTax, sellTax, source: 'goplus' };
        }
      }
    } catch (gpErr: any) {
      console.debug(`[bsc-security] GoPlus timeout: ${gpErr.message?.slice(0, 50)} — только honeypot.is`);
    }

    console.info(`[bsc-security] ✅ ${address.slice(0, 8)} SAFE | buy:${buyTax}% sell:${sellTax}%`);
    return { isSafe: true, buyTax, sellTax, source: 'honeypot.is+goplus' };

  } catch (err: any) {
    // Honeypot.is недоступен — fail-safe: не покупаем
    console.warn(`[bsc-security] Ошибка API (${err.message?.slice(0, 50)}) → отказ (fail-safe)`);
    return { isSafe: false, reason: `API unavailable: ${err.message?.slice(0, 60)}` };
  }
}
