#!/usr/bin/env bash
# Build the clause, factory and mock-ft wasm.
# Output: ${CARGO_TARGET_DIR:-target}/near/<crate>/<crate_underscored>.wasm
#
# Uses `cargo near build` when cargo-near is installed. Otherwise it runs the
# same two steps cargo-near runs (cargo-near-build 0.11): a release build for
# wasm32-unknown-unknown with `-C link-arg=-s --cfg near`, then
# `wasm-opt -Oz --enable-bulk-memory --enable-nontrapping-float-to-int`
# (rustc >= 1.87 emits those opcodes; nearcore >= 2.12 / protocol 84 accepts them).
set -euo pipefail
cd "$(dirname "$0")"
OUT="${CARGO_TARGET_DIR:-target}"

if cargo near --version >/dev/null 2>&1 && [ -z "${NO_CARGO_NEAR:-}" ]; then
  for crate in clause factory mock-ft; do
    cargo near build non-reproducible-wasm --manifest-path "$crate/Cargo.toml" --locked
  done
else
  command -v wasm-opt >/dev/null || { echo "need cargo-near or wasm-opt (binaryen)" >&2; exit 1; }
  echo "cargo-near not found: building with cargo + wasm-opt (same flags)"
  for crate in clause factory mock-ft; do
    name="${crate//-/_}"
    CARGO_ENCODED_RUSTFLAGS=$'-C\x1flink-arg=-s\x1f--cfg\x1fnear' \
      cargo build -p "$crate" --lib --target wasm32-unknown-unknown --release --locked
    mkdir -p "$OUT/near/$crate"
    wasm-opt -Oz --enable-bulk-memory --enable-nontrapping-float-to-int \
      "$OUT/wasm32-unknown-unknown/release/$name.wasm" -o "$OUT/near/$crate/$name.wasm"
  done
fi
ls -l "$OUT"/near/*/*.wasm
