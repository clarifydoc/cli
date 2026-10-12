import { describe, it, expect } from "vitest";
import { GoEntityExtractor } from "./entities.js";
import type { FileAnalysis } from "../../../types/analysis.js";

const entity = (name: string, orm: string, props: Array<[string, string]>): any => ({
  name, extends: null, implements: [], decorators: ["entity", orm], methods: [], isExported: true, line: 1, endLine: 9,
  properties: props.map(([n, t]) => ({ name: n, type: t, visibility: "public", isStatic: false, isReadonly: false })),
});
const file = (filePath: string, classes: any[]): FileAnalysis => ({ filePath, language: "go", classes, functions: [], entityRelations: [] } as unknown as FileAnalysis);

describe("Go entity relations across files", () => {
  it("derives associations from fields typed as entities declared elsewhere", () => {
    const issue = file("models/issues/issue.go", [entity("Issue", "xorm", [["ID", "int64"], ["RepoID", "int64"], ["Repo", "*repo_model.Repository"], ["Labels", "[]*Label"], ["Title", "string"]])]);
    const repo = file("models/repo/repo.go", [entity("Repository", "xorm", [["ID", "int64"]])]);
    const label = file("models/issues/label.go", [entity("Label", "xorm", [["ID", "int64"]])]);
    new GoEntityExtractor().reconcileProject([issue, repo, label]);
    expect(issue.entityRelations).toEqual([
      { fromEntity: "Issue", fromField: "Repo", toEntity: "Repository", cardinality: "many-to-one", foreignKey: "RepoID", orm: "xorm", confidence: "INFERRED" },
      { fromEntity: "Issue", fromField: "Labels", toEntity: "Label", cardinality: "one-to-many", orm: "xorm", confidence: "INFERRED" },
    ]);
  });

  it("derives many-to-one relations from integer <X>ID columns with no typed field", () => {
    const comment = file("models/issues/comment.go", [entity("Comment", "xorm", [
      ["ID", "int64"], ["IssueID", "int64"], ["BaseRepoID", "int64"], ["RepoUnitID", "int64"], ["CommitID", "string"], ["PosterID", "int64"],
    ])]);
    const issue = file("models/issues/issue.go", [entity("Issue", "xorm", [["ID", "int64"]])]);
    const repo = file("models/repo/repo.go", [entity("Repository", "xorm", [["ID", "int64"]]), entity("RepoUnit", "xorm", [["ID", "int64"]])]);
    new GoEntityExtractor().reconcileProject([comment, issue, repo]);
    expect(comment.entityRelations!.map((r) => [r.fromField, r.toEntity])).toEqual([
      ["IssueID", "Issue"],
      ["BaseRepoID", "Repository"],
      ["RepoUnitID", "RepoUnit"],
    ]);
  });

  it("prefers the package's own entity, never the referencing entity itself", () => {
    const step = file("models/actions/task_step.go", [entity("ActionTaskStep", "xorm", [["TaskID", "int64"]])]);
    const task = file("models/actions/task.go", [entity("ActionTask", "xorm", [["ID", "int64"]])]);
    const adminTask = file("models/admin/task.go", [entity("Task", "xorm", [["ID", "int64"]])]);
    const pi = file("models/project/issue.go", [entity("ProjectIssue", "xorm", [["IssueID", "int64"]])]);
    const issue = file("models/issues/issue.go", [entity("Issue", "xorm", [["ID", "int64"]])]);
    const follow = file("models/user/follow.go", [entity("Follow", "xorm", [["UserID", "int64"], ["FollowID", "int64"]])]);
    const user = file("models/user/user.go", [entity("User", "xorm", [["ID", "int64"]])]);
    const migration = file("models/migrations/v1.go", [{ ...entity("User", "xorm", [["SourceID", "int64"]]), decorators: [] }]);
    const auth = file("models/auth/source.go", [entity("Source", "xorm", [["ID", "int64"]])]);
    new GoEntityExtractor().reconcileProject([step, task, adminTask, pi, issue, follow, user, migration, auth]);
    expect(step.entityRelations!.map((r) => r.toEntity)).toEqual(["ActionTask"]);
    expect(pi.entityRelations!.map((r) => r.toEntity)).toEqual(["Issue"]);
    expect(follow.entityRelations!.map((r) => [r.fromField, r.toEntity])).toEqual([["UserID", "User"]]);
    expect(migration.entityRelations).toEqual([]);
  });
});
