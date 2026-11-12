import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { ParamColumn } from "../types/analysis.js";

/**
 * A Go filter written as a struct (`s.Get(&Club{ID: id})`, `s.Where(&Transfer{OtherClubID: x})`, a bean
 * handed to `s.Get(c)`) names the struct's MEMBER; the row a route's parameter reaches must name the
 * COLUMN, spelled as `Where("club_id = ?", id)` spells it: the xorm tag (`'club_id'`, a bare `club_id`),
 * GORM's `column:`, else the mapper convention. The struct sits in another file; a same-named struct of
 * another package with other tags is never the one used.
 */
describe("paramColumns from a Go struct condition, end to end", () => {
  let dir: string;
  let rows: ParamColumn[];
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-go-struct-cond-"));
    const root = join(dir, "league");
    for (const d of ["models", "other", "web"]) await mkdir(join(root, d), { recursive: true });
    await writeFile(join(root, "go.mod"), "module example.com/league\n\ngo 1.21\n");
    await writeFile(join(root, "models/club.go"), [
      "package models",
      "",
      "type Club struct {",
      "\tID          int64  `xorm:\"'club_id' pk autoincr\"`",
      "\tLeagueID    int64  `xorm:\"league_ref index\"`",
      "\tName        string `xorm:\"VARCHAR(100)\"`",
      "\tNote        string `xorm:\"-\"`",
      "}",
      "",
      "type Transfer struct {",
      "\tID          int64 `xorm:\"pk autoincr\"`",
      "\tOtherClubID int64",
      "\tPlayerRef   int64 `gorm:\"column:player_ref_x\"`",
      "}",
    ].join("\n"));
    await writeFile(join(root, "other/club.go"), [
      "package other",
      "",
      "type Club struct {",
      "\tID       int64 `xorm:\"'decoy_id' pk\"`",
      "\tLeagueID int64 `xorm:\"'decoy_league'\"`",
      "}",
      "",
      "func GetDecoy(s *xorm.Session, id int64) (*Club, error) {",
      "\tc := &Club{}",
      "\t_, err := s.Get(&Club{ID: id})",
      "\treturn c, err",
      "}",
    ].join("\n"));
    await writeFile(join(root, "models/queries.go"), [
      "package models",
      "",
      "import \"xorm.io/xorm\"",
      "",
      "func GetClub(s *xorm.Session, id int64) (*Club, error) {",
      "\tc := &Club{}",
      "\t_, err := s.Get(&Club{ID: id})",
      "\treturn c, err",
      "}",
      "",
      "func GetTransfer(s *xorm.Session, other int64) (*Transfer, error) {",
      "\tt := &Transfer{}",
      "\t_, err := s.Where(&Transfer{OtherClubID: other}).Get(t)",
      "\treturn t, err",
      "}",
      "",
      "func ClubsInLeague(s *xorm.Session, leagueID int64) ([]*Club, error) {",
      "\tvar out []*Club",
      "\terr := s.Find(&out, &Club{LeagueID: leagueID})",
      "\treturn out, err",
      "}",
      "",
      "func ByBean(s *xorm.Session, c *Club) error {",
      "\t_, err := s.Get(c)",
      "\treturn err",
      "}",
      "",
      "func ByNote(s *xorm.Session, note string) (*Club, error) {",
      "\tc := &Club{}",
      "\t_, err := s.Where(&Club{Note: note}).Get(c)",
      "\treturn c, err",
      "}",
      "",
      "func ByTransferRef(s *xorm.Session, ref int64) (*Transfer, error) {",
      "\tt := &Transfer{}",
      "\t_, err := s.Get(&Transfer{PlayerRef: ref})",
      "\treturn t, err",
      "}",
    ].join("\n"));
    await writeFile(join(root, "web/handler.go"), [
      "package web",
      "",
      "import (",
      "\t\"example.com/league/models\"",
      "\t\"example.com/league/other\"",
      "\t\"github.com/gin-gonic/gin\"",
      "\t\"xorm.io/xorm\"",
      ")",
      "",
      "func Routes(r *gin.Engine) {",
      "\tr.GET(\"/clubs/:id\", showClub)",
      "\tr.GET(\"/transfers/:other\", showTransfer)",
      "\tr.GET(\"/leagues/:league/clubs\", listClubs)",
      "\tr.GET(\"/beans/:id\", showBean)",
      "\tr.GET(\"/refs/:ref\", showRef)",
      "\tr.GET(\"/notes/:note\", showNote)",
      "\tr.GET(\"/decoys/:id\", showDecoy)",
      "\tr.GET(\"/inline/:id\", showInline)",
      "\tr.GET(\"/qualified/:id\", showQualified)",
      "}",
      "",
      "func showClub(c *gin.Context) {",
      "\tid := c.Param(\"id\")",
      "\tmodels.GetClub(nil, id)",
      "}",
      "",
      "func showTransfer(c *gin.Context) {",
      "\tother := c.Param(\"other\")",
      "\tmodels.GetTransfer(nil, other)",
      "}",
      "",
      "func listClubs(c *gin.Context) {",
      "\tleague := c.Param(\"league\")",
      "\tmodels.ClubsInLeague(nil, league)",
      "}",
      "",
      "func showBean(c *gin.Context) {",
      "\tid := c.Param(\"id\")",
      "\tmodels.ByBean(nil, &models.Club{ID: id})",
      "}",
      "",
      "func showRef(c *gin.Context) {",
      "\tref := c.Param(\"ref\")",
      "\tmodels.ByTransferRef(nil, ref)",
      "}",
      "",
      "// A member the table has no column for names nothing.",
      "func showNote(c *gin.Context) {",
      "\tnote := c.Param(\"note\")",
      "\tmodels.ByNote(nil, note)",
      "}",
      "",
      "func showDecoy(c *gin.Context) {",
      "\tid := c.Param(\"id\")",
      "\tother.GetDecoy(nil, id)",
      "}",
      "",
      "// The literal is written in this package, whose struct is named by its qualifier.",
      "func showInline(c *gin.Context, s *xorm.Session) {",
      "\tid := c.Param(\"id\")",
      "\ts.Get(&models.Club{ID: id})",
      "}",
      "",
      "func showQualified(c *gin.Context, s *xorm.Session) {",
      "\tid := c.Param(\"id\")",
      "\ts.Get(&other.Club{ID: id})",
      "}",
    ].join("\n"));
    await analyze({ projectRoot: root, outputDir: join(dir, "out"), lsp: false, gitHistory: false, stableOutput: true });
    rows = ((await loadReportSummary(join(dir, "out"))) as { paramColumns?: ParamColumn[] }).paramColumns ?? [];
  }, 60_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const reached = () => rows.map((r) => `${r.route.path} ${r.route.param} → ${r.column.entity}.${r.column.field}`).sort();

  it("names the column the tag or the mapper convention gives, never the member", () => {
    expect(reached()).toEqual([
      "/beans/:id id → Club.club_id",
      "/clubs/:id id → Club.club_id",
      "/inline/:id id → Club.club_id",
      "/leagues/:league/clubs league → Club.league_ref",
      "/refs/:ref ref → Transfer.player_ref_x",
      "/transfers/:other other → Transfer.other_club_id",
      "/decoys/:id id → Club.decoy_id",
      "/qualified/:id id → Club.decoy_id",
    ].sort());
  });
});
