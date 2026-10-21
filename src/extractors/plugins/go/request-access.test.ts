import { describe, it, expect } from "vitest";
import { extractFunctionsWithSpec } from "../shared/regex-base.js";
import { goSpec } from "./index.js";
import { extractGoRequestAccess } from "./request-access.js";

/**
 * A Go route names its handler and nothing else; what the request carries is
 * only visible in the handler body. These are the reads the join copies onto
 * the route as `params`.
 */
const lines = (src: string) => src.split("\n");
const access = (body: string) => extractGoRequestAccess(lines(body), { name: "h", params: [] });

describe("Go request access", () => {
  it("types a bound body from the local declaration that precedes the bind", () => {
    expect(access(`
	var input store.Part
	if err := c.ShouldBindJSON(&input); err != nil {
		return
	}
`)).toEqual([{ name: "input", type: "store.Part", binding: "body" }]);
    expect(access(`
	req := &model.CreatePlayerRequest{}
	if err := json.NewDecoder(r.Body).Decode(req); err != nil {
		return
	}
`)).toEqual([{ name: "req", type: "model.CreatePlayerRequest", binding: "body" }]);
    expect(access(`
	f := new(listFilter)
	c.ShouldBindQuery(f)
	var u uriParams
	c.ShouldBindUri(&u)
	var h headerParams
	c.ShouldBindHeader(&h)
	var form loginForm
	c.ShouldBindWith(&form, binding.Form)
`)).toEqual([
      { name: "f", type: "listFilter", binding: "query" },
      { name: "u", type: "uriParams", binding: "route" },
      { name: "h", type: "headerParams", binding: "header" },
      { name: "form", type: "loginForm", binding: "form" },
    ]);
  });

  it("reads named route, query, form and header accessors across router families", () => {
    expect(access(`
	id := c.Param("id")
	q := c.Query("q")
	limit := c.DefaultQuery("limit", "20")
	tenant := c.GetHeader("X-Tenant")
	file, _ := c.FormFile("avatar")
	name := c.PostForm("name")
`)).toEqual([
      { name: "id", type: null, binding: "route" },
      { name: "q", type: null, binding: "query" },
      { name: "limit", type: null, binding: "query" },
      { name: "X-Tenant", type: null, binding: "header" },
      { name: "avatar", type: null, binding: "form" },
      { name: "name", type: null, binding: "form" },
    ]);
    expect(access(`
	id := r.PathValue("id")
	slug := chi.URLParam(r, "slug")
	vars := mux.Vars(r)
	key := vars["key"]
	other := mux.Vars(r)["other"]
	name := ps.ByName("name")
	q := r.URL.Query()
	page := q.Get("page")
	sort := r.URL.Query().Get("sort")
	email := r.FormValue("email")
	auth := r.Header.Get("Authorization")
`).map((p) => `${p.binding}:${p.name}`)).toEqual([
      "route:id", "route:slug", "route:key", "route:other", "route:name",
      "query:page", "query:sort", "form:email", "header:Authorization",
    ]);
  });

  it("dedupes repeated reads and ignores SQL and cache lookups", () => {
    expect(access(`
	id := c.Param("id")
	again := c.Param("id")
	rows, _ := db.Query("SELECT id FROM players WHERE id = $1", id)
	v, _ := cache.Get("players:all")
`)).toEqual([{ name: "id", type: null, binding: "route" }]);
  });

  it("lands on FunctionInfo.requestAccess through the spec, for methods with receivers too", () => {
    const fns = extractFunctionsWithSpec(lines(`
package handler

func (h *PlayerHandler) CreatePlayer(w http.ResponseWriter, r *http.Request) {
	var req model.CreatePlayerRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		return
	}
	role := r.URL.Query().Get("role")
}

func helper(x int) int { return x }
`), goSpec);
    expect(fns[0]!.params.map((p) => p.name)).toEqual(["w", "r"]);
    expect(fns[0]!.requestAccess).toEqual([
      { name: "req", type: "model.CreatePlayerRequest", binding: "body" },
      { name: "role", type: null, binding: "query" },
    ]);
    expect(fns[1]!.requestAccess).toBeUndefined();
  });
});

describe("Go struct fields for the schema pass", () => {
  it("keeps the type as written, turns tags into decorators, and sees unexported structs", () => {
    const src = lines(`
package store

type Part struct {
	ID          int          \`json:"id"\`
	Name        string       \`json:"name" validate:"required"\`
	Description *string      \`json:"description,omitempty"\`
	Tags        []string     \`json:"tags"\`
	Attrs       map[string]any
	Raw         interface{}
	secret      string
	OnChange    func(Part)
}

type createInput struct {
	Name string \`json:"name" binding:"required"\`
}
`);
    const classes = goSpec.extractClasses!(src, extractFunctionsWithSpec(src, goSpec));
    expect(classes.map((c) => c.name)).toEqual(["Part", "createInput"]);
    const props = Object.fromEntries(classes[0]!.properties.map((p) => [p.name, p]));
    expect(props["Name"]!.decorators).toEqual(['json:"name"', 'validate:"required"']);
    expect(props["Description"]!.type).toBe("*string");
    expect(props["Description"]!.decorators).toEqual(['json:"description,omitempty"']);
    expect(props["Tags"]!.type).toBe("[]string");
    expect(props["Attrs"]!.type).toBe("map[string]any");
    expect(props["Attrs"]!.decorators).toBeUndefined();
    expect(props["Raw"]!.type).toBe("interface{}");
    expect(props["secret"]!.visibility).toBe("private");
    expect(props["OnChange"]).toBeUndefined(); // func-shaped fields are not data
    expect(classes[1]!.properties[0]!.decorators).toEqual(['json:"name"', 'binding:"required"']);
  });
});
