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

  it("types a local by the free function that builds it (real-repo FP)", () => {
    const model = file("db/models/player.py", [cls("PlayerModel", { extends: "SqlAlchemyBase", decorators: ["entity", "sqlalchemy"] })]);
    const generic = file("repos/repository_generic.py", [cls("RepositoryGeneric"), cls("RepositoryPlayers", { extends: "RepositoryGeneric[PlayerOut, PlayerModel]" })]);
    const factory = file("repos/repository_factory.py", [cls("AllRepositories", { methods: [method("players", [], "RepositoryPlayers")] })]);
    // `def get_repositories(session): return AllRepositories(session)` — its return type read off the body.
    const builder = file("repos/all_repositories.py", [], [method("get_repositories", [], "AllRepositories")]);
    const route = method("validate_player", ["get_repositories", "db.players.get_one"]);
    route.localTypes = [{ name: "db", type: "", from: "get_repositories()" }];
    const fn = file("routes/validators.py", [], [route]);

    new PythonEntityExtractor().reconcileProject([model, generic, factory, builder, fn]);

    expect(fn.dataSources.map((d) => [d.name, d.entity, d.access])).toEqual([["db.players.get_one", "PlayerModel", "read"]]);
  });

  it("types a computed member by the chain it returns, and follows a repository handed to a wrapper's constructor", () => {
    const model = file("db/models/club.py", [cls("ClubModel", { extends: "SqlAlchemyBase", decorators: ["entity", "sqlalchemy"] })]);
    const generic = file("repos/repository_generic.py", [cls("RepositoryGeneric"), cls("GroupRepositoryGeneric", { extends: "RepositoryGeneric[Schema, Model]" })]);
    const clubs = file("repos/repository_clubs.py", [cls("RepositoryClubs", { extends: "GroupRepositoryGeneric[ClubOut, ClubModel]" })]);
    const factory = file("repos/repository_factory.py", [cls("AllRepositories", { methods: [method("clubs", [], "RepositoryClubs")] })]);
    const wrapper = file("routes/_base/mixins.py", [cls("HttpRepo", {
      props: [["repo", "RepositoryGeneric"]],
      methods: [
        method("__init__", [], null, [{ name: "repo", type: "RepositoryGeneric", defaultValue: null }, { name: "logger", type: "Logger", defaultValue: null }]),
        method("update_one", ["self.repo.get_one", "self.repo.update", "self.handle_exception"]),
        method("get_one", ["self.repo.get_one"]),
      ],
    })]);
    const controller = file("routes/clubs.py", [cls("ClubController", {
      props: [["repos", "AllRepositories"]],
      methods: [
        method("update_one", ["self.mixins.update_one"]),
        method("get_one", ["self.mixins.get_one"]),
        method("delete_one", ["self.repo.delete"]),
        method("audit", ["self.audits.get_one"]),
      ],
    })]);
    const props = (controller.classes[0] as any).properties;
    props.push({ name: "repo", type: null, visibility: "public", isStatic: false, isReadonly: true, from: "self.repos.clubs" });
    props.push({ name: "mixins", type: "HttpRepo", visibility: "public", isStatic: false, isReadonly: true, constructedWith: ["self.repo", "self.logger"] });
    // Built with something the pass cannot type: no entity is guessed.
    props.push({ name: "audits", type: "HttpRepo", visibility: "public", isStatic: false, isReadonly: true, constructedWith: ["make_repo()"] });

    new PythonEntityExtractor().reconcileProject([model, generic, clubs, factory, wrapper, controller]);

    expect(controller.dataSources.map((d) => [d.name, d.entity, d.access])).toEqual([
      ["self.mixins.update_one", "ClubModel", "write"],
      ["self.mixins.get_one", "ClubModel", "read"],
      ["self.repo.delete", "ClubModel", "write"],
    ]);
  });
});

describe("Python repository members assigned from a constructor parameter", () => {
  it("types `self.players = repos.squad_players` by the parameter's type, and prefers the wrapped repository's entity over schema type arguments (real-repo FP)", () => {
    const model = file("db/models/player.py", [cls("PlayerModel", { extends: "SqlAlchemyBase", decorators: ["entity", "sqlalchemy"] })]);
    const generic = file("repos/repository_generic.py", [cls("RepositoryGeneric"), cls("SquadRepositoryGeneric", { extends: "RepositoryGeneric[Schema, Model]" })]);
    const factory = file("repos/repository_factory.py", [cls("AllRepositories", { methods: [method("squad_players", [], "SquadRepositoryGeneric[PlayerOut, PlayerModel]")] })]);
    const schemas = file("schema/player.py", [cls("PlayerCreate"), cls("PlayerOut")]);
    const service = file("services/squad.py", [cls("SquadService", {
      props: [["repos", "AllRepositories"]],
      methods: [
        method("__init__", [], null, [{ name: "repos", type: "AllRepositories", defaultValue: null }]),
        method("release", ["self.players.delete_many"]),
      ],
    })]);
    (service.classes[0] as any).properties.push({ name: "players", type: null, visibility: "public", isStatic: false, isReadonly: false, from: "repos.squad_players" });
    const wrapper = file("routes/_base/mixins.py", [cls("HttpRepo", {
      methods: [method("__init__", [], null, [{ name: "repo", type: "RepositoryGeneric", defaultValue: null }]), method("get_one", ["self.repo.get_one"])],
    })]);
    const controller = file("routes/squad.py", [cls("SquadController", {
      props: [["repos", "AllRepositories"]],
      methods: [method("get_one", ["self.mixins.get_one"])],
    })]);
    const props = (controller.classes[0] as any).properties;
    props.push({ name: "repo", type: null, visibility: "public", isStatic: false, isReadonly: true, from: "self.repos.squad_players" });
    props.push({ name: "mixins", type: "HttpRepo[PlayerCreate, PlayerOut]", visibility: "public", isStatic: false, isReadonly: true, constructedWith: ["self.repo"] });

    new PythonEntityExtractor().reconcileProject([model, generic, factory, schemas, service, wrapper, controller]);

    expect(service.dataSources.map((d) => [d.name, d.entity, d.access])).toEqual([["self.players.delete_many", "PlayerModel", "write"]]);
    expect(controller.dataSources.map((d) => [d.name, d.entity])).toEqual([["self.mixins.get_one", "PlayerModel"]]);
  });
});

describe("Python repositories reached through a method or a free function's result (real-repo FP)", () => {
  const model = () => file("db/models/player.py", [
    cls("PlayerModel", { extends: "SqlAlchemyBase", decorators: ["entity", "sqlalchemy"] }),
    cls("ReportModel", { extends: "SqlAlchemyBase", decorators: ["entity", "sqlalchemy"] }),
  ]);
  const generic = () => file("repos/repository_generic.py", [cls("RepositoryGeneric"), cls("LeagueRepositoryGeneric", { extends: "RepositoryGeneric[Schema, Model]" })]);
  const factory = () => file("repos/repository_factory.py", [cls("AllRepositories", { methods: [
    method("players", [], "LeagueRepositoryGeneric[PlayerOut, PlayerModel]"),
    method("league_reports", [], "LeagueRepositoryGeneric[ReportOut, ReportModel]"),
  ] })]);
  const wrapper = () => file("routes/_base/mixins.py", [cls("HttpRepo", {
    methods: [
      method("__init__", [], null, [{ name: "repo", type: "RepositoryGeneric", defaultValue: null }, { name: "logger", type: "Logger", defaultValue: null }]),
      method("create_one", ["self.repo.create"]),
      method("get_one", ["self.repo.get_one"]),
    ],
  })]);

  it("follows a wrapper a method builds from a repository another method returns", () => {
    const mixins = method("_mixins", [], "HttpRepo", [{ name: "league_id", type: null, defaultValue: null }]);
    mixins.constructedWith = ["self._league_repos(league_id).players", "self.logger"];
    const other = method("_audits", [], "HttpRepo");
    other.constructedWith = ["make_repo(league_id)"];
    const controller = file("routes/admin/players.py", [cls("AdminPlayerController", {
      methods: [
        method("_league_repos", [], "AllRepositories"),
        mixins,
        other,
        method("create_player", ["self._mixins(league_id).create_one"]),
        method("get_player", ["self._mixins(league_id).get_one"]),
        method("audit", ["self._audits().get_one"]),
      ],
    })]);
    new PythonEntityExtractor().reconcileProject([model(), generic(), factory(), wrapper(), controller]);
    expect(controller.dataSources.map((d) => [d.name, d.entity, d.access])).toEqual([
      ["self._mixins(league_id).create_one", "PlayerModel", "write"],
      ["self._mixins(league_id).get_one", "PlayerModel", "read"],
    ]);
  });

  it("types an attribute holding a free function's result, and reads a multi-row query", () => {
    const builder = file("repos/all_repositories.py", [], [method("get_repositories", [], "AllRepositories")]);
    const service = file("services/transfer_service.py", [cls("TransferService", {
      methods: [method("release", ["self.db.players.get_one", "self.db.league_reports.multi_query"])],
    })]);
    (service.classes[0] as any).properties.push({ name: "db", type: null, visibility: "public", isStatic: false, isReadonly: false, from: "get_repositories()" });
    new PythonEntityExtractor().reconcileProject([model(), generic(), factory(), builder, service]);
    expect(service.dataSources.map((d) => [d.name, d.entity, d.access])).toEqual([
      ["self.db.players.get_one", "PlayerModel", "read"],
      ["self.db.league_reports.multi_query", "ReportModel", "read"],
    ]);
  });
});

/** `select(self.model)` in a generic repository or a mixin of one: the model each construction hands the constructor. */
describe("Python model held by an instance attribute", () => {
  const ctor = (params: string[], calls: Array<[string, string[]]> = []): any => ({
    ...method("__init__", [], null, params.map((p) => ({ name: p, type: null, defaultValue: null }))),
    calls: calls.map(([name, args], i) => ({ name, kind: "internal", target: null, line: 5 + i, args })),
  });
  const at = (c: any, line: number, endLine: number) => Object.assign(c, { line, endLine });
  const row = (line: number): any => ({ kind: "database", name: "self.session.execute", target: null, entityAttribute: "model", access: "read", calls: [], line });
  const build = (repos: Array<[string, string]>) => {
    const models = file("db/models.py", [
      cls("MatchModel", { extends: "SqlAlchemyBase", decorators: ["entity", "sqlalchemy"] }),
      cls("ClubModel", { extends: "SqlAlchemyBase", decorators: ["entity", "sqlalchemy"] }),
    ]);
    const base = cls("RepositoryGeneric", { methods: [ctor(["session", "primary_key", "sql_model", "schema"])] });
    base.properties.push({ name: "model", type: "type[Model]", visibility: "public", isStatic: false, isReadonly: false, assignedFrom: "sql_model" });
    const league = cls("LeagueRepositoryGeneric", {
      extends: "RepositoryGeneric[Schema, Model]",
      methods: [ctor(["session", "primary_key", "sql_model", "schema", "league_id"], [["super().__init__", ["session", "primary_key", "sql_model", "schema"]]])],
    });
    const generic = file("repos/generic.py", [at(base, 1, 40), at(league, 41, 60)]);
    generic.dataSources = [row(30)];
    const mixin = file("repos/_suggestions.py", [at(cls("MatchSuggestionMixin"), 1, 80)]);
    mixin.dataSources = [row(50)];
    const concrete = file("repos/matches.py", repos.map(([name, model], i) =>
      at(cls(name, { extends: model === "MatchModel" ? "MatchSuggestionMixin" : null, implements: [`LeagueRepositoryGeneric[Out, ${model}]`] }), 1 + i * 10, 9 + i * 10)));
    const factory = file("repos/factory.py", [cls("AllRepositories", {
      methods: repos.map(([name, model]) => ({ ...method(name.toLowerCase(), [], name), calls: [{ name, kind: "cross-file", target: null, line: 70, args: ["self.session", "PK_ID", model, "Out"] }] })),
    })]);
    const all = [models, generic, mixin, concrete, factory];
    new PythonEntityExtractor().reconcileProject(all);
    return { generic, mixin };
  };

  it("names the model every construction of the mixin's repository passes, through the base constructor it is handed on to", () => {
    const { generic, mixin } = build([["RepositoryMatches", "MatchModel"], ["RepositoryClubs", "ClubModel"]]);
    expect(mixin.dataSources.map((d) => d.entity)).toEqual(["MatchModel"]);
    // The base every repository is built from holds a different model per repository: none.
    expect(generic.dataSources.map((d) => d.entity ?? null)).toEqual([null]);
  });

  it("names it in the base too when only one model is ever passed", () => {
    const { generic } = build([["RepositoryMatches", "MatchModel"]]);
    expect(generic.dataSources.map((d) => d.entity)).toEqual(["MatchModel"]);
  });

  /** The base's model parameter written without an annotation: a class only because every construction hands one. */
  const untyped = (args: string[][]) => {
    const models = file("db/models.py", [cls("MatchModel", { extends: "SqlAlchemyBase", decorators: ["entity", "sqlalchemy"] })]);
    const init = ctor(["session", "model"]);
    init.params[1].assignedTo = "model";
    const base = file("repos/base.py", [at(cls("BaseRepository", { methods: [init] }), 1, 40)]);
    base.dataSources = [row(30)];
    const users = file("repos/factory.py", [cls("Repositories", {
      methods: args.map((a, i) => ({ ...method(`r${i}`, [], null), calls: [{ name: "BaseRepository", kind: "cross-file", target: null, line: 70 + i, args: a }] })),
    })]);
    new PythonEntityExtractor().reconcileProject([models, base, users]);
    return base.dataSources[0]!.entity ?? null;
  };

  it("reads an untyped constructor parameter's model off the constructions when each hands the same class", () => {
    expect(untyped([["self.session", "MatchModel"], ["session", "models.MatchModel"]])).toBe("MatchModel");
  });

  it("names none when a construction hands an untyped parameter anything but a class", () => {
    expect(untyped([["self.session", "MatchModel"], ["self.session", "model_for(kind)"]])).toBeNull();
    expect(untyped([["self.session", "MatchModel"], ["self.session", "chosen_model"]])).toBeNull();
  });
});

describe("Django's signed-in user saved", () => {
  const saved = (filePath: string): FileAnalysis => {
    const f = file(filePath, []);
    f.dataSources = [{ kind: "database", name: "request.user.save", target: "User", entity: "User", authUser: true, access: "write", calls: [], line: 3 }];
    return f;
  };
  it("is a row of the user model the project declares, else of Django's own", () => {
    const views = saved("league/views.py");
    const accounts = file("accounts/models.py", [cls("Manager", { extends: "AbstractUser", decorators: ["entity", "django"] })]);
    new PythonEntityExtractor().reconcileProject([accounts, views]);
    expect(views.dataSources[0]!.entity).toBe("Manager");

    const plain = saved("league/views.py");
    new PythonEntityExtractor().reconcileProject([plain]);
    expect(plain.dataSources[0]!.entity).toBe("User");
  });

  it("names none when the project declares two user models", () => {
    const views = saved("league/views.py");
    const models = file("accounts/models.py", [
      cls("Manager", { extends: "AbstractUser", decorators: ["entity", "django"] }),
      cls("Scout", { extends: "models.AbstractBaseUser", decorators: ["entity", "django"] }),
    ]);
    new PythonEntityExtractor().reconcileProject([models, views]);
    expect(views.dataSources[0]!.entity).toBeUndefined();
  });
});


/** A repository method outside the CRUD verbs, reached through the typed chain: the entity when its body works on the instance's model. */
describe("Python repository methods outside the verb list", () => {
  const at = (m: any, line: number, endLine: number) => Object.assign(m, { line, endLine });
  const onModel = (name: string, line: number, access: "read" | "write" = "read"): any => ({ kind: "database", name, target: null, entityAttribute: "model", access, calls: [], line });

  it("reaches the type argument's model through a method on `self.model`, a same-instance helper, or a subclass override", () => {
    const models = file("db/models.py", [
      cls("ClubModel", { extends: "SqlAlchemyBase", decorators: ["entity", "sqlalchemy"] }),
      cls("PlayerModel", { extends: "SqlAlchemyBase", decorators: ["entity", "sqlalchemy"] }),
    ]);
    const generic = file("repos/repository_generic.py", [cls("RepositoryGeneric", { methods: [
      at(method("_query_one", []), 10, 12),
      at(method("league_table", []), 14, 17),
      at(method("relegate", ["self._query_one"]), 19, 23),
      at(method("statistics", []), 25, 27),
    ] })]);
    generic.dataSources = [
      onModel("self.session.get", 11),
      onModel("self.session.execute", 16),
      { kind: "database", name: "self.session.delete", target: null, access: "write", calls: [], line: 21 } as any,
      onModel("self.session.scalar", 26),
    ];
    // The subclass's own `statistics` reads another model by name: not the instance's.
    const clubs = file("repos/repository_clubs.py", [cls("RepositoryClubs", { extends: "RepositoryGeneric[ClubOut, ClubModel]", methods: [at(method("statistics", []), 5, 8)] })]);
    clubs.dataSources = [{ kind: "database", name: "self.session.scalar", target: "PlayerModel", entity: "PlayerModel", access: "read", calls: [], line: 7 } as any];
    const factory = file("repos/factory.py", [cls("AllRepositories", { methods: [
      method("clubs", [], "RepositoryClubs"),
      method("players", [], "RepositoryGeneric[PlayerOut, PlayerModel]"),
    ] })]);
    const service = file("services/club_service.py", [cls("ClubService", {
      props: [["repos", "AllRepositories"]],
      methods: [method("work", [
        "self.repos.players.league_table",
        "self.repos.clubs.relegate",
        "self.repos.players.statistics",
        "self.repos.clubs.statistics",
        "self.repos.clubs.rename",
      ])],
    })]);

    new PythonEntityExtractor().reconcileProject([models, generic, clubs, factory, service]);

    expect(service.dataSources.map((d) => [d.name, d.entity, d.access])).toEqual([
      ["self.repos.players.league_table", "PlayerModel", "read"],
      ["self.repos.clubs.relegate", "ClubModel", "write"],
      ["self.repos.players.statistics", "PlayerModel", "read"],
      // `RepositoryClubs.statistics` overrides the base's and names its own model; `rename` is declared nowhere.
    ]);
  });

  it("follows a wrapper whose method calls such a repository method", () => {
    const models = file("db/models.py", [cls("ClubModel", { extends: "SqlAlchemyBase", decorators: ["entity", "sqlalchemy"] })]);
    const generic = file("repos/repository_generic.py", [cls("RepositoryGeneric", { methods: [at(method("league_table", []), 14, 17)] })]);
    generic.dataSources = [onModel("self.session.execute", 16)];
    const factory = file("repos/factory.py", [cls("AllRepositories", { methods: [method("clubs", [], "RepositoryGeneric[ClubOut, ClubModel]")] })]);
    const wrapper = file("routes/mixins.py", [cls("HttpRepo", { methods: [
      method("__init__", [], null, [{ name: "repo", type: "RepositoryGeneric", defaultValue: null }]),
      method("get_one", ["self.repo.league_table"]),
    ] })]);
    const mixins = method("_mixins", [], "HttpRepo", [{ name: "league_id", type: null, defaultValue: null }]);
    mixins.constructedWith = ["self.repos.clubs"];
    const controller = file("routes/clubs.py", [cls("ClubController", {
      props: [["repos", "AllRepositories"]],
      methods: [mixins, method("standings", ["self._mixins(league_id).get_one"])],
    })]);

    new PythonEntityExtractor().reconcileProject([models, generic, factory, wrapper, controller]);

    expect(controller.dataSources.map((d) => [d.name, d.entity, d.access])).toEqual([["self._mixins(league_id).get_one", "ClubModel", "read"]]);
  });
});
