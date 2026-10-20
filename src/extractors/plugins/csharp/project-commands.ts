import type { ProjectCommand, ProjectRootView } from "../../../types/language-plugin.js";

/** The dotnet CLI on the solution or project at the root; `dotnet run` for a lone project. */
export function dotnetProjectCommands(root: ProjectRootView): ProjectCommand[] {
  const sln = root.entries.filter((e) => /\.slnx?$/i.test(e));
  const projects = root.entries.filter((e) => /\.(?:cs|fs|vb)proj$/i.test(e));
  const target = sln.length === 1 ? sln[0] : projects.length === 1 ? projects[0] : undefined;
  if (!target && !sln.length && !projects.length) return [];
  const arg = target && (sln.length + projects.length > 1) ? ` ${target}` : "";
  return [
    { kind: "build", command: `dotnet build${arg}`, source: target ?? "the project files" },
    { kind: "test", command: `dotnet test${arg}`, source: target ?? "the project files" },
    ...(projects.length === 1 && !sln.length ? [{ kind: "start" as const, command: "dotnet run", source: projects[0]! }] : []),
  ];
}
