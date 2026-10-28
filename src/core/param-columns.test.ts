import { describe, it, expect } from "vitest";
import { computeParamColumns, fillParamColumnEntities } from "./param-columns.js";
import type { FileAnalysis, SymbolLink } from "../types/analysis.js";

const fn = (name: string, line: number, endLine: number, params: string[], calls: any[] = []): any =>
  ({ name, params: params.map((p) => ({ name: p, type: null, defaultValue: null })), returnType: null, isAsync: true, isExported: true, decorators: [], calls, line, endLine });
const file = (filePath: string, functions: any[], extra: Partial<FileAnalysis> = {}): FileAnalysis =>
  ({ filePath, language: "typescript", functions, classes: [], dataSources: [], routes: [], imports: [], exports: [], ...extra }) as unknown as FileAnalysis;
const link = (sourceFile: string, sourceSymbol: string, sourceLine: number, callName: string, targetFile: string, targetSymbol: string): SymbolLink =>
  ({ sourceFile, sourceSymbol, sourceLine, callName, targetFile, targetSymbol, targetLine: 1, confidence: "EXTRACTED", relation: "calls" }) as SymbolLink;

describe("paramColumns", () => {
  // GET /clubs/:slug reads the slug off the request and hands it to getClub, which hands it to findClub's filter.
  const route = {
    kind: "api", path: "/clubs/:slug", httpMethod: "GET", handler: null, line: 3, filePath: "api/routes/clubs.ts",
    params: [{ name: "slug", type: null, binding: "route", inferred: true }, { name: "season", type: null, binding: "query" }],
    calls: [{ name: "getClub", kind: "cross-file", target: "../services/clubs", line: 4, argOrigins: [{ index: 0, origin: { kind: "route-param", name: "slug" } }] }],
  } as any;
  const service = file("api/services/clubs.ts", [
    fn("getClub", 1, 4, ["slug"], [{ name: "findClub", kind: "internal", target: null, line: 2, argOrigins: [{ index: 0, origin: { kind: "param", name: "slug", index: 0 } }] }]),
    fn("findClub", 6, 9, ["clubSlug"]),
  ], {
    dataSources: [
      { kind: "database", name: "prisma.club.findUnique", target: null, entity: "club", access: "read", line: 7, calls: [], whereFields: [{ field: "slug", origin: { kind: "param", name: "clubSlug", index: 0 } }] },
      // A statement of another function: its filter says nothing about this route.
      { kind: "database", name: "prisma.club.delete", target: null, entity: "club", access: "write", line: 3, calls: [], whereFields: [{ field: "id", origin: { kind: "param", name: "slug", index: 1 } }] },
    ],
  } as any);
  const routes = file("api/routes/clubs.ts", [], { routes: [route] } as any);
  const links = [
    link("api/routes/clubs.ts", "route:GET /clubs/:slug", 4, "getClub", "api/services/clubs.ts", "getClub"),
    link("api/services/clubs.ts", "getClub", 2, "findClub", "api/services/clubs.ts", "findClub"),
  ];

  it("follows a route parameter from the request read through the calls that hand it on, to the field a statement filters on", () => {
    const rows = computeParamColumns({ analyses: [routes, service], symbolLinks: links, routes: [route] });
    expect(rows).toEqual([{
      route: { file: "api/routes/clubs.ts", line: 3, method: "GET", path: "/clubs/:slug", param: "slug", binding: "route" },
      column: { entity: "club", field: "slug", file: "api/services/clubs.ts", line: 7, access: "read", call: "prisma.club.findUnique" },
      hops: [{ file: "api/services/clubs.ts", symbol: "getClub", line: 1, arg: 0 }, { file: "api/services/clubs.ts", symbol: "findClub", line: 6, arg: 0 }],
      confidence: "EXTRACTED",
    }]);
  });

  it("starts at a handler function's parameter of the route parameter's name", () => {
    const handled = { ...route, handler: "ClubsController.show", calls: [] };
    const controller = file("api/clubs.controller.ts", [], { classes: [{ name: "ClubsController", methods: [fn("show", 10, 14, ["slug"], [{ name: "this.clubs.findClub", kind: "internal", target: null, line: 12, argOrigins: [{ index: 0, origin: { kind: "param", name: "slug", index: 0 } }] }])] }] } as any);
    const rows = computeParamColumns({
      analyses: [routes, service, controller],
      symbolLinks: [link("api/routes/clubs.ts", "route:GET /clubs/:slug", 3, "ClubsController.show", "api/clubs.controller.ts", "ClubsController.show"), link("api/clubs.controller.ts", "ClubsController.show", 12, "this.clubs.findClub", "api/services/clubs.ts", "findClub")],
      routes: [handled],
    });
    expect(rows.map((r) => [r.route.param, `${r.column.entity}.${r.column.field}`, r.hops.map((h) => h.symbol).join(" → ")])).toEqual([["slug", "club.slug", "ClubsController.show → findClub"]]);
  });

  it("is empty when no statement reports filter fields", () => {
    expect(computeParamColumns({ analyses: [routes, file("api/services/clubs.ts", [])], symbolLinks: links, routes: [route] })).toEqual([]);
  });
  it("hands an argument given by name to the parameter of that name — through a named-query dispatch too", () => {
    const r = { kind: "api", path: "/clubs/{slug}", httpMethod: "GET", handler: "show", line: 5, filePath: "league/routes.py", params: [{ name: "slug", type: null, binding: "route" }], calls: [] } as any;
    const routesFile = file("league/routes.py", [fn("show", 6, 8, ["slug"], [{ name: "repo.get_club", kind: "internal", target: null, line: 7, argOrigins: [{ index: 0, param: "slug", origin: { kind: "param", name: "slug", index: 0 } }] }])], { routes: [r] } as any);
    const repo = file("league/repo.py", [fn("get_club", 1, 3, ["season", "slug"], [{ name: "queries.get_club_by_slug", kind: "internal", target: null, line: 2, argOrigins: [{ index: 1, param: "slug", origin: { kind: "param", name: "slug", index: 1 } }] }])]);
    const sql = file("league/sql/clubs.sql", [fn("get-club-by-slug", 1, 4, ["slug"])], {
      dataSources: [{ kind: "database", name: "SELECT", target: "clubs", entity: "clubs", access: "read", line: 2, calls: [], whereFields: [{ field: "slug", origin: { kind: "param", name: "slug", index: 0 } }] }],
    } as any);
    const rows = computeParamColumns({
      analyses: [routesFile, repo, sql],
      symbolLinks: [
        link("league/routes.py", "route:GET /clubs/{slug}", 5, "show", "league/routes.py", "show"),
        link("league/routes.py", "show", 7, "repo.get_club", "league/repo.py", "get_club"),
        { ...link("league/repo.py", "get_club", 2, "queries.get_club_by_slug", "league/sql/clubs.sql", "get-club-by-slug"), strategy: "dispatch:named-query", relation: "dispatch" },
      ],
      routes: [r],
    });
    expect(rows.map((x) => [x.column.field, x.hops.map((h) => `${h.symbol}/${h.arg}`).join(" → ")])).toEqual([["slug", "show/0 → get_club/1 → get-club-by-slug/0"]]);
  });

  it("follows a dependency the framework hands the route's parameters by name, and a request value the handler reads itself", () => {
    const r = {
      kind: "api", path: "/clubs/{slug}", httpMethod: "GET", handler: "show", line: 5, filePath: "league/routes.py",
      params: [{ name: "slug", type: null, binding: "route" }, { name: "season", type: null, binding: "query" }],
      calls: [{ name: "club_from_path", kind: "internal", target: null, line: 6, routeParamsByName: true }],
    } as any;
    const routesFile = file("league/routes.py", [
      fn("show", 6, 9, ["club"], [{ name: "repo.squad", kind: "internal", target: null, line: 8, argOrigins: [{ index: 0, origin: { kind: "query-param", name: "season" } }] }]),
      fn("club_from_path", 11, 13, ["slug"], [{ name: "repo.club", kind: "internal", target: null, line: 12, argOrigins: [{ index: 0, origin: { kind: "param", name: "slug", index: 0 } }] }]),
    ], { routes: [r] } as any);
    const repo = file("league/repo.py", [fn("club", 1, 3, ["slug"]), fn("squad", 5, 7, ["season"])], {
      dataSources: [
        { kind: "database", name: "Club.objects.get", target: "Club", entity: "Club", access: "read", line: 2, calls: [], whereFields: [{ field: "slug", origin: { kind: "param", name: "slug", index: 0 } }] },
        { kind: "database", name: "Player.objects.filter", target: "Player", entity: "Player", access: "read", line: 6, calls: [], whereFields: [{ field: "season", origin: { kind: "param", name: "season", index: 0 } }] },
      ],
    } as any);
    const rows = computeParamColumns({
      analyses: [routesFile, repo],
      symbolLinks: [
        link("league/routes.py", "route:GET /clubs/{slug}", 5, "show", "league/routes.py", "show"),
        link("league/routes.py", "route:GET /clubs/{slug}", 6, "club_from_path", "league/routes.py", "club_from_path"),
        link("league/routes.py", "club_from_path", 12, "repo.club", "league/repo.py", "club"),
        link("league/routes.py", "show", 8, "repo.squad", "league/repo.py", "squad"),
      ],
      routes: [r],
    });
    expect(rows.map((x) => [x.route.param, `${x.column.entity}.${x.column.field}`, x.hops.map((h) => `${h.symbol}/${h.arg}`).join(" → ")])).toEqual([
      ["season", "Player.season", "show/-1 → squad/0"],
      ["slug", "Club.slug", "club_from_path/0 → club/0"],
    ]);
  });

  it("follows a dependency's own dependencies, which the framework hands the route's parameters by name too", () => {
    const r = {
      kind: "api", path: "/clubs/{slug}/players/{player_id}", httpMethod: "DELETE", handler: "remove", line: 5, filePath: "league/routes.py",
      params: [{ name: "slug", type: null, binding: "route" }, { name: "player_id", type: null, binding: "route" }],
      calls: [{ name: "check_player_permissions", kind: "internal", target: null, line: 6, routeParamsByName: true }],
    } as any;
    const deps = file("league/deps.py", [
      // check_player_permissions(player = Depends(player_from_path)) → player_from_path(player_id, club = Depends(club_from_path)) → club_from_path(slug)
      fn("check_player_permissions", 1, 3, ["player"], [{ name: "player_from_path", kind: "internal", target: null, line: 1, routeParamsByName: true }]),
      fn("player_from_path", 5, 7, ["player_id", "club"], [
        { name: "club_from_path", kind: "internal", target: null, line: 5, routeParamsByName: true },
        { name: "repo.player", kind: "internal", target: null, line: 6, argOrigins: [{ index: 0, origin: { kind: "param", name: "player_id", index: 0 } }] },
      ]),
      fn("club_from_path", 9, 11, ["slug"], [{ name: "repo.club", kind: "internal", target: null, line: 10, argOrigins: [{ index: 0, origin: { kind: "param", name: "slug", index: 0 } }] }]),
    ]);
    const repo = file("league/repo.py", [fn("club", 1, 3, ["slug"]), fn("player", 5, 7, ["id"])], {
      dataSources: [
        { kind: "database", name: "SELECT", target: "clubs", entity: "clubs", access: "read", line: 2, calls: [], whereFields: [{ field: "slug", origin: { kind: "param", name: "slug", index: 0 } }] },
        { kind: "database", name: "SELECT", target: "players", entity: "players", access: "read", line: 6, calls: [], whereFields: [{ field: "id", origin: { kind: "param", name: "id", index: 0 } }] },
      ],
    } as any);
    const rows = computeParamColumns({
      analyses: [file("league/routes.py", [], { routes: [r] } as any), deps, repo],
      symbolLinks: [
        link("league/routes.py", "route:DELETE /clubs/{slug}/players/{player_id}", 6, "check_player_permissions", "league/deps.py", "check_player_permissions"),
        link("league/deps.py", "check_player_permissions", 1, "player_from_path", "league/deps.py", "player_from_path"),
        link("league/deps.py", "player_from_path", 5, "club_from_path", "league/deps.py", "club_from_path"),
        link("league/deps.py", "player_from_path", 6, "repo.player", "league/repo.py", "player"),
        link("league/deps.py", "club_from_path", 10, "repo.club", "league/repo.py", "club"),
      ],
      routes: [r],
    });
    expect(rows.map((x) => [x.route.param, `${x.column.entity}.${x.column.field}`, x.hops.map((h) => `${h.symbol}/${h.arg}`).join(" → ")])).toEqual([
      ["player_id", "players.id", "check_player_permissions/-1 → player_from_path/0 → player/0"],
      ["slug", "clubs.slug", "check_player_permissions/-1 → player_from_path/-1 → club_from_path/0 → club/0"],
    ]);
  });

  it("reads a merged request value in a callback the route runs, and fills an entity a later pass settles", () => {
    const r = {
      kind: "api", path: "/clubs/:id", httpMethod: "GET", handler: "ClubsController#show", line: 2, filePath: "config/routes.rb",
      params: [{ name: "id", type: null, binding: "route", inferred: true }],
      calls: [{ name: "ClubsController.club", kind: "internal", target: null, line: 2 }],
    } as any;
    const controller = file("app/controllers/clubs_controller.rb", [], {
      classes: [{ name: "ClubsController", methods: [fn("show", 4, 5, []), fn("club", 7, 9, [])] }],
      dataSources: [
        { kind: "database", name: "Current.league.clubs.find_by!", target: null, access: "read", line: 8, calls: [], whereFields: [{ field: "slug", origin: { kind: "request-param", name: "id" } }] },
      ],
    } as any);
    const analyses = [file("config/routes.rb", [], { routes: [r] } as any), controller];
    const rows = computeParamColumns({
      analyses,
      symbolLinks: [
        link("config/routes.rb", "route:GET /clubs/:id", 2, "ClubsController#show", "app/controllers/clubs_controller.rb", "ClubsController.show"),
        link("config/routes.rb", "route:GET /clubs/:id", 2, "ClubsController.club", "app/controllers/clubs_controller.rb", "ClubsController.club"),
      ],
      routes: [r],
    });
    expect(rows.map((x) => [x.route.param, `${x.column.entity}.${x.column.field}`, x.hops.map((h) => `${h.symbol}/${h.arg}`).join(" → ")])).toEqual([["id", "null.slug", "ClubsController.club/-1"]]);
    // The association join names the model afterwards (a new row object, as the join writes it).
    controller.dataSources = [{ ...controller.dataSources[0]!, entity: "Club" }];
    fillParamColumnEntities(rows, analyses);
    expect(rows[0]!.column.entity).toBe("Club");
    // A statement the join drops takes its row with it.
    controller.dataSources = [];
    rows[0]!.column.entity = null;
    fillParamColumnEntities(rows, analyses);
    expect(rows).toEqual([]);
  });

  it("follows an overloaded callee only when the declared types agree, and shifts past an extension method's receiver", () => {
    const r = { kind: "api", path: "/clubs/{id}", httpMethod: "GET", handler: "ClubsController.Show", line: 3, filePath: "Api/ClubsController.cs", params: [{ name: "clubId", type: "int", binding: "route", variable: undefined }], calls: [] } as any;
    const p = (name: string, type: string, extra = {}) => ({ name, type, defaultValue: null, ...extra });
    const controller = file("Api/ClubsController.cs", [], { classes: [{ name: "ClubsController", methods: [{ ...fn("Show", 4, 8, []), params: [p("clubId", "int")], calls: [
      { name: "_service.Find", kind: "internal", target: null, line: 5, argOrigins: [{ index: 0, origin: { kind: "param", name: "clubId", index: 0 } }] },
      { name: "_context.Clubs.ForClub", kind: "internal", target: null, line: 6, argOrigins: [{ index: 0, origin: { kind: "param", name: "clubId", index: 0 } }] },
    ] }] }] } as any);
    const service = file("Api/ClubService.cs", [], { classes: [{ name: "ClubService", methods: [
      { ...fn("Find", 1, 3, []), params: [p("name", "string")] },
      { ...fn("Find", 5, 7, []), params: [p("id", "int")] },
    ] }, { name: "ClubQueries", methods: [{ ...fn("ForClub", 10, 12, []), params: [p("clubs", "IQueryable<Club>", { isReceiver: true }), p("id", "int")] }] }],
    dataSources: [
      { kind: "database", name: "EF: Where", target: "Clubs", entity: "Clubs", access: "read", line: 2, calls: [], whereFields: [{ field: "Name", origin: { kind: "param", name: "name", index: 0 } }] },
      { kind: "database", name: "EF: Where", target: "Clubs", entity: "Clubs", access: "read", line: 6, calls: [], whereFields: [{ field: "Id", origin: { kind: "param", name: "id", index: 0 } }] },
      { kind: "database", name: "EF: Where", target: "Clubs", entity: "Clubs", access: "read", line: 11, calls: [], whereFields: [{ field: "Id", origin: { kind: "param", name: "id", index: 1 } }] },
    ] } as any);
    const rows = computeParamColumns({
      analyses: [controller, service],
      symbolLinks: [
        link("Api/ClubsController.cs", "route:GET /clubs/{id}", 3, "ClubsController.Show", "Api/ClubsController.cs", "ClubsController.Show"),
        // The linker picked the string overload: its parameter's type is not the value's.
        { ...link("Api/ClubsController.cs", "ClubsController.Show", 5, "_service.Find", "Api/ClubService.cs", "ClubService.Find"), targetLine: 1 },
        link("Api/ClubsController.cs", "ClubsController.Show", 6, "_context.Clubs.ForClub", "Api/ClubService.cs", "ClubQueries.ForClub"),
      ],
      routes: [r],
    });
    expect(rows.map((x) => [x.column.line, x.column.field, x.hops.map((h) => `${h.symbol}/${h.arg}`).join(" → ")])).toEqual([[11, "Id", "ClubsController.Show/0 → ClubQueries.ForClub/1"]]);
  });

  it("follows a parameter a generic handler binds into its type's field, through the methods that read it and the objects they hand on", () => {
    // GET /clubs/:club served by `h.ReadOneWeb`, whose handler binds the request into a models.Club.
    const r = { kind: "api", path: "/clubs/:club", httpMethod: "GET", handler: "h.ReadOneWeb", handlerTypes: ["models.Club"], line: 4, filePath: "routes/routes.go", params: [{ name: "club", type: null, binding: "route", inferred: true }], calls: [] } as any;
    const routesFile = file("routes/routes.go", [], { routes: [r] } as any);
    const recv = (index: number) => ({ index, origin: { kind: "receiver" } });
    const club = file("models/club.go", [], {
      classes: [{
        name: "Club",
        properties: [{ name: "ID", type: "int64", boundFrom: { kind: "route-param", name: "club" } }, { name: "LeagueID", type: "int64", boundFrom: { kind: "route-param", name: "league" } }],
        methods: [
          fn("ReadOne", 10, 20, ["s", "a"], [
            { name: "loadClub", kind: "internal", target: null, line: 12, argOrigins: [recv(1)] },
            { name: "c.touch", kind: "internal", target: null, line: 13, argOrigins: [recv(-1)] },
            { name: "GetPlayers", kind: "internal", target: null, line: 14, argOrigins: [{ index: 1, field: "ClubID", origin: { kind: "receiver-field", name: "ID" } }] },
          ]),
          fn("touch", 22, 25, ["s"]),
        ],
      }],
      dataSources: [{ kind: "database", name: "xorm: Update", target: "Club", entity: "Club", access: "write", line: 23, calls: [], whereFields: [{ field: "id", origin: { kind: "receiver-field", name: "ID" } }, { field: "league_id", origin: { kind: "receiver-field", name: "LeagueID" } }] }],
    } as any);
    const load = file("models/load.go", [fn("loadClub", 1, 4, ["s", "c"]), fn("GetPlayers", 6, 9, ["s", "p"])], {
      dataSources: [
        { kind: "database", name: "xorm: Get", target: "Club", entity: "Club", access: "read", line: 2, calls: [], whereFields: [{ field: "id", origin: { kind: "param-field", name: "c", index: 1, member: "ID" } }] },
        // The parameter itself, not its field: no row.
        { kind: "database", name: "xorm: Find", target: "Player", entity: "Player", access: "read", line: 7, calls: [], whereFields: [{ field: "club_id", origin: { kind: "param-field", name: "p", index: 1, member: "ClubID" } }, { field: "id", origin: { kind: "param", name: "p", index: 1 } }] },
      ],
    } as any);
    const rows = computeParamColumns({
      analyses: [routesFile, club, load],
      symbolLinks: [
        link("routes/routes.go", "route:GET /clubs/:club", 4, "obj.ReadOne", "models/club.go", "Club.ReadOne"),
        link("models/club.go", "Club.ReadOne", 12, "loadClub", "models/load.go", "loadClub"),
        link("models/club.go", "Club.ReadOne", 13, "c.touch", "models/club.go", "Club.touch"),
        link("models/club.go", "Club.ReadOne", 14, "GetPlayers", "models/load.go", "GetPlayers"),
      ],
      routes: [r],
    });
    const hop = (h: { symbol: string; arg: number; field?: string }) => `${h.symbol}/${h.arg}${h.field ? `.${h.field}` : ""}`;
    expect(rows.map((x) => [x.route.param, `${x.column.entity}.${x.column.field}`, x.hops.map(hop).join(" → ")])).toEqual([
      ["club", "Club.id", "Club.ReadOne/-1.ID → Club.touch/-1.ID"],
      ["club", "Club.id", "Club.ReadOne/-1.ID → loadClub/1.ID"],
      ["club", "Player.club_id", "Club.ReadOne/-1.ID → GetPlayers/1.ClubID"],
    ]);
    // A type the handler is not built for binds nothing on this route.
    expect(computeParamColumns({ analyses: [routesFile, club, load], symbolLinks: [link("routes/routes.go", "route:GET /clubs/:club", 4, "obj.ReadOne", "models/club.go", "Club.ReadOne")], routes: [{ ...r, handlerTypes: ["models.Season"] }] })).toEqual([]);
  });
});
