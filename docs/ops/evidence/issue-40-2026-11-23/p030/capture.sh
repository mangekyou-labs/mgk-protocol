#!/bin/zsh
# P0-30 capture: indexer status, market prices, taker fill count every 30s for <minutes>,
# then final trades/fills dumps. Public indexer API only; no keys.
#   capture.sh <outdir> <minutes>
set -u
OUT=$1 MIN=$2
API=https://mgk-indexer-q6sz.onrender.com/api
TAKER=BeBT1zZAcPxeze8wiWNR7JFfPJL2QRPjd1cg26WJeXFe
mkdir -p $OUT
end=$((SECONDS + MIN * 60))
while (( SECONDS < end )); do
  t=$(date -u +%FT%TZ)
  s=$(curl -s -m 20 $API/status | jq -c '{severity,ix:{severity:.checks.indexer.severity,lagSlots:.checks.indexer.lagSlots,syncing:.checks.indexer.syncing}}' 2>/dev/null || echo unavailable)
  m=$(curl -s -m 20 $API/markets | jq -c '.markets[0]|{last_price,mark_price}' 2>/dev/null || echo unavailable)
  f=$(curl -s -m 20 "$API/users/$TAKER/fills" | jq -c 'if type=="array" then length else (.fills|length) end' 2>/dev/null || echo unavailable)
  echo "$t status=${s:-unavailable} markets=${m:-unavailable} takerFills=${f:-unavailable}" | tee -a $OUT/capture.log
  sleep 30
done
curl -s -m 30 "$API/users/$TAKER/fills" > $OUT/taker-fills.json
curl -s -m 30 "$API/markets/0/trades" > $OUT/trades.json
echo "$(date -u +%FT%TZ) capture done" | tee -a $OUT/capture.log
