import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import "../../registry.js";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";

/**
 * Every package of the league declares its own `Controller` and `Repository`. A field or parameter typed through
 * an import (`*clubs.Controller`, `*playerCtrl.Controller` under an alias, `*clubRepo.Repository`) is the type of
 * the package that import names — also where the importing package is named like the imported one
 * (`package clubs` importing `repo/clubs`), whose own namesake a qualified name never means. A method in a sibling
 * file of the type's package is the type's, not the namesake method another package's type declares.
 */
const repository = (pkg: string, table: string) => `package ${pkg}

import (
\t"context"
\t"database/sql"
)

type Repository struct {
\tDB *sql.DB
}

func (r *Repository) Remove(ctx context.Context, id string) error {
\t_, err := r.DB.ExecContext(ctx, "DELETE FROM ${table} WHERE id = $1", id)
\treturn err
}
`;
const controller = (pkg: string) => `package ${pkg}

import (
\t"context"

\t"example.com/league/repo/${pkg}"
)

type Controller struct {
\tRepo *${pkg}.Repository
}

func (c *Controller) Remove(ctx context.Context, id string) error {
\treturn c.Repo.Remove(ctx, id)
}
`;

const FILES: Record<string, string> = {
  "go.mod": "module example.com/league\n\ngo 1.22\n\nrequire github.com/gin-gonic/gin v1.9.1\n",
  // The clubs repository's method sits in a sibling file of its package, beside the players' namesake method.
  "repo/clubs/repository.go": "package clubs\n\nimport \"database/sql\"\n\ntype Repository struct {\n\tDB *sql.DB\n}\n",
  "repo/clubs/remove.go": repository("clubs", "clubs").replace(/type Repository struct \{\n\tDB \*sql.DB\n\}\n\n/, "").replace('\t"database/sql"\n', ""),
  "repo/players/repository.go": repository("players", "players"),
  "controller/clubs/controller.go": controller("clubs"),
  "controller/players/controller.go": controller("players"),
  // A method in a sibling file that imports nothing: the field's type is read against the file declaring it.
  "controller/clubs/audit.go": "package clubs\n\nfunc (c *Controller) Audit() error {\n\treturn c.Repo.Remove(nil, \"x\")\n}\n",
  "api/clubs.go": `package api

import (
\t"github.com/gin-gonic/gin"

\t"example.com/league/controller/clubs"
)

type ClubHandler struct {
\tCtrl *clubs.Controller
}

func (h *ClubHandler) Remove(c *gin.Context) {
\t_ = h.Ctrl.Remove(c, c.Param("id"))
}
`,
  "api/players.go": `package api

import (
\t"github.com/gin-gonic/gin"

\tplayerCtrl "example.com/league/controller/players"
)

type PlayerHandler struct {
\tController *playerCtrl.Controller
}

func (h *PlayerHandler) Remove(c *gin.Context) {
\t_ = h.Controller.Remove(c, c.Param("id"))
}
`,
  "api/sweep.go": `package api

import (
\t"context"

\tclubRepo "example.com/league/repo/clubs"
)

func Sweep(ctx context.Context, r *clubRepo.Repository) error {
\treturn r.Remove(ctx, "x")
}
`,
};

describe("a Go type written through its package's import", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-go-qualified-types-"));
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

  it("is that package's declaration, never a namesake of another package", () => {
    const links = (summary.symbolLinks ?? []).filter((l) => l.targetSymbol.endsWith(".Remove") && l.sourceSymbol !== l.targetSymbol);
    expect(links.map((l) => `${l.sourceFile}::${l.sourceSymbol} -> ${l.targetFile}::${l.targetSymbol}`).sort()).toEqual([
      "api/clubs.go::ClubHandler.Remove -> controller/clubs/controller.go::Controller.Remove",
      "api/players.go::PlayerHandler.Remove -> controller/players/controller.go::Controller.Remove",
      "api/sweep.go::Sweep -> repo/clubs/remove.go::Repository.Remove",
      "controller/clubs/audit.go::Controller.Audit -> repo/clubs/remove.go::Repository.Remove",
      "controller/clubs/controller.go::Controller.Remove -> repo/clubs/remove.go::Repository.Remove",
      "controller/players/controller.go::Controller.Remove -> repo/players/repository.go::Repository.Remove",
    ]);
  });
});
