import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import "../../registry.js";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";

/**
 * A route registered by a method on its server names its handler through the receiver: a
 * method of the receiver (`s.Standings`), of a field's type (`s.clubs.List`, `s.health.Check`) or
 * of a local's (`h := handlers.NewClubHandler()`, `h.Show`), which another package declares beside
 * a same-named method of another type.
 */
const FILES: Record<string, string> = {
  "go.mod": "module example.com/league\n\ngo 1.22\n\nrequire github.com/labstack/echo/v4 v4.11.0\n",
  "pkg/server/server.go": `package server

import (
\t"github.com/labstack/echo/v4"

\t"example.com/league/pkg/handlers"
)

type Server struct {
\tclubs  *handlers.ClubHandler
\thealth handlers.HealthHandler
}

func (s *Server) Routes(e *echo.Echo) {
\te.GET("/api/v2/clubs", s.clubs.List)
\te.GET("/health", s.health.Check)
\te.GET("/api/v2/standings", s.Standings)
}

func (s *Server) Standings(c echo.Context) error {
\treturn nil
}

func RegisterSquad(e *echo.Echo) {
\th := handlers.NewClubHandler()
\te.GET("/api/v2/squad", h.Show)
}
`,
  "pkg/handlers/clubs.go": `package handlers

import "github.com/labstack/echo/v4"

type ClubHandler struct{}

func NewClubHandler() *ClubHandler {
\treturn &ClubHandler{}
}

func (h *ClubHandler) List(c echo.Context) error {
\treturn nil
}

func (h *ClubHandler) Show(c echo.Context) error {
\treturn nil
}

type HealthHandler struct{}

func (h HealthHandler) Check(c echo.Context) error {
\treturn nil
}
`,
  "pkg/handlers/players.go": `package handlers

import "github.com/labstack/echo/v4"

type PlayerHandler struct{}

func (h *PlayerHandler) List(c echo.Context) error {
\treturn nil
}

func (h *PlayerHandler) Check(c echo.Context) error {
\treturn nil
}

func (h *PlayerHandler) Standings(c echo.Context) error {
\treturn nil
}

func (h *PlayerHandler) Show(c echo.Context) error {
\treturn nil
}
`,
};

describe("a Go route whose handler is reached through its server's receiver", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-go-field-handlers-"));
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

  it("anchors each route on the method its receiver chain names", () => {
    const links = (summary.symbolLinks ?? []).filter((l) => l.sourceFile === "pkg/server/server.go" && l.sourceSymbol.startsWith("route:"));
    expect(links.map((l) => `${l.sourceSymbol} -> ${l.targetFile}::${l.targetSymbol}`).sort()).toEqual([
      "route:GET /api/v2/clubs -> pkg/handlers/clubs.go::ClubHandler.List",
      "route:GET /api/v2/squad -> pkg/handlers/clubs.go::ClubHandler.Show",
      "route:GET /api/v2/standings -> pkg/server/server.go::Server.Standings",
      "route:GET /health -> pkg/handlers/clubs.go::HealthHandler.Check",
    ]);
  });
});
