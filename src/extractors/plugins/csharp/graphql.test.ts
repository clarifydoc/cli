import { describe, it, expect } from "vitest";
import { collectHotChocolateFacts, hotChocolateResolver } from "./graphql.js";
import type { ClassInfo, FileAnalysis, FunctionInfo, RouteFact } from "../../../types/analysis.js";

const method = (name: string, params: Array<[string, string]>, extra: Partial<FunctionInfo> = {}) =>
  ({ name, params: params.map(([n, t]) => ({ name: n, type: t, defaultValue: null })), calls: [], line: 3, endLine: 4, decorators: [], isExported: true, isAsync: false, returnType: null, ...extra }) as FunctionInfo;
const cls = (name: string, methods: FunctionInfo[], extra: Partial<ClassInfo> = {}) =>
  ({ name, extends: null, implements: [], decorators: [], methods, properties: [], isExported: true, line: 1, endLine: 9, ...extra }) as ClassInfo;
const file = (filePath: string, classes: ClassInfo[], extra: Partial<FileAnalysis> = {}) =>
  ({ filePath, language: "csharp", imports: [], classes, functions: [], routes: [], ...extra }) as unknown as FileAnalysis;

describe("HotChocolate root types", () => {
  it("reads registered, attributed and conventional root classes as fields named HotChocolate's way", () => {
    const facts: RouteFact[] = [];
    collectHotChocolateFacts(`builder.Services.AddSingleton<BookStore>();
builder.Services.AddGraphQLServer().AddQueryType<RootQuery>().AddTypeExtension<BookQueries>().AddMutationType<Mutation>();`, facts);
    expect(facts.map((f) => f.data)).toEqual([{ types: ["BookStore"] }, { root: "Query", cls: "RootQuery" }, { root: null, cls: "BookQueries" }, { root: "Mutation", cls: "Mutation" }]);
    const program = file("Program.cs", [], { routeFacts: facts });
    const root = file("RootQuery.cs", [cls("RootQuery", [method("GetVersion", [])])]);
    const books = file("BookQueries.cs", [cls("BookQueries", [
      method("GetBookByIdAsync", [["id", "int"], ["db", "AppDbContext"], ["ct", "CancellationToken"]], { decorators: ["Authorize(Policy = \"Admin\")"] }),
      method("Helper", [], { isExported: false }),
    ], { decorators: ["ExtendObjectType(OperationTypeNames.Query)"], properties: [{ name: "Greeting", type: "string", visibility: "public", isStatic: false, isReadonly: true, decorators: ["GraphQLName(\"hello\")"] }] })], { imports: [{ source: "HotChocolate.Types" } as never] });
    const mutation = file("Mutation.cs", [cls("Mutation", [method("AddBook", [["input", "BookInput"], ["repo", "BookRepository"], ["store", "BookStore"]])])]);
    const plain = file("Query.cs", [cls("Query", [method("Ignored", [])])]);
    hotChocolateResolver.resolve([program, root, books, mutation, plain], {} as never);
    const rows = [root, books, mutation, plain].flatMap((a) => a.routes.map((r) => `${r.path} → ${r.handler}${r.params?.length ? ` (${r.params.map((p) => p.name).join(", ")})` : ""}${r.middleware.length ? ` [${r.middleware.join("; ")}]` : ""}`));
    expect(rows).toEqual([
      "/graphql/version → RootQuery.GetVersion",
      "/graphql/bookById → BookQueries.GetBookByIdAsync (id) [Authorize(Policy = \"Admin\")]",
      "/graphql/hello → BookQueries.Greeting",
      "/graphql/addBook → Mutation.AddBook (input)",
    ]);
  });
});
