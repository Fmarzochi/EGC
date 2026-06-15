#!/bin/bash -eu

cd $SRC/egc/mcp/servers/egc-guardian
npm ci
npm run build

cd $SRC/egc/fuzz
npm ci

cd $SRC/egc
npm ci

cd $SRC
compile_javascript_fuzzer egc fuzz/fuzz-validator.js
