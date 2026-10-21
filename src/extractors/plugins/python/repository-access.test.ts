import { describe, it, expect } from "vitest";
import { PythonEntityExtractor } from "./entities.js";
import type { FileAnalysis } from "../../../types/analysis.js";

const cls = (name: string, o: { extends?: string | null; implements?: string[]; decorators?: string[]; props?: Array<[string, string]>; methods?: any[] } = {}): any => ({
  name, extends: o.extends ?? null, implements: o.implements ?? [], decorators: o.decorators ?? [], isExported: true, line: 1, endLine: 50,
  properties: (o.props ?? []).map(([n, t]) => ({ name: n, type: t, visibility: "public", isStatic: false, isReadonly: false })),
  methods: o.methods ?? [],
});
const method = (name: string, calls: string[], returnType: string | null = null, params: any[] = []): any =>
  ({ name, returnType, params, calls: calls.map((c, i) => ({ name: c, kind: "internal", target: null, line: 10 + i })), line: 10, endLine: 20, isAsync: false, isExported: true, decorators: [] });
const file = (filePath: string, classes: any[], functions: any[] = []): FileAnalysis =>
  ({ filePath, language: "python", classes, functions, dataSources: [], imports: [] } as unknown as FileAnalysis);

/** The repository pattern over a generic base, reached through typed members declared in other files. */
describe("Python generic repository access", () => {
  it("puts the entity-typed argument of the repository's generic base on calls through a typed member chain", () => {
    const model = file("db/models/recipe.py", [cls("RecipeModel", { extends: "SqlAlchemyBase", decorators: ["entity", "sqlalchemy"] })]);
    const generic = file("repos/repository_generic.py", [cls("RepositoryGeneric"), cls("HouseholdRepositoryGeneric", { extends: "RepositoryGeneric[Schema, Model]" })]);
    const recipes = file("repos/repository_recipes.py", [cls("RepositoryRecipes", { extends: "RecipeSuggestionMixin", implements: ["HouseholdRepositoryGeneric[Recipe, RecipeModel]"] })]);
    const factory = file("repos/repository_factory.py", [cls("AllRepositories", { props: [["session", "Session"]], methods: [method("recipes", [], "RepositoryRecipes")] })]);
    const base = file("routes/_base.py", [cls("_BaseController", { props: [["_repos", "AllRepositories | None"]], methods: [method("repos", ["self._repos"])] }), cls("BasePlayerController", { extends: "_BaseController" })]);
    const service = file("services/recipe_service.py", [
      cls("RecipeServiceBase", { props: [["repos", "AllRepositories"]] }),
      cls("RecipeService", { extends: "RecipeServiceBase", methods: [method("create_one", ["self._factory", "self.repos.recipes.create", "self.repos.recipes.get_one"])] }),
    ]);
    const controller = file("routes/recipes.py", [
      cls("RecipeController", { extends: "BasePlayerController", methods: [method("delete_one", ["self.repos.recipes.delete", "self.service.update_one"])] }),
    ]);
    const fn = file("routes/public.py", [], [method("list_recipes", ["repos.recipes.get_all"], null, [{ name: "repos", type: "AllRepositories", defaultValue: null }])]);
    (controller as any).dataSources = [{ kind: "database", name: "self.service.update_one", target: null, entity: "service", line: 11, calls: [] }];

    new PythonEntityExtractor().reconcileProject([model, generic, recipes, factory, base, service, controller, fn]);

    expect(service.dataSources.map((d) => [d.name, d.entity, d.access])).toEqual([
      ["self.repos.recipes.create", "RecipeModel", "write"],
      ["self.repos.recipes.get_one", "RecipeModel", "read"],
    ]);
    expect(controller.dataSources.map((d) => [d.name, d.entity])).toEqual([
      ["self.repos.recipes.delete", "RecipeModel"],
      ["self.service.update_one", "service"], // a service is no repository: untouched
    ]);
    expect(fn.dataSources.map((d) => d.entity)).toEqual(["RecipeModel"]);
  });
});
