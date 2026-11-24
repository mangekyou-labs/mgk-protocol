#!/bin/zsh
# Render suspend/resume drill with status capture. No keypairs.
#   drill.sh <oracle|maker|indexer> <outdir> <hold-seconds> [restart]
# "restart" mode: POST /restart instead of suspend/resume (indexer cold start).
set -u
typeset -A SRV=(maker srv-dbu6958u01pc73dq36rg oracle srv-dbu693sipgvc73ares4g indexer srv-dbu690g8v5cc73c2409g)
NAME=$1 OUT=$2 HOLD=$3 MODE=${4:-suspend}
ID=${SRV[$NAME]}
STATUS=https://mgk-indexer-q6sz.onrender.com/api/status
set -a; . ~/repos/mgk-protocol/.worktrees/feature-issue-39-integration/.env; set +a
mkdir -p $OUT
render() { local c; for i in {1..10}; do c=$(curl -s -m 30 -o /dev/null -w "%{http_code}" -X POST -H "Authorization: Bearer $MIGRATE_RENDER_API_KEY" "https://api.render.com/v1/services/$ID/$1"); [[ $c == 2* ]] && break; sleep 15; done; echo "$c (attempt $i)"; }
snap() { local t=$(date -u +%Y%m%dT%H%M%SZ); curl -s -m 30 $STATUS > $OUT/status-$t-$1.json; echo "$t $1 $(node -e 'try{const j=require(process.argv[1]);const c=j.checks;console.log(j.severity,"oracle",c.oracle.severity,c.oracle.ageSeconds,"maker",c.makerDepth.severity,JSON.stringify({bid:c.makerDepth.bid,ask:c.makerDepth.ask}),"batch",c.batch.severity,c.batch.batchId,c.batch.phase,c.batch.ageSeconds,"indexer",c.indexer.severity,c.indexer.lagSlots,c.indexer.syncing)}catch(e){console.log("unparsable")}' $OUT/status-$t-$1.json)" | tee -a $OUT/timeline.txt; }
snap baseline
if [[ $MODE == restart ]]; then
  echo "$(date -u +%FT%TZ) restart $NAME -> $(render restart)" | tee -a $OUT/timeline.txt
else
  echo "$(date -u +%FT%TZ) suspend $NAME -> $(render suspend)" | tee -a $OUT/timeline.txt
fi
end=$((SECONDS + HOLD)); while (( SECONDS < end )); do sleep 20; snap down; done
if [[ $MODE != restart ]]; then
  echo "$(date -u +%FT%TZ) resume $NAME -> $(render resume)" | tee -a $OUT/timeline.txt
fi
for i in {1..30}; do sleep 20; snap recover; done
