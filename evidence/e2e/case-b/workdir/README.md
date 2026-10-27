# Case B fixture — a real, small MLIR/C++ defect with a repeatable test

This directory is a self-contained mini project used by Case B. It is **not** part of
AscendNPU-IR or TileLang; nothing outside this directory is touched.

The defect is deliberately small and in the same *shape* as compiler work: an IR node counter
used by a pass that must be correct across reset/merge cycles.

```
case-b-fixture/
|-- CMakeLists.txt        # plain CMake, no MLIR dependency: builds in < 10 s
|-- include/ircount.h
|-- src/ircount.cpp
|-- tests/test_ircount.cpp
|-- run-tests.sh          # builds + runs; exit code IS the verdict
```

- `run-tests.sh` exits non-zero when the defect is present.
- `README-DEFECT.md` (only in the *bugged* copy under `workdir/`) describes the symptom a user
  would report — not the cause.

The acceptance harness copies this fixture into a scratch directory, applies the bugged patch,
hands the work to the agent, and verifies afterwards that the test passes **and** that no file
outside the scratch directory changed.
