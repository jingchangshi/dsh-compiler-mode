#!/usr/bin/env bash
# Build and run the fixture tests. Exit code is the verdict.
set -u
root="$(cd "$(dirname "$0")" && pwd)"
cxx="${CXX:-clang++}"
out="$root/build"
mkdir -p "$out"
if ! "$cxx" -std=c++17 -O1 -I"$root/include" "$root/src/ircount.cpp" "$root/tests/test_ircount.cpp" -o "$out/test_ircount" 2>"$out/build.log"; then
  echo "BUILD FAILED"; sed -n '1,40p' "$out/build.log"; exit 2
fi
"$out/test_ircount"
