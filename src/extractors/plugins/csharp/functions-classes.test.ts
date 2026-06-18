import { describe, it, expect } from "vitest";
import "../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../parsers/parser-manager.js";
import { extractClasses } from "../../functions-classes/index.js";
import type { ClassInfo } from "../../functions-classes/base.js";

async function classesOf(src: string): Promise<ClassInfo[]> {
  const tree = await parseSource(src, "csharp" as any, "C.cs");
  return extractClasses(tree, src, "csharp");
}

describe("C# functions-classes — record/struct extraction", () => {
  it("captures `record` (CQRS command/query) types as classes with their base", async () => {
    const SRC = `namespace X;
public record GetRoleHoldersQuery(Guid RoleId, int Page = 1) : IRequest<int>;
public record CreateOwnerCommand(string Name) : IRequest<Guid>;`;
    const classes = await classesOf(SRC);
    const names = classes.map((c) => c.name);
    expect(names).toContain("GetRoleHoldersQuery");
    expect(names).toContain("CreateOwnerCommand");
    // The MediatR base must be captured so the dispatch resolver can read it.
    const q = classes.find((c) => c.name === "GetRoleHoldersQuery")!;
    expect([q.extends, ...(q.implements ?? [])].join(" ")).toMatch(/IRequest</);
  });

  it("captures `record struct` types (e.g. the ErrorOr `Error` factory)", async () => {
    const SRC = `namespace X;
public readonly record struct Error {
  public static Error Forbidden(string code) => default;
}`;
    const classes = await classesOf(SRC);
    const err = classes.find((c) => c.name === "Error");
    expect(err).toBeDefined();
    expect(err!.methods.map((m) => m.name)).toContain("Forbidden");
  });
});
