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
    expect(rows(`package web\nfunc h(e echo.Context) error { return e.Get("user") }`)).toEqual([]);
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
});
