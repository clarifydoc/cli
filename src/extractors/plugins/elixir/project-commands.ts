import type { ProjectCommand, ProjectRootView } from "../../../types/language-plugin.js";

/** Mix runs the project's tests; Phoenix's server when the project depends on it. */
export function elixirProjectCommands(root: ProjectRootView): ProjectCommand[] {
  const mix = root.read("mix.exs");
  if (mix === undefined) return [];
  const out: ProjectCommand[] = [{ kind: "test", command: "mix test", source: "mix.exs" }];
  if (/\{:phoenix\s*,/.test(mix)) out.push({ kind: "start", command: "mix phx.server", source: "mix.exs" });
  return out;
}
