#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

out=".zero/sanitizer/zero"
mkdir -p "$(dirname "$out")"

cc -std=c11 -Wall -Wextra -Wpedantic -g -O1 -fsanitize=address,undefined -I native/zero-c/include native/zero-c/src/*.c -o "$out"

"$out" --version >/dev/null
"$out" check examples/hello.0 >/dev/null
"$out" build --json --target linux-musl-x64 examples/hello.0 --out .zero/sanitizer/hello-linux >/dev/null
"$out" check conformance/native/pass/stdlib-target-neutral.0 >/dev/null
"$out" run conformance/native/pass/stdlib-target-neutral.0 >/dev/null
"$out" graph --json examples/memory-package >/dev/null
"$out" size --json examples/memory-package >/dev/null
"$out" size --json examples/std-data-formats.0 >/dev/null
"$out" mem --json examples/hello.0 >/dev/null
