# Usage: docker build --output release .   -> release/crx-blocker-extension-<version>.zip
# The commands mirror the scripts in package.json, split by toolchain: keep both in sync.

# Build rust wasm
FROM rust:1.96.1-slim-bookworm@sha256:e18a79fc84dfcfc3ab5ba72290398a644c135c97eaa881447fddc354ee4701a3 AS wasm

# must match the wasm-bindgen crate version in features/Cargo.toml and filterlists/Cargo.toml
RUN rustup target add wasm32-unknown-unknown
RUN cargo install --locked wasm-bindgen-cli@0.2.126

WORKDIR /src
COPY features features
COPY filterlists filterlists

# build:features
RUN cargo build --release --target wasm32-unknown-unknown --manifest-path features/Cargo.toml
RUN wasm-bindgen --target web --out-dir features/pkg features/target/wasm32-unknown-unknown/release/adflush_features.wasm

# build:filterlists
RUN cargo build --release --lib --target wasm32-unknown-unknown --manifest-path filterlists/Cargo.toml 
RUN wasm-bindgen --target web --out-dir filterlists/pkg filterlists/target/wasm32-unknown-unknown/release/filterlists.wasm 
RUN cargo run --release --manifest-path filterlists/Cargo.toml --bin compile -- filterlists/pkg filterlists/data/*.txt

# Build extension
FROM oven/bun:1.3.13@sha256:87416c977a612a204eb54ab9f3927023c2a3c971f4f345a01da08ea6262ae30e AS build

WORKDIR /src
COPY . .
COPY --from=wasm /src/features/pkg features/pkg
COPY --from=wasm /src/filterlists/pkg filterlists/pkg
# test and build without their build:features/build:filterlists steps
RUN bun install --frozen-lockfile 

RUN bunx vitest run 
RUN bunx tsc -b 

RUN bunx vite build

# Image with nothing but the release
FROM scratch
COPY --from=build /src/release/ /
