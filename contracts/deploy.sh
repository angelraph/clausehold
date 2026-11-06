#!/usr/bin/env bash
# Deploy the Clausehold factory to testnet or mainnet with near-cli-rs.
#
#   ./deploy.sh testnet            # free: faucet NEAR + mock test FT (judges' path)
#   CONFIRM=mainnet ./deploy.sh mainnet   # real NEAR, real USDC
#
# Env:
#   FACTORY   factory account   (default clausehold.<network>)
#   COSIGNER  mandate co-signer (default: the factory account)
#   DAO       if set, ownership is handed to this account at the end
#   ASSET     FT contract id    (mainnet default: native USDC; testnet: musd.$FACTORY, deployed here)
#
# Build first: ./build.sh. The factory account must exist and be in your keychain
# (testnet: `near account create-account sponsor-by-faucet-service $FACTORY ...`).
set -euo pipefail
cd "$(dirname "$0")"

NET="${1:-}"
case "$NET" in
  testnet) TLA=testnet ;;
  mainnet) TLA=near
    if [ "${CONFIRM:-}" != "mainnet" ]; then
      echo "mainnet spends real NEAR. Re-run with CONFIRM=mainnet." >&2; exit 1
    fi ;;
  *) echo "usage: $0 testnet|mainnet" >&2; exit 1 ;;
esac

FACTORY="${FACTORY:-clausehold.$TLA}"
COSIGNER="${COSIGNER:-$FACTORY}"
OUT="${CARGO_TARGET_DIR:-target}/near"
SIGN=(network-config "$NET" sign-with-keychain send)

for f in factory/factory.wasm clause/clause.wasm; do
  [ -f "$OUT/$f" ] || { echo "missing $OUT/$f; run ./build.sh" >&2; exit 1; }
done

if [ "$NET" = mainnet ]; then
  ASSET="${ASSET:-17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1}"
  # Small caps for the demo. 6 decimals.
  MAX=5000000 PAYEE_DAY=10000000 DAY=20000000 NEW_PAYEE=3000000
else
  ASSET="${ASSET:-musd.$FACTORY}"
  # Matches the hosted desk demo: 25 per clause, 50 per payee a day, 200 a day, 10 for a new payee.
  MAX=25000000 PAYEE_DAY=50000000 DAY=200000000 NEW_PAYEE=10000000
fi

echo "== deploy factory to $FACTORY ($NET)"
near contract deploy "$FACTORY" use-file "$OUT/factory/factory.wasm" \
  with-init-call new json-args "{\"owner\":\"$FACTORY\",\"mandate\":null}" \
  prepaid-gas '30 Tgas' attached-deposit '0 NEAR' "${SIGN[@]}"

echo "== upload clause wasm"
near contract call-function as-transaction "$FACTORY" set_clause_code \
  file-args "$OUT/clause/clause.wasm" prepaid-gas '300 Tgas' attached-deposit '0 NEAR' \
  sign-as "$FACTORY" "${SIGN[@]}"

if [ "$NET" = testnet ] && [ "$ASSET" = "musd.$FACTORY" ]; then
  [ -f "$OUT/mock-ft/mock_ft.wasm" ] || { echo "missing mock_ft.wasm; run ./build.sh" >&2; exit 1; }
  echo "== test FT at $ASSET (public faucet(): 100 mUSD per account; testnet only)"
  near account create-account fund-myself "$ASSET" '5 NEAR' autogenerate-new-keypair \
    save-to-keychain sign-as "$FACTORY" "${SIGN[@]}"
  near contract deploy "$ASSET" use-file "$OUT/mock-ft/mock_ft.wasm" \
    with-init-call new json-args '{}' prepaid-gas '30 Tgas' attached-deposit '0 NEAR' "${SIGN[@]}"
fi

echo "== set mandate"
MANDATE="{\"allowed_assets\":[\"$ASSET\"],\"max_per_clause\":\"$MAX\",\"per_payee_daily_cap\":\"$PAYEE_DAY\",\"daily_cap\":\"$DAY\",\"new_payee_ceiling\":\"$NEW_PAYEE\",\"paused\":false,\"cosigner\":\"$COSIGNER\",\"creators\":[]}"
near contract call-function as-transaction "$FACTORY" set_mandate \
  json-args "{\"mandate\":$MANDATE}" prepaid-gas '30 Tgas' attached-deposit '0 NEAR' \
  sign-as "$FACTORY" "${SIGN[@]}"

if [ -n "${DAO:-}" ]; then
  echo "== hand ownership to $DAO"
  near contract call-function as-transaction "$FACTORY" set_owner \
    json-args "{\"owner\":\"$DAO\"}" prepaid-gas '30 Tgas' attached-deposit '0 NEAR' \
    sign-as "$FACTORY" "${SIGN[@]}"
fi

echo "== done: $FACTORY on $NET, asset $ASSET"
near contract call-function as-read-only "$FACTORY" create_deposit json-args '{}' network-config "$NET" now
