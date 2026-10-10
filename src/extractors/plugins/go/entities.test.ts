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
});
