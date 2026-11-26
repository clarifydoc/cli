import type { ProjectCommand, ProjectRootView } from "../../../types/language-plugin.js";

/**
 * Mix runs the project's tests; Phoenix's server when the project depends on it. The test command is `mix test
 * file[:line]`; an umbrella app's tests under `apps/<app>/test/` run inside the app as `(cd apps/<app> && mix test
 * test/x_test.exs:12)`, one subshell per app (`apps/club` for `apps/club/test/club_test.exs`).
 */
export function elixirProjectCommands(root: ProjectRootView): ProjectCommand[] {
  const mix = root.read("mix.exs");
  if (mix === undefined) return [];
  const out: ProjectCommand[] = [{ kind: "test", command: "mix test", source: "mix.exs" }];
  if (/\{:phoenix\s*,/.test(mix)) out.push({ kind: "start", command: "mix phx.server", source: "mix.exs" });
  return out;
}
