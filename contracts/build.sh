#!/usr/bin/env bash
# Build the clause, factory and mock-ft wasm with cargo-near.
# Output: ${CARGO_TARGET_DIR:-target}/near/<crate>/<crate>.wasm
set -euo pipefail
cd "$(dirname "$0")"
for crate in clause factory mock-ft; do
  cargo near build non-reproducible-wasm --manifest-path "$crate/Cargo.toml" --locked
done
ls -l "${CARGO_TARGET_DIR:-target}"/near/*/*.wasm
