import type { ProjectCommand, ProjectRootView } from "../../../types/language-plugin.js";

/** A Go module builds and tests every package under it. */
export function goProjectCommands(root: ProjectRootView): ProjectCommand[] {
  if (!root.entries.includes("go.mod")) return [];
  return [
    { kind: "build", command: "go build ./...", source: "go.mod" },
    { kind: "test", command: "go test ./...", source: "go.mod" },
  ];
}
