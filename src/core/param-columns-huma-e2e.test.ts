import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { ParamColumn } from "../types/analysis.js";

/**
 * A Huma operation's input fields are the route's parameters: `path:"club"` on
 * a field of an inline input struct or of a named input type. The value goes
 * into a model's composite literal, the model into a generic handler that calls
 * a method on the object it is handed (`DoUpdate(ctx, obj CObject, a)` →
 * `obj.Update(s)`), and that method filters a column on the field — the same
 * column an Echo route binding the model directly reaches.
 */
describe("paramColumns from Huma input fields, end to end", () => {
  let dir: string;
  let rows: ParamColumn[];
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-huma-columns-"));
    const root = join(dir, "repo");
    for (const d of ["pkg/models", "pkg/db", "pkg/web/handler", "pkg/routes/api/v2"]) await mkdir(join(root, d), { recursive: true });
    await writeFile(join(root, "go.mod"), "module example.com/league\n\ngo 1.22\n\nrequire github.com/danielgtaylor/huma/v2 v2.19.0\n");
    await writeFile(join(root, "pkg/db/db.go"), "package db\n\nimport \"xorm.io/xorm\"\n\ntype Session = xorm.Session\n\nfunc NewSession() *Session { return nil }\n");
    await writeFile(join(root, "pkg/web/handler/core.go"), [
      "package handler",
      "",
      "import (",
      "\t\"context\"",
      "",
      "\t\"example.com/league/pkg/db\"",
      ")",
      "",
      "type CObject interface {",
      "\tCanUpdate(s *db.Session) (bool, error)",
      "\tUpdate(s *db.Session) error",
      "\tDelete(s *db.Session) error",
      "}",
      "",
      "func DoUpdate(ctx context.Context, obj CObject, a string) error {",
      "\ts := db.NewSession()",
      "\tok, err := obj.CanUpdate(s)",
      "\tif err != nil || !ok {",
      "\t\treturn err",
      "\t}",
      "\treturn obj.Update(s)",
      "}",
      "",
      "func DoDelete(ctx context.Context, obj CObject, a string) error {",
      "\ts := db.NewSession()",
      "\treturn obj.Delete(s)",
      "}",
    ].join("\n"));
    await writeFile(join(root, "pkg/models/club_read.go"), [
      "package models",
      "",
      "import \"xorm.io/xorm\"",
      "",
      "type ClubRead struct {",
      "\tClubID   int64 `xorm:\"bigint not null\" param:\"club\"`",
      "\tPlayerID int64 `xorm:\"bigint not null\"`",
      "}",
      "",
      "func (*ClubRead) TableName() string { return \"club_reads\" }",
      "",
      "func (c *ClubRead) CanUpdate(_ *xorm.Session) (bool, error) { return true, nil }",
      "",
      "func (c *ClubRead) Update(s *xorm.Session) error {",
      "\treturn markClubAsRead(s, c.ClubID)",
      "}",
      "",
      "func (c *ClubRead) Delete(s *xorm.Session) error { return nil }",
      "",
      "func markClubAsRead(s *xorm.Session, clubID int64) error {",
      "\t_, err := s.Where(\"club_id = ?\", clubID).Delete(&ClubRead{})",
      "\treturn err",
      "}",
    ].join("\n"));
    // A namesake field on another model the handler never hands over: no row may land here.
    await writeFile(join(root, "pkg/models/match_note.go"), [
      "package models",
      "",
      "import \"xorm.io/xorm\"",
      "",
      "type MatchNote struct {",
      "\tClubID int64 `xorm:\"bigint not null\"`",
      "}",
      "",
      "func (*MatchNote) TableName() string { return \"match_notes\" }",
      "",
      "func (m *MatchNote) CanUpdate(_ *xorm.Session) (bool, error) { return true, nil }",
      "",
      "func (m *MatchNote) Update(s *xorm.Session) error {",
      "\t_, err := s.Where(\"club_id = ?\", m.ClubID).Cols(\"text\").Update(m)",
      "\treturn err",
      "}",
      "",
      "func (m *MatchNote) Delete(s *xorm.Session) error {",
      "\t_, err := s.Where(\"club_id = ?\", m.ClubID).Delete(&MatchNote{})",
      "\treturn err",
      "}",
    ].join("\n"));
    await writeFile(join(root, "pkg/models/squad.go"), [
      "package models",
      "",
      "import \"xorm.io/xorm\"",
      "",
      "type Squad struct {",
      "\tID int64 `xorm:\"pk\"`",
      "}",
      "",
      "func (*Squad) TableName() string { return \"squads\" }",
      "",
      "func (q *Squad) CanUpdate(_ *xorm.Session) (bool, error) { return true, nil }",
      "",
      "func (q *Squad) Update(s *xorm.Session) error { return nil }",
      "",
      "func (q *Squad) Delete(s *xorm.Session) error {",
      "\t_, err := s.Where(\"id = ?\", q.ID).Delete(&Squad{})",
      "\treturn err",
      "}",
    ].join("\n"));
    await writeFile(join(root, "pkg/routes/api/v2/huma.go"), [
      "package apiv2",
      "",
      "import (",
      "\t\"context\"",
      "",
      "\t\"github.com/danielgtaylor/huma/v2\"",
      ")",
      "",
      "func Register[I, O any](api huma.API, op huma.Operation, h func(context.Context, *I) (*O, error)) {",
      "\thuma.Register(api, op, h)",
      "}",
      "",
      "func NewAPI() {",
      "\tcfg := huma.DefaultConfig(\"League\", \"1.0.0\")",
      "\tcfg.Servers = []*huma.Server{{URL: \"/api/v2\"}}",
      "}",
    ].join("\n"));
    await writeFile(join(root, "pkg/routes/api/v2/clubs.go"), [
      "package apiv2",
      "",
      "import (",
      "\t\"context\"",
      "\t\"net/http\"",
      "",
      "\t\"example.com/league/pkg/models\"",
      "\t\"example.com/league/pkg/web/handler\"",
      "",
      "\t\"github.com/danielgtaylor/huma/v2\"",
      ")",
      "",
      "type squadDeleteInput struct {",
      "\tSquadID int64 `path:\"squad\" doc:\"The squad, by id.\"`",
      "}",
      "",
      "func RegisterClubRoutes(api huma.API) {",
      "\tRegister(api, huma.Operation{Method: http.MethodPut, Path: \"/clubs/{club}/read\"}, clubsMarkRead)",
      "\tRegister(api, huma.Operation{Method: http.MethodPut, Path: \"/clubs/{club}/unread\"}, clubsMarkUnread)",
      "\tRegister(api, huma.Operation{Method: http.MethodDelete, Path: \"/squads/{squad}\"}, squadsDelete)",
      "\tRegister(api, huma.Operation{Method: http.MethodPut, Path: \"/clubs/{club}/note\"}, clubsNote)",
      "}",
      "",
      "func clubsMarkRead(ctx context.Context, in *struct {",
      "\tClubID int64 `path:\"club\" doc:\"The club, by id, to mark as read.\"`",
      "}) (*struct{}, error) {",
      "\tt := &models.ClubRead{ClubID: in.ClubID}",
      "\treturn nil, handler.DoUpdate(ctx, t, \"me\")",
      "}",
      "",
      "// The field the input binds is overwritten before the handler hands the model on.",
      "func clubsMarkUnread(ctx context.Context, in *struct {",
      "\tClubID int64 `path:\"club\"`",
      "}) (*struct{}, error) {",
      "\tt := &models.ClubRead{ClubID: in.ClubID}",
      "\tt.ClubID = 0",
      "\treturn nil, handler.DoUpdate(ctx, t, \"me\")",
      "}",
      "",
      "func squadsDelete(ctx context.Context, input *squadDeleteInput) (*struct{}, error) {",
      "\tq := &models.Squad{ID: input.SquadID}",
      "\treturn nil, handler.DoDelete(ctx, q, \"me\")",
      "}",
      "",
      "// A body field, not the path's: the note's club is not the route's parameter.",
      "func clubsNote(ctx context.Context, in *struct {",
      "\tBody struct {",
      "\t\tClubID int64 `json:\"club\"`",
      "\t}",
      "}) (*struct{}, error) {",
      "\tn := &models.MatchNote{ClubID: in.Body.ClubID}",
      "\treturn nil, handler.DoUpdate(ctx, n, \"me\")",
      "}",
    ].join("\n"));
    await analyze({ projectRoot: root, outputDir: join(dir, "out"), lsp: false, gitHistory: false, stableOutput: true });
    rows = ((await loadReportSummary(join(dir, "out"))) as { paramColumns?: ParamColumn[] }).paramColumns ?? [];
  }, 60_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const reached = () => rows.map((r) => `${r.route.method} ${r.route.path} ${r.route.param} → ${r.column.entity}.${r.column.field} @${r.column.file}`).sort();

  it("follows an inline input's path field through the model literal and the generic handler's dispatch to the column", () => {
    const row = rows.find((r) => r.route.path === "/api/v2/clubs/{club}/read");
    expect(row?.hops.map((h) => h.symbol)).toEqual(["clubsMarkRead", "DoUpdate", "ClubRead.Update", "markClubAsRead"]);
    expect(row?.column).toMatchObject({ entity: "ClubRead", field: "club_id", access: "write" });
  });

  it("starts at a named input type's bound field, and lands on no namesake field nor a rewritten one", () => {
    expect(reached()).toEqual([
      "DELETE /api/v2/squads/{squad} squad → Squad.id @pkg/models/squad.go",
      "PUT /api/v2/clubs/{club}/read club → ClubRead.club_id @pkg/models/club_read.go",
    ]);
  });
});
