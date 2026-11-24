#!/bin/zsh
E=$HOME/.cache/mgk-issue-40/aac36b5
cd /tmp/lrows-c913b5f || exit 2
export NO_DNA=1 MGK_CANDIDATE_MANIFEST=$E/candidate.json MGK_MAKER_REPORT=$E/maker-runtime-report.json \
  MGK_KEEPER_REPORT=$E/keeper-runtime-report.json MGK_RUNTIME_REPORT=$E/runtime-report.json MGK_CHECKPOINT_B_REPORT=$E/checkpoint-b-report.json
step() { echo "== $1"; shift; "$@"; echo "== exit $?"; }
{
step candidate node tools/runtime/candidate.js $E/deploy $MGK_CANDIDATE_MANIFEST
step indexer-build zsh -c 'pnpm --dir mgk-frontend install --frozen-lockfile --filter indexer... && pnpm --dir mgk-frontend -F @mgk/sdk build && pnpm --dir mgk-frontend -F indexer build && pnpm --dir mgk-frontend -F indexer test'
step tools-install npm install --prefix tools --ignore-scripts --no-audit --no-fund
step lifecycle env BPF_OUT_DIR=$E/deploy cargo test -p mgk-perps-core --test lifecycle --features host-hash
step contract node --test tools/runtime/harness.test.js tools/runtime/invariants.test.js tools/runtime/audit.test.js tools/runtime/rpc.test.js tools/oracle-confidence.test.js tools/gate/report.test.js tools/gate/latency.test.js tools/gate/soak.test.js
step model python3 -m unittest discover -s tools/gate -p 'test_*.py'
step runtime node --test tools/runtime/smoke.test.js tools/runtime/book-init.test.js tools/runtime/indexer.test.js tools/runtime/keeper.test.js tools/runtime/maker.test.js tools/gate/gate.test.js tools/runtime/checkpoint-b.test.js tools/runtime/market-isolation.test.js
} > $E/lrows.log 2>&1
echo done >> $E/lrows.log
