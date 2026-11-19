import type { ProjectCommand, ProjectRootView } from "../../../types/language-plugin.js";

/** sbt compiles and tests the build; `sbt run` when the build names a main class or the Play plugin. */
export function scalaProjectCommands(root: ProjectRootView): ProjectCommand[] {
  if (!root.exists("build.sbt")) return [];
  const sbt = root.read("build.sbt")?.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "") ?? "";
  const out: ProjectCommand[] = [
    { kind: "build", command: "sbt compile", source: "build.sbt" },
    { kind: "test", command: "sbt test", source: "build.sbt" },
  ];
  if (/PlayScala|PlayJava|mainClass\s*(?::=|in)/.test(sbt)) out.push({ kind: "start", command: "sbt run", source: "build.sbt" });
  return out;
}
