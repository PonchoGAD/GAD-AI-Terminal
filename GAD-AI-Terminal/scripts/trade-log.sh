#!/bin/bash
# Trade log — appended every 12h via cron
# Tracks all autobuy positions, PnL, win rate
# Cron: 0 */12 * * * /opt/gad-ai-terminal/GAD-AI-Terminal/scripts/trade-log.sh

LOG=/opt/gad-ai-terminal/trade-log.md
DB_CMD="docker compose -f /opt/gad-ai-terminal/GAD-AI-Terminal/docker-compose.yml exec -T postgres psql -U gad -d gad_ai"
NOW=$(date '+%Y-%m-%d %H:%M UTC')

{
echo ""
echo "---"
echo ""
echo "## $NOW"
echo ""

# Summary stats
$DB_CMD -t -c "
SELECT
  COUNT(*) AS total_trades,
  COUNT(*) FILTER (WHERE total_sold_sol >= amount_sol) AS wins,
  COUNT(*) FILTER (WHERE total_sold_sol > 0 AND total_sold_sol < amount_sol) AS losses,
  COUNT(*) FILTER (WHERE total_sold_sol = 0) AS no_sell,
  ROUND(SUM(amount_sol)::numeric, 4) AS total_spent,
  ROUND(SUM(total_sold_sol)::numeric, 4) AS total_received,
  ROUND((SUM(total_sold_sol) - SUM(amount_sol))::numeric, 4) AS net_pnl_sol,
  ROUND(COUNT(*) FILTER (WHERE total_sold_sol >= amount_sol) * 100.0 / NULLIF(COUNT(*) FILTER (WHERE total_sold_sol > 0), 0), 1) AS win_rate_pct
FROM autobuy_jobs
WHERE bought_at > NOW() - INTERVAL '24 hours';
" | awk 'NR==1{
  split($0, a, "|")
  printf "### 24h Summary\n"
  printf "| Trades | Wins | Losses | No-sell | Spent | Received | Net PnL | Win%% |\n"
  printf "|--------|------|--------|---------|-------|----------|---------|-------|\n"
  for(i=1;i<=NF;i++) gsub(/^ +| +$/,"",a[i])
  printf "| %s | %s | %s | %s | %s SOL | %s SOL | %s SOL | %s%% |\n", a[1],a[2],a[3],a[4],a[5],a[6],a[7],a[8]
}'

echo ""
echo "### Recent Trades (last 24h)"
echo "| Token | Type | Spent | Received | Result | Time |"
echo "|-------|------|-------|----------|--------|------|"

$DB_CMD -t -c "
SELECT
  SPLIT_PART(label, ':', 4) AS token,
  SPLIT_PART(label, ':', 3) AS type,
  amount_sol,
  ROUND(total_sold_sol::numeric, 4) AS received,
  CASE
    WHEN total_sold_sol = 0 THEN 'NO_SELL'
    WHEN total_sold_sol >= amount_sol * 1.05 THEN '✅ +' || ROUND(((total_sold_sol/amount_sol - 1)*100)::numeric, 1) || '%'
    ELSE '❌ ' || ROUND(((total_sold_sol/amount_sol - 1)*100)::numeric, 1) || '%'
  END AS result,
  TO_CHAR(bought_at AT TIME ZONE 'UTC', 'HH24:MI') AS time
FROM autobuy_jobs
WHERE bought_at > NOW() - INTERVAL '24 hours'
ORDER BY bought_at DESC
LIMIT 30;
" | while IFS='|' read token type spent received result time; do
  token=$(echo "$token" | xargs)
  type=$(echo "$type" | xargs)
  spent=$(echo "$spent" | xargs)
  received=$(echo "$received" | xargs)
  result=$(echo "$result" | xargs)
  time=$(echo "$time" | xargs)
  [ -z "$token" ] && continue
  echo "| $token | $type | ${spent} SOL | ${received} SOL | $result | $time |"
done

echo ""
echo "### Filter Stats (Raydium rejections last scan)"
docker logs gad-ai-autobuy --since=1h 2>&1 | grep 'No entries' | tail -3 | while read line; do
  echo "- $line"
done

echo ""
echo "### HOT/NEW filter rejections (last 30min)"
docker logs gad-ai-autobuy --since=30m 2>&1 | grep -E '✗hot|✗new' | sed 's/\[bonding-scan\] //' | sort | uniq -c | sort -rn | head -10 | while read count rest; do
  echo "- ${count}x $rest"
done

echo ""
echo "### Wallet Balances"
RPC=$(grep '^SOLANA_RPC=' /opt/gad-ai-terminal/GAD-AI-Terminal/.env | sed 's/^SOLANA_RPC=//')
W1=EL4mS7XgNPWRLca38vHu8JHPhpZcupLKuMipPNJeNwqt
W2=CFmHWpmQki6dDhV9G82JWCq68x2axTwdnKDQvu7dPTcL
B1=$(curl -s -X POST "$RPC" -H 'Content-Type: application/json' -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"getBalance\",\"params\":[\"$W1\"]}" | python3 -c 'import sys,json; r=json.load(sys.stdin); print(round(r["result"]["value"]/1e9,4))' 2>/dev/null || echo '?')
B2=$(curl -s -X POST "$RPC" -H 'Content-Type: application/json' -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"getBalance\",\"params\":[\"$W2\"]}" | python3 -c 'import sys,json; r=json.load(sys.stdin); print(round(r["result"]["value"]/1e9,4))' 2>/dev/null || echo '?')
echo "- W1 (Raydium/EL4mS7Xg): **${B1} SOL**"
echo "- W2 (HOT+NEW/CFmHWpmQ): **${B2} SOL**"

} >> "$LOG"

echo "Trade log updated: $LOG"
