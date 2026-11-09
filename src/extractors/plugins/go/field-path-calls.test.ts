import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import "../../registry.js";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";
import { readGo } from "./antlr.js";

/**
 * A handler that reaches its controller through fields of fields — `h.Module.Clubs.Promote(c, id)`, the API
 * holding a module of controllers — names the call by its whole path, so the linker types `Clubs` as a field of
 * `Module`, not of the handler. A namesake method on the other controller is the decoy a name guess would take, and a
 * `Module` the repository package declares too is the namesake of the module.
 */
const FILES: Record<string, string> = {
  "go.mod": "module example.com/league\n\ngo 1.22\n\nrequire github.com/gin-gonic/gin v1.9.1\n",
  "cmd/main.go": `package main

import (
\t"database/sql"

\t"github.com/gin-gonic/gin"

\t"example.com/league/api"
\t"example.com/league/controller"
\t"example.com/league/repo"
)

func main() {
\tdb, _ := sql.Open("postgres", "")
\tmodule := controller.NewModule(repo.NewClubsRepository(db), repo.NewPlayersRepository(db))
\th := api.NewHandlers(module)
\tr := gin.Default()
\tr.POST("/api/v2/clubs/promote", h.PromoteClub)
\tr.POST("/api/v2/players/transfer", h.TransferPlayer)
\tr.Run()
}
`,
  "api/handlers.go": `package api

import (
\t"github.com/gin-gonic/gin"

\t"example.com/league/controller"
)

type Handlers struct {
\tModule *controller.Module
}

func NewHandlers(module *controller.Module) *Handlers {
\treturn &Handlers{Module: module}
}

func (h *Handlers) PromoteClub(c *gin.Context) {
\terr := h.Module.Clubs.Promote(c, c.Param("id"))
\tif err != nil {
\t\tc.JSON(500, nil)
\t}
}

`,
  // The handler's other method sits in a sibling file, and ten other packages declare a \`Handlers\` of their own:
  // the receiver is the type this directory's parts make up, however many namesakes come before it.
  "api/transfers.go": `package api

import "github.com/gin-gonic/gin"

func (h *Handlers) TransferPlayer(c *gin.Context) {
\t_ = h.Module.Players.Transfer(c, c.Param("id"))
}
`,
  ...Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`aaa/stand${i}/handlers.go`, `package stand${i}\n\ntype Handlers struct {\n\tModule *Module\n}\n\ntype Module struct {\n\tPlayers *Seats\n}\n\ntype Seats struct{}\n\nfunc (s *Seats) Transfer(a, b any) error { return nil }\n`])),
  "controller/module.go": `package controller

import "example.com/league/repo"

type Module struct {
\tClubs   *ClubsController
\tPlayers *PlayersController
}

func NewModule(clubs *repo.ClubsRepository, players *repo.PlayersRepository) *Module {
\treturn &Module{Clubs: &ClubsController{Repo: clubs}, Players: &PlayersController{Repo: players}}
}
`,
  "controller/clubs.go": `package controller

import (
\t"context"

\t"example.com/league/repo"
)

type ClubsController struct {
\tRepo *repo.ClubsRepository
}

func (c *ClubsController) Promote(ctx context.Context, id string) error {
\treturn c.Repo.Promote(ctx, id)
}

func (c *ClubsController) Transfer(ctx context.Context, id string) error {
\treturn c.Repo.Promote(ctx, id)
}
`,
  "controller/players.go": `package controller

import (
\t"context"

\t"example.com/league/repo"
)

type PlayersController struct {
\tRepo *repo.PlayersRepository
}

func (c *PlayersController) Transfer(ctx context.Context, id string) error {
\treturn c.Repo.Transfer(ctx, id)
}

func (c *PlayersController) Promote(ctx context.Context, id string) error {
\treturn c.Repo.Transfer(ctx, id)
}
`,
  // A namesake of the module in another package: the handler's field names the controller package's.
  "repo/module.go": `package repo

type Module struct {
\tClubs *ClubsRepository
}
`,
  "repo/clubs.go": `package repo

import (
\t"context"
\t"database/sql"
)

type ClubsRepository struct {
\tDB *sql.DB
}

func NewClubsRepository(db *sql.DB) *ClubsRepository { return &ClubsRepository{DB: db} }

func (r *ClubsRepository) Promote(ctx context.Context, id string) error {
\t_, err := r.DB.ExecContext(ctx, "UPDATE clubs SET division = division - 1 WHERE id = $1", id)
\treturn err
}
`,
  "repo/players.go": `package repo

import (
\t"context"
\t"database/sql"
)

type PlayersRepository struct {
\tDB *sql.DB
}

func NewPlayersRepository(db *sql.DB) *PlayersRepository { return &PlayersRepository{DB: db} }

func (r *PlayersRepository) Transfer(ctx context.Context, id string) error {
\t_, err := r.DB.ExecContext(ctx, "UPDATE players SET club_id = NULL WHERE id = $1", id)
\treturn err
}
`,
};

describe("a Go call through fields of fields", () => {
  it("is named from the receiver or a parameter; the receiver's own field, a local's path and a package member keep two names", () => {
    const parsed = readGo(`package api

func (h *Handlers) Promote(c *gin.Context, coach *Coach) {
\th.Module.Clubs.Promote(c)
\th.repo.Save(c)
\tcoach.Staff.Notify(c)
\thttp.DefaultClient.Do(nil)
\th.Module.
\t\tClubs.Relegate(c)
\tfor _, club := range coach.Clubs {
\t\tclub.Ground.Book(c)
\t}
}
`);
    expect(parsed.functions[0]!.calls.filter((c) => !c.passed).map((c) => c.name)).toEqual([
      "h.Module.Clubs.Promote",
      "repo.Save",
      "coach.Staff.Notify",
      "DefaultClient.Do",
      "Clubs.Relegate",
      "Ground.Book",
    ]);
  });

  describe("in an analysis", () => {
    let dir: string;
    let summary: ProjectAnalysis;
    beforeAll(async () => {
      dir = await mkdtemp(join(tmpdir(), "cd-go-field-path-"));
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

    it("links each handler to the controller its field path holds, never the namesake", () => {
      const links = (summary.symbolLinks ?? []).filter((l) => l.sourceFile.startsWith("api/") && l.sourceSymbol.startsWith("Handlers.") && !l.targetFile.startsWith("api/"));
      expect(links.map((l) => `${l.sourceSymbol} -> ${l.targetFile}::${l.targetSymbol}`).sort()).toEqual([
        "Handlers.PromoteClub -> controller/clubs.go::ClubsController.Promote",
        "Handlers.TransferPlayer -> controller/players.go::PlayersController.Transfer",
      ]);
    });

    it("so each route reaches the table its repository writes", () => {
      const flows = (summary.dataFlows ?? []).filter((f) => f.entryKind === "route" && f.effect === "db-write");
      expect(flows.map((f) => `${f.entryLabel} -> ${f.resource}`).sort()).toEqual([
        "POST /api/v2/clubs/promote -> clubs",
        "POST /api/v2/players/transfer -> players",
      ]);
    });
  });
});
