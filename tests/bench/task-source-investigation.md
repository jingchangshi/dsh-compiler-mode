Call run_code for each step; use only the tools bound there.

1. Using `tools.glob` and `tools.grep`, list every file under
   `bishengir/lib/Transforms/` (relative to the workspace root, which is the AscendNPU-IR
   checkout) and count
   how many of them declare a `class` or `struct` whose name ends with `Pass`.
2. For the file with the shortest name that declares such a class, use `tools.read` to fetch it
   and return `{ file, declarationLine, declarationText }`.
3. Use `tools.lsp` with operation `goToDefinition` on that declaration and report the location it
   returns (or the exact error).

Answer with a single JSON object:
`{ "transformFiles": <n>, "passClasses": <n>, "chosen": {...}, "lsp": {...} }`
and nothing else.
