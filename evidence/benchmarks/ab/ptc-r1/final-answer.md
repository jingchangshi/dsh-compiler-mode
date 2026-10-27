```json
{
  "transformFiles": 13,
  "passClasses": 5,
  "chosen": {
    "file": "bishengir/lib/Transforms/DebugLLVM.cpp",
    "declarationLine": 942,
    "declarationText": "struct DebugLLVMPass : public bishengir::impl::DebugLLVMBase<DebugLLVMPass> {"
  },
  "lsp": {
    "operation": "goToDefinition",
    "file": "bishengir/lib/Transforms/DebugLLVM.cpp",
    "line": 942,
    "character": 9,
    "result": "locations",
    "locations": [
      {
        "uri": "file:///home/s00653124/workspace/AscendNPU-IR-1/bishengir/lib/Transforms/DebugLLVM.cpp",
        "range": {
          "start": { "line": 941, "character": 7 },
          "end": { "line": 941, "character": 20 }
        }
      }
    ],
    "resolvedWorkspaceUri": "file:///home/s00653124/workspace/AscendNPU-IR-1",
    "note": "LSP ranges are zero-based; this is the same declaration at 1-based line 942 (columns 8-21), the `struct DebugLLVMPass` name. No separate out-of-line definition exists, so the definition resolves to the declaration itself."
  }
}
```