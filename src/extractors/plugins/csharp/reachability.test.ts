import { describe, it, expect } from "vitest";
import { csharpReachability } from "./reachability.js";
import type { FileAnalysis } from "../../../types/analysis.js";

const analysis = (filePath: string, cls: Record<string, unknown>): FileAnalysis =>
  ({ filePath, classes: [{ extends: null, implements: [], decorators: [], methods: [], ...cls }], functions: [], routes: [] }) as unknown as FileAnalysis;
const none = new Set<string>();

describe("C# reachability — what PowerShell and the compiler load", () => {
  it("keeps cmdlets, source generators, analyzers and code fixes alive", async () => {
    const m = await csharpReachability.load({ projectRoot: "/nonexistent", roots: [], files: new Set<string>() });
    const passive = (a: FileAnalysis) => m.passiveReason!(a, a.filePath, none);
    expect(passive(analysis("GetFoo.cs", { name: "GetFooCommand", extends: "PSCmdlet", decorators: ['Cmdlet(VerbsCommon.Get, "Foo")'] }))).not.toBeNull();
    expect(passive(analysis("MyGen.cs", { name: "MyGen", extends: "IIncrementalGenerator", decorators: ["Generator"] }))).not.toBeNull();
    expect(passive(analysis("Fix.cs", { name: "Fix", extends: "CodeFixProvider" }))).not.toBeNull();
    expect(passive(analysis("Orphan.cs", { name: "OrphanThing" }))).toBeNull();
  });
});
