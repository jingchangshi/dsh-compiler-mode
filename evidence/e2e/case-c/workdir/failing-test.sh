#!/usr/bin/env bash
# A test that fails on purpose: Case C needs a real non-zero exit code.
echo "RUN 3 checks"
echo "ok   check-1"
echo "FAIL check-2: expected 42, got 41" >&2
echo "ok   check-3"
exit 3
