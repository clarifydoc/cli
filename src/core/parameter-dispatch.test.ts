import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { ProjectAnalysis } from "../types/analysis.js";

/**
 * A generic CRUD handler that dispatches on the interface its caller hands it
 * (real-repo FP: generic CRUD routes reached no table — `obj.Create(s, a)` on a
 * `CObject` with dozens of implementations was never followed).
 */
const FILES: Record<string, string> = {
  "go.mod": "module example.com/league\n\ngo 1.22\n",
  "pkg/web/handler/core.go": `package handler

type Permissions interface {
	CanCreate(s *Session) (bool, error)
}

type CRUDable interface {
	Create(s *Session) error
}

// Its method set is the two it embeds.
type CObject interface {
	CRUDable
	Permissions
}

// Embeds an interface the analysis lacks: its method set is not known, so it matches nothing.
type Streamed interface {
	io.Reader
	Create(s *Session) error
}

type Session struct{}

func DoCreate(obj CObject) error {
	s := &Session{}
	if ok, err := obj.CanCreate(s); err != nil || !ok {
		return err
	}
	return obj.Create(s)
}
`,
  "pkg/models/player.go": `package models

import "example.com/league/pkg/web/handler"

type Player struct{ Name string }

func (p *Player) CanCreate(s *handler.Session) (bool, error) { return true, nil }
func (p *Player) Create(s *handler.Session) error { return insertPlayer(p) }
func insertPlayer(p *Player) error { return nil }
`,
  "pkg/models/club.go": `package models

import "example.com/league/pkg/web/handler"

// Its permission check is promoted from the embedded interface.
type Club struct {
	handler.Permissions \`json:"-"\`
	Name string
}

func (c *Club) Create(s *handler.Session) error { return nil }
`,
  "pkg/routes/players.go": `package routes

import (
	"example.com/league/pkg/models"
	"example.com/league/pkg/web/handler"
)

func clubsCreate(in *struct {
	Body models.Club
}) error {
	return handler.DoCreate(&in.Body)
}

func playersCreate(in *struct {
	Body models.Player
}) error {
	return handler.DoCreate(&in.Body)
}

// A composite literal handed straight to the handler names its type, whatever the caller's own types say.
func clubsImport(in *struct {
	Body models.Player
}) error {
	return handler.DoCreate(&models.Club{
		Name: in.Body.Name,
	})
}
`,
  // A v1-style generic web handler: the type it works on is the one its EmptyStruct field returns.
  "pkg/web/handler/web.go": `package handler

type WebHandler struct {
	EmptyStruct func() CObject
}

func (c *WebHandler) CreateWeb(ctx *echo.Context) error {
	current := c.EmptyStruct()
	return DoCreate(current)
}
`,
  "pkg/routes/routes.go": `package routes

import (
	"example.com/league/pkg/models"
	"example.com/league/pkg/web/handler"
)

func registerAPIRoutes(a *echo.Group) {
	playerHandler := &handler.WebHandler{
		EmptyStruct: func() handler.CObject {
			return &models.Player{}
		},
	}
	a.PUT("/players", playerHandler.CreateWeb)
}
`,
};

describe("a generic handler dispatching on its caller's type", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-param-dispatch-"));
    for (const [rel, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(dir, "app", rel)), { recursive: true });
      await writeFile(join(dir, "app", rel), text);
    }
    await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    summary = await loadReportSummary(join(dir, "out"));
  }, 60_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("links the caller to the methods the handler calls on the implementation it names", () => {
    const links = (summary.symbolLinks ?? [])
      .filter((l) => l.sourceSymbol === "playersCreate" && l.strategy === "interface-redirect")
      .map((l) => `${l.callName} -> ${l.targetFile}::${l.targetSymbol}`).sort();
    expect(links).toEqual([
      "obj.CanCreate -> pkg/models/player.go::Player.CanCreate",
      "obj.Create -> pkg/models/player.go::Player.Create",
    ]);
  });

  it("counts a type whose methods are partly promoted from an embedded interface", () => {
    const links = (summary.symbolLinks ?? [])
      .filter((l) => l.sourceSymbol === "clubsCreate" && l.strategy === "interface-redirect")
      .map((l) => `${l.callName} -> ${l.targetSymbol}`);
    // The promoted method is the embedded interface's own.
    expect(links.sort()).toEqual(["obj.CanCreate -> Permissions.CanCreate", "obj.Create -> Club.Create"]);
  });

  it("binds the handler to the type of a composite literal the call hands it", () => {
    const links = (summary.symbolLinks ?? [])
      .filter((l) => l.sourceSymbol === "clubsImport" && l.strategy === "interface-redirect")
      .map((l) => `${l.callName} -> ${l.targetSymbol}`);
    expect(links.sort()).toEqual(["obj.CanCreate -> Permissions.CanCreate", "obj.Create -> Club.Create"]);
  });

  it("links a route to the implementation its handler's receiver is built for", () => {
    const route = summary.routeMap?.find((r) => r.path === "/players");
    expect(route?.handlerTypes).toEqual(["models.Player"]);
    const links = (summary.symbolLinks ?? [])
      .filter((l) => l.sourceSymbol === "route:PUT /players" && l.strategy === "interface-redirect")
      .map((l) => `${l.callName} -> ${l.targetSymbol}`).sort();
    expect(links).toEqual(["obj.CanCreate -> Player.CanCreate", "obj.Create -> Player.Create"]);
  });

  it("never counts an implementation of an interface whose embedded part is unknown", () => {
    const fanout = (summary.symbolLinks ?? []).filter((l) => l.strategy === "interface-fanout").map((l) => l.sourceSymbol);
    expect(fanout.some((s) => s.startsWith("Streamed."))).toBe(false);
    expect(fanout).toContain("CRUDable.Create");
    expect(fanout).not.toContain("CObject.Create");
  });
});
