import { describe, it, expect } from "vitest";
import { extractHumaRoutes } from "./huma.js";
import { humaBaseResolver } from "./huma-resolver.js";
import { reconcileProjectRoutes } from "../../route-resolvers/index.js";
import type { FileAnalysis, RouteFact } from "../../../types/analysis.js";
import type { ProjectContext } from "../../../types/project.js";

const file = (filePath: string, src: string): FileAnalysis => {
  const facts: RouteFact[] = [];
  const routes = extractHumaRoutes(src.split("\n"), facts);
  return { filePath, language: "go", projectId: "root", routes, ...(facts.length ? { routeFacts: facts } : {}) } as unknown as FileAnalysis;
};
const sig = (a: FileAnalysis) => a.routes.map((r) => `${r.httpMethod} ${r.path} ${r.handler} @${r.line}${r.prefixUnresolved ? " ?" : ""}`);

const HUMA = `package v2

const GroupPrefix = "/api/v2"

func NewAPI(e *echo.Echo, g *echo.Group) huma.API {
	servers := []*huma.Server{{URL: GroupPrefix}}
	servers = append(servers, &huma.Server{URL: publicURL + GroupPrefix})
	return api
}

func EnableAutoPatch(api huma.API) {
	autopatch.AutoPatch(api)
}`;

const LABELS = `package v2

func RegisterLabels(api huma.API) {
	Register(api, huma.Operation{OperationID: "labels-list", Method: http.MethodGet, Path: "/labels", Tags: tags}, labelsList)
	Register(api, huma.Operation{
		OperationID: "labels-read",
		Method:      http.MethodGet,
		Path:        "/labels/{id}",
	}, labelsRead)
	Register(api, huma.Operation{
		OperationID: "labels-update",
		Summary:     "Update a label, keeping {braces}, in the text",
		Method:      http.MethodPut,
		Path:        "/labels/{id}",
	}, labelsUpdate)
	huma.Delete(api, "/labels/{id}", func(ctx context.Context, in *DeleteInput) (*struct{}, error) {
		return nil, nil
	})
}

// The wrapper itself registers a variable operation: no route.
func Register[I, O any](api huma.API, op huma.Operation, handler func(context.Context, *I) (*O, error)) {
	huma.Register(api, op, handler)
}`;

const MIGRATION = `package v2

func registerMigrationAuth(api huma.API, name string) {
	Register(api, huma.Operation{
		OperationID: "migration-" + name + "-auth",
		Method:      http.MethodGet,
		Path:        "/migration/" + name + "/auth",
		// Return the project with 200, not the wrapper's DELETE default.
	}, func(_ context.Context, _ *struct{}) (*body, error) { return nil, nil })
	registerGated(api, huma.Operation{OperationID: "time-entries-update", Method: http.MethodPut, Path: "/time-entries/{id}"}, timeEntriesUpdate)
	Register(api, withUploadLimits(huma.Operation{
		Method: http.MethodPost,
		Path:   "/migration/csv/detect",
	}), csvDetect)
}`;

describe("Huma operations", () => {
  it("reads any wrapper's Operation literal, a path built around a runtime name, past a comment's apostrophe", () => {
    expect(sig(file("pkg/v2/migration.go", MIGRATION))).toEqual([
      "GET /migration/{name}/auth registerMigrationAuth @4 ?",
      "PUT /time-entries/{id} timeEntriesUpdate @10 ?",
      "POST /migration/csv/detect csvDetect @11 ?",
    ]);
  });

  it("reads Register with an Operation literal (one line or many) and the verb helpers, relative to an unknown base", () => {
    expect(sig(file("pkg/v2/labels.go", LABELS))).toEqual([
      "GET /labels labelsList @4 ?",
      "GET /labels/{id} labelsRead @5 ?",
      "PUT /labels/{id} labelsUpdate @10 ?",
      "DELETE /labels/{id} RegisterLabels @16 ?",
    ]);
  });

  it("puts the one server path the project declares in front, and AutoPatch's PATCH on the PUT", () => {
    const out = [file("pkg/v2/huma.go", HUMA), file("pkg/v2/labels.go", LABELS), file("pkg/v2/canonical.go", `document.Servers = []*huma.Server{{URL: GroupPrefix}}`)];
    reconcileProjectRoutes(out, {} as ProjectContext, [humaBaseResolver]);
    expect(sig(out[1]!)).toEqual([
      "GET /api/v2/labels labelsList @4",
      "GET /api/v2/labels/{id} labelsRead @5",
      "PUT /api/v2/labels/{id} labelsUpdate @10",
      "DELETE /api/v2/labels/{id} RegisterLabels @16",
      "PATCH /api/v2/labels/{id} labelsUpdate @10",
    ]);
  });

  it("keeps the base unresolved when two servers disagree, and complete when none is declared", () => {
    const two = [file("a.go", `var s = huma.Server{URL: "/api/v1"}`), file("b.go", `var s = huma.Server{URL: "/api/v2"}`), file("l.go", LABELS)];
    reconcileProjectRoutes(two, {} as ProjectContext, [humaBaseResolver]);
    expect(two[2]!.routes.every((r) => r.prefixUnresolved === "base:huma" && r.path.startsWith("/labels"))).toBe(true);
    const none = [file("l.go", LABELS)];
    reconcileProjectRoutes(none, {} as ProjectContext, [humaBaseResolver]);
    expect(sig(none[0]!)[0]).toBe("GET /labels labelsList @4");
  });
});
