import { describe, it, expect } from "vitest";
import { isGeneratedFile } from "./generated-file-detector.js";

/**
 * Generated-code detection was directory-based, so codegen that names FILES
 * rather than folders was invisible: `Form1.Designer.cs` sits beside
 * `Form1.cs`, `user.pb.go` beside `user.go`. Its size, repetition and
 * complexity counted against the team that neither wrote nor maintains it.
 */
describe("isGeneratedFile", () => {
  const cases: Array<[path: string, language: string | undefined, expected: boolean]> = [
    // C#: designers and source generators — but not a hand-written *Designer class.
    ["src/Forms/FrmMain.Designer.cs", "csharp", true],
    ["src/Forms/Resources.g.cs", "csharp", true],
    ["src/Reports/ReportDesigner.cs", "csharp", false],
    ["src/Forms/FrmMain.cs", "csharp", false],
    // Go: protoc output, not an ordinary file that merely mentions pb.
    ["api/user.pb.go", "go", true],
    ["api/user.pb.gw.go", "go", true],
    ["api/pbutil.go", "go", false],
    // Python
    ["proto/models_pb2.py", "python", true],
    ["proto/models_pb2_grpc.py", "python", true],
    ["proto/pb2_helpers.py", "python", false],
    // Dart build_runner
    ["lib/models/user.g.dart", "dart", true],
    ["lib/models/user.freezed.dart", "dart", true],
    ["lib/models/user.dart", "dart", false],
    // VB designers
    ["Forms/Main.Designer.vb", "vb", true],
    // The one cross-language convention applies without a language.
    ["src/api/client.generated.ts", undefined, true],
    ["src/api/client.generated.ts", "typescript", true],
    ["src/api/client.ts", "typescript", false],
  ];

  for (const [path, language, expected] of cases) {
    it(`${expected ? "flags" : "leaves"} ${path}`, () => {
      expect(isGeneratedFile(path, language as never)).toBe(expected);
    });
  }

  it("does not apply another language's convention", () => {
    // `.g.cs` is C#; a Dart file named that way is not the same thing.
    expect(isGeneratedFile("lib/thing.g.cs", "dart")).toBe(false);
  });
});
