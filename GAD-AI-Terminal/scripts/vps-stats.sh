#!/usr/bin/env bash
# Сбор торговой статистики БЕЗ перезапуска/очистки (запускать ежедневно).
#   cd /c/Users/gafit/GAD-AI-Terminal && bash scripts/vps-stats.sh
# Результат: vps-report/stats_<дата>.txt → отдать Claude на анализ.
set -u
KEY=~/.ssh/gad_deploy
HOST=root@65.21.159.255
TS=$(date +%Y-%m-%d_%H%M)
mkdir -p vps-report
OUT="vps-report/stats_${TS}.txt"

ssh -i "$KEY" "$HOST" 'bash -s' <<'REMOTE' | tee "$OUT"
set +e
PG=$(docker ps --format '{{.Names}}' | grep -i 'gad-ai-postgres' | head -1)
AUTOBUY=$(docker ps --format '{{.Names}}' | grep -i autobuy | head -1)
FUTURES=$(docker ps --format '{{.Names}}' | grep -i futures | head -1)
POLY=$(docker ps --format '{{.Names}}' | grep -i polymarket | head -1)
sql() { docker exec "$PG" psql -U gad -d gad_ai -P pager=off -c "$1" 2>&1; }

date -u
docker ps --format 'table {{.Names}}\t{{.Status}}'
df -h / | tail -1

echo "═══ Raydium: сделки за 48ч ═══"
sql "SELECT mint_address, label, amount_sol, total_sold_sol,
            ROUND((NULLIF(total_sold_sol,0)/amount_sol)::numeric,3) roi,
            bought_at, active
     FROM autobuy_jobs
     WHERE label LIKE 'auto:%' AND created_at > now() - interval '48 hours'
     ORDER BY created_at DESC LIMIT 30;"

echo "═══ Raydium P&L 48ч / 14д ═══"
sql "SELECT '48h' period, COUNT(*) trades,
            COUNT(*) FILTER (WHERE total_sold_sol >= amount_sol) wins,
            ROUND(SUM(total_sold_sol - amount_sol)::numeric,4) net_sol
     FROM autobuy_jobs WHERE label LIKE 'auto:raydium_scan%' AND bought_at IS NOT NULL
       AND created_at > now() - interval '48 hours'
     UNION ALL
     SELECT '14d', COUNT(*),
            COUNT(*) FILTER (WHERE total_sold_sol >= amount_sol),
            ROUND(SUM(total_sold_sol - amount_sol)::numeric,4)
     FROM autobuy_jobs WHERE label LIKE 'auto:raydium_scan%' AND bought_at IS NOT NULL
       AND created_at > now() - interval '14 days';"

echo "═══ Причины продаж 48ч ═══"
sql "SELECT sell_reason, COUNT(*), ROUND(SUM(sol_received)::numeric,4) sol
     FROM autosell_stages WHERE status='executed'
       AND executed_at > now() - interval '48 hours' GROUP BY 1 ORDER BY 2 DESC;"

echo "═══ Shadow trades 48ч ═══"
sql "SELECT strategy, status, COUNT(*), ROUND(AVG(outcome_pct)::numeric,1) avg_pct
     FROM shadow_trades WHERE created_at > now() - interval '48 hours' GROUP BY 1,2;"

echo "═══ КАЛИБРОВКА: strict vs relaxed (Raydium, 5 дней) ═══"
sql "SELECT strategy,
            COUNT(*) FILTER (WHERE status='tp1_hit') wins,
            COUNT(*) FILTER (WHERE status IN ('stopped','expired')) losses,
            ROUND(AVG(outcome_pct) FILTER (WHERE status<>'open')::numeric,1) avg_pct,
            COUNT(*) FILTER (WHERE status='open') still_open
     FROM shadow_trades
     WHERE strategy IN ('raydium','raydium_scan','raydium_relaxed')
       AND created_at > now() - interval '5 days'
     GROUP BY 1;"
echo "═══ W3 PUMPSWAP LIVE-сделки (реальные деньги) ═══"
sql "SELECT symbol, entry_price, outcome_pct, status, created_at, outcome_at
     FROM shadow_trades WHERE strategy='pumpswap_movers_live'
     ORDER BY created_at DESC LIMIT 20;"
echo "═══ PUMPSWAP MOVERS: профиль победителей vs проигравших (5 дней) ═══"
sql "SELECT status, COUNT(*) n,
            ROUND(AVG((filter_params::jsonb->>'mcap')::numeric)/1000) mcap_k,
            ROUND(AVG((filter_params::jsonb->>'liq')::numeric)/1000) liq_k,
            ROUND(AVG((filter_params::jsonb->>'ageMin')::numeric)) age_min,
            ROUND(AVG((filter_params::jsonb->>'pc5m')::numeric),1) pc5m,
            ROUND(AVG((filter_params::jsonb->>'pc1h')::numeric),1) pc1h,
            ROUND(AVG((filter_params::jsonb->>'bs1h')::numeric),2) bs1h,
            ROUND(AVG((filter_params::jsonb->>'volLiq')::numeric),2) vol_liq,
            ROUND(AVG(outcome_pct)::numeric,1) avg_outcome
     FROM shadow_trades
     WHERE strategy='pumpswap_movers' AND created_at > now() - interval '5 days'
     GROUP BY status ORDER BY status;"
echo "--- Movers: чекпоинты 1ч/4ч (сколько ещё растут после записи) ---"
sql "SELECT COUNT(*) n,
            COUNT(*) FILTER (WHERE check_1h_pct > 0) up_1h,
            COUNT(*) FILTER (WHERE check_4h_pct > 0) up_4h,
            ROUND(AVG(check_1h_pct)::numeric,1) avg_1h,
            ROUND(AVG(check_4h_pct)::numeric,1) avg_4h
     FROM shadow_trades
     WHERE strategy='pumpswap_movers' AND created_at > now() - interval '5 days';"

echo "═══ X-trend кандидаты в воронке (5 дней) ═══"
sql "SELECT status, COUNT(*), ROUND(AVG(outcome_pct)::numeric,1)
     FROM shadow_trades
     WHERE strategy='raydium_relaxed' AND filter_params::text LIKE '%\"xtrend\":true%'
       AND created_at > now() - interval '5 days'
     GROUP BY 1;"

echo "═══ Futures 48ч ═══"
sql "SELECT * FROM futures_positions WHERE opened_at > now() - interval '48 hours' ORDER BY id DESC LIMIT 10;"

echo "═══ Polymarket 48ч ═══"
sql "SELECT outcome, entry_price, ev_score, confidence, created_at
     FROM polymarket_signals WHERE created_at > now() - interval '48 hours'
     ORDER BY created_at DESC LIMIT 15;"
echo "═══ Polymarket ВОРОНКА (почему сигналы не становятся позициями) ═══"
[ -n "$POLY" ] && docker exec "$POLY" sh -c 'wget -qO- http://localhost:4009/funnel 2>/dev/null || curl -s http://localhost:4009/funnel' 2>/dev/null
echo ""
echo "═══ Polymarket ARB-сканер (YES+NO < \$1) ═══"
[ -n "$POLY" ] && docker exec "$POLY" sh -c 'wget -qO- http://localhost:4009/arb 2>/dev/null || curl -s http://localhost:4009/arb' 2>/dev/null
echo ""
sql "SELECT COUNT(*) ops, ROUND(MAX(edge_usd)::numeric,4) best_edge, ROUND(SUM(max_profit_usdc)::numeric,2) theo_pnl
     FROM polymarket_arb_ops WHERE detected_at > now() - interval '48 hours';" 2>/dev/null

echo "═══ Polymarket paper-позиции ═══"
sql "SELECT id, outcome, entry_price, close_price, pnl_usdc, close_reason, is_active, created_at
     FROM polymarket_positions ORDER BY created_at DESC LIMIT 15;"
sql "SELECT COUNT(*) FILTER (WHERE is_active) open_now,
            COUNT(*) FILTER (WHERE NOT is_active) closed,
            COUNT(*) FILTER (WHERE pnl_usdc > 0) wins,
            ROUND(COALESCE(SUM(pnl_usdc),0)::numeric,2) pnl
     FROM polymarket_positions WHERE is_dry_run;"

echo "═══ Логи autobuy 24ч: skip/pass ═══"
if [ -n "$AUTOBUY" ]; then
  docker logs "$AUTOBUY" --since 24h 2>&1 | grep -oE '✗[a-zA-Z0-9_-]+' | sort | uniq -c | sort -rn | head -20
  echo "--- PASS ---"
  docker logs "$AUTOBUY" --since 24h 2>&1 | grep -cE '🟢 PASS'
  docker logs "$AUTOBUY" --since 24h 2>&1 | grep -E '✅ Buy|Opened|Fear&Greed' | tail -10
  echo "--- Ошибки ---"
  docker logs "$AUTOBUY" --since 24h 2>&1 | grep -iE 'error|failed' | tail -15
fi
echo "--- Futures 24ч ---"
[ -n "$FUTURES" ] && docker logs "$FUTURES" --since 24h 2>&1 | grep -E 'Signal|Guard|LONG|SHORT' | tail -20
echo "--- Polymarket 24ч ---"
[ -n "$POLY" ] && docker logs "$POLY" --since 24h 2>&1 | tail -20
echo "DONE $(date -u)"
REMOTE

echo ""
echo ">>> Отчёт: $OUT"
