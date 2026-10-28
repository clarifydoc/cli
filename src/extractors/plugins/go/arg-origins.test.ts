import { describe, it, expect } from "vitest";
import "../../registry.js";
import { extractWithRegex } from "../../../core/regex-extractor.js";

const analyze = (src: string, file = "routers/clubs.go") => extractWithRegex(src, file, "go");
const callsOf = (src: string, fn: string) => {
  const a = analyze(src);
  const f = [...a.functions, ...a.classes.flatMap((c) => c.methods)].find((x) => x.name === fn)!;
  return f.calls.filter((c) => c.argOrigins).map((c) => [c.name, c.argOrigins]);
};

describe("Go argument origins", () => {
  it("reads a route parameter off the request, through a local and a conversion, and skips the request context", () => {
    expect(callsOf(`package routers

func GetClub(ctx *context.APIContext) {
	strID := ctx.PathParam("id")
	if clubID, err := strconv.ParseInt(strID, 10, 64); err == nil {
		club, err := league.GetClubByID(ctx, clubID)
	}
	league.GetClubBySlug(ctx, ctx.PathParam("slug"), c.Query("season"))
}
`, "GetClub")).toEqual([
      ["strconv.ParseInt", [{ index: 0, origin: { kind: "route-param", name: "id" } }]],
      ["league.GetClubByID", [{ index: 1, origin: { kind: "route-param", name: "id" }, transform: "strconv.ParseInt" }]],
      ["league.GetClubBySlug", [{ index: 1, origin: { kind: "route-param", name: "slug" } }, { index: 2, origin: { kind: "query-param", name: "season" } }]],
    ]);
  });

  it("hands a parameter on by position, never one assigned again", () => {
    expect(callsOf(`package league

func GetSquad(ctx context.Context, clubID, season int64) {
	season = season - 1
	loadPlayers(ctx, clubID, season)
}
`, "GetSquad")).toEqual([["loadPlayers", [{ index: 1, origin: { kind: "param", name: "clubID", index: 1 } }]]]);
  });
});

describe("Go receiver and parameter fields", () => {
  const SRC = `package models

type Club struct {
	ID       int64 \`xorm:"pk" json:"id" param:"club"\`
	LeagueID int64 \`json:"league_id" param:"league"\`
	Season   string \`query:"season"\`
	Name     string \`json:"name" query:"-"\`
}

func (c *Club) ReadOne(s *xorm.Session, a web.Auth) error {
	views, err := loadViews(s, c.ID, []int64{c.LeagueID})
	if err := c.loadCoach(s); err != nil {
		return err
	}
	*c, err = GetClubSimple(s, c.ID)
	touchClub(s, c.ID)
	return markRead(s, &Player{ClubID: c.ID, Name: "x"}, c)
}

func (c *Club) Rename(s *xorm.Session) error {
	c.Name = strings.TrimSpace(c.Name)
	_, err := s.Where("id = ? AND name = ?", c.ID, c.Name).Get(&Club{})
	return err
}

func touchSquad(s *xorm.Session, p *Player) error {
	_, err := s.ID(p.ClubID).Cols("updated").Update(p)
	return err
}
`;
  it("binds a tagged field from the route or the query", () => {
    const club = analyze(SRC, "models/club.go").classes.find((c) => c.name === "Club")!;
    expect(club.properties.map((p) => [p.name, p.boundFrom ?? null])).toEqual([
      ["ID", { kind: "route-param", name: "club" }],
      ["LeagueID", { kind: "route-param", name: "league" }],
      ["Season", { kind: "query-param", name: "season" }],
      ["Name", null],
    ]);
  });

  it("reads the receiver's fields, the receiver itself, and the fields of a composite argument — until the method writes them", () => {
    expect(callsOf(SRC, "ReadOne")).toEqual([
      ["loadViews", [{ index: 1, origin: { kind: "receiver-field", name: "ID" } }, { index: 2, origin: { kind: "receiver-field", name: "LeagueID" }, transform: "[]int64" }]],
      ["c.loadCoach", [{ index: -1, origin: { kind: "receiver" } }]],
      // Read on the line that writes `*c`: before the write.
      ["GetClubSimple", [{ index: 1, origin: { kind: "receiver-field", name: "ID" } }]],
    ]);
  });

  it("filters on a receiver field the method does not write, and on a parameter's field", () => {
    const a = analyze(SRC, "models/club.go");
    expect(a.dataSources.filter((d) => d.whereFields).map((d) => [d.line, d.whereFields])).toEqual([
      [22, [{ field: "id", origin: { kind: "receiver-field", name: "ID" } }]],
      [27, [{ field: "id", origin: { kind: "param-field", name: "p", index: 1, member: "ClubID" } }]],
    ]);
  });
});

describe("Go ORM filter fields", () => {
  it("reads xorm and GORM conditions compared with a parameter", () => {
    const a = analyze(`package league

import "xorm.io/xorm"

func GetClubInLeagueByID(ctx context.Context, leagueID, clubID int64) (*Club, error) {
	c, exist, err := db.Get[Club](ctx, builder.Eq{"id": clubID, "league_id": leagueID})
	return c, err
}

func GetMatch(ctx context.Context, id int64, season string) (*Match, error) {
	m := new(Match)
	has, err := db.GetEngine(ctx).
		Where("id = ? AND season = ? AND played = ?", id, season, true).
		Get(m)
	return m, err
}

func DeletePlayer(ctx context.Context, playerID int64) error {
	_, err := db.GetEngine(ctx).ID(playerID).Delete(new(Player))
	return err
}
`, "models/league/club.go");
    expect(a.dataSources.filter((d) => d.whereFields).map((d) => [d.line, d.whereFields])).toEqual([
      [6, [{ field: "id", origin: { kind: "param", name: "clubID", index: 2 } }, { field: "league_id", origin: { kind: "param", name: "leagueID", index: 1 } }]],
      [14, [{ field: "id", origin: { kind: "param", name: "id", index: 1 } }, { field: "season", origin: { kind: "param", name: "season", index: 2 } }]],
      [19, [{ field: "id", origin: { kind: "param", name: "playerID", index: 1 } }]],
    ]);
  });
});
