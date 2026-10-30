#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
layout_tmp=$(mktemp -d)
trap 'rm -rf "$layout_tmp"' EXIT
cargo run --quiet -p mgk-perps-core --example export_layouts > "$layout_tmp/program-layouts.json"
MGK_RESULTS_FIXTURE="$layout_tmp/results-layout.json" cargo test --quiet -p mgk-perps-matcher export_results_fixture -- --ignored
cmp mgk-frontend/packages/layout/program-layouts.json "$layout_tmp/program-layouts.json"
cmp mgk-frontend/packages/layout/results-layout.json "$layout_tmp/results-layout.json"
node mgk-frontend/packages/layout/generate-types.js --check
