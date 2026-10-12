import { describe, it, expect } from "vitest";
import { rubySpec } from "./index.js";
import { railsRouteAnchor } from "./route-anchor.js";
import { reconcileProjectRoutes } from "../../route-resolvers/index.js";
import { buildImportIndex } from "../../../core/import-index.js";
import { buildClassIndex } from "../../../core/class-index.js";
import type { ClassInfo, FileAnalysis } from "../../../types/analysis.js";
import type { ProjectContext } from "../../../types/project.js";

const cls = (name: string, ext: string | null, methods: Array<[string, number]>): ClassInfo =>
  ({
    name,
    extends: ext,
    implements: [],
    line: 1,
    endLine: 40,
    methods: methods.map(([n, line]) => ({ name: n, line, endLine: line + 1, params: [], calls: [] })),
    properties: [],
  }) as unknown as ClassInfo;

const file = (filePath: string, classes: ClassInfo[], routes = [] as FileAnalysis["routes"]): FileAnalysis =>
  ({ filePath, language: "ruby", projectId: "root", imports: [], exports: [], entityRelations: [], classes, routes }) as unknown as FileAnalysis;

describe("rails-route-anchor", () => {
  it("moves a routes.rb row onto the action that serves it, inherited actions onto their definer", () => {
    const router = `Rails.application.routes.draw do
  namespace :api do
    resources :labels, only: [:index, :show]
    resources :teams, only: [:index]
    resources :ghosts, only: [:index]
  end
end`;
    const out = [
      file("config/routes.rb", [], rubySpec.extractRoutes!(router.split("\n"), [], "config/routes.rb")),
      file("app/controllers/api/labels_controller.rb", [cls("Api::LabelsController", "Api::BaseController", [["index", 5], ["show", 9], ["export", 12]])], [
        // The plugin's guesses from action names: `show` is declared by the router, `export` is not.
        { path: "/api/labels/:id", httpMethod: "GET", kind: "api", handler: "Api::LabelsController#show", calls: [], middleware: ["before_action :authenticate_user!"], line: 9 },
        { path: "/api/labels/export", httpMethod: "GET", kind: "api", handler: "Api::LabelsController#export", calls: [], middleware: [], line: 12 },
      ]),
      file("app/controllers/api/base_controller.rb", [cls("Api::BaseController", null, [["index", 3]])]),
      file("app/controllers/api/teams_controller.rb", [cls("Api::TeamsController", "Api::BaseController", [])]),
    ];
    const importIndex = buildImportIndex(out);
    const ctx = { importIndex, classes: buildClassIndex(out, importIndex), resolveModule: () => null, fileOf: (p: string) => out.find((a) => a.filePath === p) } as ProjectContext;
    reconcileProjectRoutes(out, ctx, [railsRouteAnchor]);
    const where = out.flatMap((a) => a.routes.map((r) => `${r.httpMethod} ${r.path} @ ${a.filePath}:${r.line}`));
    expect(where.sort()).toEqual(
      [
        "GET /api/labels @ app/controllers/api/labels_controller.rb:5",
        "GET /api/labels/:id @ app/controllers/api/labels_controller.rb:9",
        "GET /api/labels/export @ app/controllers/api/labels_controller.rb:12",
        "GET /api/teams @ app/controllers/api/base_controller.rb:3",
        // No controller declares GhostsController: the row stays where it was declared.
        "GET /api/ghosts @ config/routes.rb:5",
      ].sort(),
    );
    expect(out[1]!.routes.filter((r) => r.resolvedBy === "rails-route-anchor")).toHaveLength(2);
    // The declared row keeps what the dropped guess knew about the controller's filters.
    expect(out[1]!.routes.find((r) => r.path === "/api/labels/:id")?.middleware).toEqual(["before_action :authenticate_user!"]);
  });
});
