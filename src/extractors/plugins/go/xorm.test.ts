import { describe, it, expect } from "vitest";
import { extractXormDataSources } from "./xorm.js";

const rows = (src: string) => extractXormDataSources(src.split("\n")).map((d) => `${d.line} ${d.name} ${d.entity ?? "-"} ${d.access}`);

describe("xorm data sources", () => {
  it("reads engine chains, generic helpers and the argument's entity", () => {
    expect(rows(`package issues

import "code.gitea.io/gitea/models/db"

func GetLabelsByRepoID(ctx context.Context, repoID int64) ([]*Label, error) {
	labels := make([]*Label, 0, 10)
	return labels, db.GetEngine(ctx).
		Where("repo_id = ?", repoID).
		Find(&labels)
}

func getIssueByID(ctx context.Context, issue *Issue, id int64) error {
	has, err := db.GetEngine(ctx).ID(id).Get(issue)
	return err
}

func NewComment(ctx context.Context) error {
	e := db.GetEngine(ctx)
	if _, err := e.Insert(&Comment{Type: 1}); err != nil {
		return err
	}
	topics, err := db.Find[repo_model.Topic](ctx, opts)
	return db.Insert(ctx, review)
}

func Fetch(c *http.Client) { c.Get("https://example.com") }
`)).toEqual([
      "9 xorm: Find Label read",
      "13 xorm: Get Issue read",
      "19 xorm: Insert Comment write",
      "22 xorm: Find Topic read",
      "23 xorm: Insert - write",
    ]);
  });

  it("reads nothing in a file that never states xorm", () => {
    expect(rows(`package web\nfunc h(e echo.Context) error { return e.Get("player") }`)).toEqual([]);
  });
});

describe("GORM chains", () => {
  it("reads chains from a DB function, taking the entity from .Model(…), the argument or the receiver", () => {
    expect(rows(`package entity

import "gorm.io/gorm"

func (m *Photo) Create() error {
	if err := UnscopedDb().Create(m).Error; err != nil {
		return err
	}
	return UnscopedDb().Model(m).UpdateColumn("taken_at", now).Error
}

func RemoveLabels(id uint) error {
	return Db().Where("photo_id = ?", id).Delete(&PhotoLabel{}).Error
}

func Labels() (result []Label) {
	Db().
		Where("label_priority > 0").
		Find(&result)
	return result
}
`)).toEqual([
      "6 GORM: Create Photo write",
      "9 GORM: UpdateColumn Photo write",
      "13 GORM: Delete PhotoLabel write",
      "19 GORM: Find Label read", // the named result `(result []Label)`
    ]);
  });

  it("reads a file that only chains on the project's Db() helper, and a builder kept in a local (real-repo FP)", () => {
    expect(rows(`package search

func Clubs(f form.SearchClubs) (results []ClubResult, err error) {
	s := UnscopedDb().Table("clubs").
		Select("clubs.*")

	if f.League != "" {
		s = s.Where("league_uid = ?", f.League)
	}

	err = s.Scan(&results).Error
	return results, err
}

func Players() (results []PlayerResult) {
	q := Db().Table("players")
	q.Find(&results)
	s := fmt.Sprintf("%d", 1)
	s.Scan(&results)
	return results
}

func Touch(uid string) error {
	return Db().Model(&entity.Club{}).Where("club_uid = ?", uid).UpdateColumn("touched_at", now).Error
}
`)).toEqual([
      "11 GORM: Scan clubs read",
      "17 GORM: Find players read",
      "24 GORM: UpdateColumn Club write",
    ]);
  });
});

describe("xorm in handlers, migrations and other session names", () => {
  it("reads a generic FindAndCount in a handler, a migration's engine, sess*/eng receivers and .Table(\"x\") (real-repo FP)", () => {
    expect(rows(`func Clubs(ctx *context.Context) {
	clubs, total, err := db.FindAndCount[club_model.Club](ctx, opts)
}`)).toEqual(["2 xorm: FindAndCount Club read"]);
    expect(rows(`func AddMatchIndex(x base.EngineMigration) error {
	count, err := x.Count(new(Match))
	return err
}`)).toEqual(["2 xorm: Count Match read"]);
    expect(rows(`import "xorm.io/xorm"
func search(ctx context.Context) {
	sessCount := db.GetEngine(ctx).Where(cond)
	count, err := sessCount.Count(new(Player))
	ids := make([]int64, 0, 10)
	err = db.GetEngine(ctx).Table("fixture").Cols("id").Where(cond).Find(&ids)
	_, err = eng.Insert(&LeagueState{ID: id})
}`)).toEqual(["4 xorm: Count Player read", "6 xorm: Find fixture read", "7 xorm: Insert LeagueState write"]);
  });
});

describe("a receiver declared as an xorm session", () => {
  it("reads its verbs whatever it is called (real-repo FP: 76 writes on `s *xorm.Session`)", () => {
    expect(rows(`import "xorm.io/xorm"
func (l *Label) Create(s *xorm.Session, a web.Auth) (err error) {
	_, err = s.Insert(l)
	exists, err := s.Get(&Label{ID: l.ID})
	return
}
func migrate(tx *xorm.Engine) error {
	_, err := tx.Insert(&clubTokens{})
	return err
}`)).toEqual(["3 xorm: Insert Label write", "4 xorm: Get Label read", "8 xorm: Insert clubTokens write"]);
  });
});

describe("xorm builder statements", () => {
  it("reads the table a builder statement names, over lines and through its conditions (real-repo FP)", () => {
    expect(rows(`package migrations

import (
	"xorm.io/builder"
	"xorm.io/xorm"
)

func dropOrphans(x *xorm.Engine) error {
	condDelete := func(colName string) builder.Cond {
		return builder.NotIn(colName, builder.Select("id").From("\`player\`"))
	}
	if _, err := x.Exec(builder.Delete(condDelete("uid")).From("squad_player")); err != nil {
		return err
	}
	_, err := x.Exec(builder.Update(builder.Eq{"is_captain": false}).
		Where(builder.Eq{"club_id": 3}).
		From("lineup"))
	_, err = x.Exec(builder.Insert(builder.Eq{"name": "kit"}).Into("kit_bag"))
	return err
}
`).filter((r) => r.includes("builder"))).toEqual([
      "10 xorm builder: Select player read",
      "12 xorm builder: Delete squad_player write",
      "15 xorm builder: Update lineup write",
      "18 xorm builder: Insert kit_bag write",
    ]);
  });
});
