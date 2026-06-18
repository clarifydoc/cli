import { describe, it, expect } from "vitest";
import { buildSymbolLinks } from "./symbol-linker.js";
import type { CallInfo, FileAnalysis } from "../types/analysis.js";

const call = (name: string, line = 2): CallInfo => ({ name, kind: "internal", target: null, line });

const fn = (name: string, calls: CallInfo[]) =>
  ({ name, line: 1, endLine: 5, params: [], calls } as any);

const cls = (name: string) =>
  ({ name, kind: "class", extends: null, implements: [], methods: [], properties: [], line: 1, endLine: 3 } as any);

const file = (filePath: string, projectId: string, opts: { functions?: any[]; classes?: any[] }): FileAnalysis =>
  ({
    filePath,
    projectId,
    language: "csharp",
    functions: opts.functions ?? [],
    classes: opts.classes ?? [],
    imports: [],
    exports: [],
    routes: [],
    dataSources: [],
  } as unknown as FileAnalysis);

describe("symbol-linker — C# cross-project + generic type-arg resolution", () => {
  it("resolves `new XCommand()` to its record in another sub-project (unique name)", () => {
    const api = file("Api/OwnersController.cs", "Api", {
      classes: [{ ...cls("OwnersController"), methods: [fn("Create", [call("new CreateOwnerCommand")])] }],
    });
    const app = file("Application/CreateOwnerCommand.cs", "Application", { classes: [cls("CreateOwnerCommand")] });
    const links = buildSymbolLinks([api, app]);
    expect(links.some((l) => l.targetFile === "Application/CreateOwnerCommand.cs")).toBe(true);
  });

  it("resolves a generic type argument (`_db.Set<Account>()`) to the unique type's file", () => {
    const repo = file("Infra/AccountRepository.cs", "Infra", {
      classes: [{ ...cls("AccountRepository"), methods: [fn("GetAll", [call("_db.Set<Account>")])] }],
    });
    const domain = file("Domain/Account.cs", "Domain", { classes: [cls("Account")] });
    const links = buildSymbolLinks([repo, domain]);
    expect(links.some((l) => l.targetFile === "Domain/Account.cs")).toBe(true);
  });

  it("does NOT resolve a generic arg when the type name is not globally unique (avoids false edges)", () => {
    const repo = file("Infra/AccountRepository.cs", "Infra", {
      classes: [{ ...cls("AccountRepository"), methods: [fn("GetAll", [call("_db.Set<Account>")])] }],
    });
    const d1 = file("Domain/Account.cs", "Domain", { classes: [cls("Account")] });
    const d2 = file("Scaffold/Account.cs", "Infra", { classes: [cls("Account")] });
    const links = buildSymbolLinks([repo, d1, d2]);
    expect(links.some((l) => /Account\.cs$/.test(l.targetFile) && l.sourceFile === "Infra/AccountRepository.cs")).toBe(false);
  });
});
